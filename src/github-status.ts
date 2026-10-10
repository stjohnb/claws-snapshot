import { z } from "zod";
import * as log from "./log.js";
import { notify } from "./slack.js";

const STATUS_URL = "https://www.githubstatus.com/api/v2/summary.json";
const FETCH_TIMEOUT_MS = 10_000;
const STALE_MS = 15 * 60 * 1000; // a snapshot older than this can't gate suppression
const RECOVERY_GRACE_MS = 10 * 60 * 1000; // 403s linger after components flip back to operational
const COMPONENTS_WE_DEPEND_ON = new Set([
  "Git Operations",
  "API Requests",
  "Webhooks",
  "Issues",
  "Pull Requests",
  "Actions",
]);

const SummarySchema = z.object({
  status: z.object({ indicator: z.string(), description: z.string() }),
  components: z.array(z.object({ name: z.string(), status: z.string() })).default([]),
  incidents: z
    .array(
      z.object({
        name: z.string(),
        status: z.string(),
        impact: z.string(),
        shortlink: z.string().optional(),
      }),
    )
    .default([]),
});

export interface GitHubStatusSnapshot {
  indicator: string | null;
  description: string | null;
  degradedComponents: string[];
  incident: { name: string; status: string; impact: string; url: string | null } | null;
  checkedAt: string | null;
  lastError: string | null;
  degraded: boolean;
}

let state: GitHubStatusSnapshot = {
  indicator: null,
  description: null,
  degradedComponents: [],
  incident: null,
  checkedAt: null,
  lastError: null,
  degraded: false,
};
let lastDegradedAtMs: number | null = null;

export interface DegradedWindow {
  startedAt: string;
  endedAt: string | null;
}

const WINDOW_HISTORY_LIMIT = 20;
const degradedWindows: DegradedWindow[] = [];

export async function refreshGitHubStatus(): Promise<void> {
  try {
    const res = await fetch(STATUS_URL, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) {
      throw new Error(`githubstatus.com summary.json returned HTTP ${res.status}`);
    }
    const parsed = SummarySchema.parse(await res.json());

    const degradedComponents = parsed.components
      .filter((c) => COMPONENTS_WE_DEPEND_ON.has(c.name) && c.status !== "operational")
      .map((c) => `${c.name} (${c.status})`);
    const degraded = degradedComponents.length > 0;

    const activeIncident = parsed.incidents.find((i) => i.status !== "resolved") ?? null;

    const wasDegraded = state.degraded;

    state = {
      indicator: parsed.status.indicator,
      description: parsed.status.description,
      degradedComponents,
      incident: activeIncident
        ? {
            name: activeIncident.name,
            status: activeIncident.status,
            impact: activeIncident.impact,
            url: activeIncident.shortlink ?? null,
          }
        : null,
      checkedAt: new Date().toISOString(),
      lastError: null,
      degraded,
    };

    if (degraded) {
      lastDegradedAtMs = Date.now();
    }

    if (degraded && !wasDegraded) {
      degradedWindows.push({ startedAt: state.checkedAt!, endedAt: null });
      if (degradedWindows.length > WINDOW_HISTORY_LIMIT) degradedWindows.shift();
      const components = degradedComponents.join(", ");
      const link = state.incident?.url ?? "";
      notify(
        `[WARN] GitHub is reporting an incident — ${state.description ?? "degraded service"}. Affected: ${components}. ${link} Claws is suppressing GitHub API error alerts until it clears.`,
      );
    } else if (!degraded && wasDegraded) {
      // The recovery grace window is still incident time as far as the gates are
      // concerned, so the window closes where isGitHubDegraded() stops returning true.
      const open = degradedWindows[degradedWindows.length - 1];
      if (open && open.endedAt === null) {
        open.endedAt = new Date(Date.now() + RECOVERY_GRACE_MS).toISOString();
      }
      notify("[INFO] GitHub status is back to normal — resuming normal error reporting.");
    }
  } catch (err) {
    log.warn(`[github-status] Failed to refresh GitHub status: ${err}`);
    state = { ...state, lastError: String(err) };
  }
}

export function getGitHubStatusSnapshot(): GitHubStatusSnapshot {
  return { ...state };
}

export function isGitHubDegraded(): boolean {
  if (lastDegradedAtMs !== null && Date.now() - lastDegradedAtMs < RECOVERY_GRACE_MS) return true;
  if (!state.checkedAt) return false;
  if (Date.now() - Date.parse(state.checkedAt) > STALE_MS) return false;
  return state.degraded;
}

/**
 * Incident windows observed in the last `sinceMs` (default 24h), oldest first.
 * In-memory by design — a restart loses history, same trade-off as ci-fixer's
 * deadRerunIds. Never used to gate suppression, only to inform prompts.
 */
export function getRecentDegradedWindows(sinceMs = 24 * 60 * 60 * 1000): DegradedWindow[] {
  const cutoff = Date.now() - sinceMs;
  return degradedWindows.filter((w) => w.endedAt === null || Date.parse(w.endedAt) > cutoff);
}

/** Test-only: reset module state between test cases. */
export function __resetGitHubStatusForTests(): void {
  state = {
    indicator: null,
    description: null,
    degradedComponents: [],
    incident: null,
    checkedAt: null,
    lastError: null,
    degraded: false,
  };
  lastDegradedAtMs = null;
  degradedWindows.length = 0;
}
