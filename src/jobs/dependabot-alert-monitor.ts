import { LABELS, SELF_REPO, DEPENDABOT_AUTO_DISMISS_STALE, getIgnoredAdvisoriesForRepo } from "../config.js";
import type { Repo } from "../config.js";
import * as gh from "../github.js";
import type { DependabotAlert } from "../github.js";
import * as log from "../log.js";
import { reportError } from "../error-reporter.js";
import { ensureAlertIssue } from "../occurrence-tracking.js";
import * as smartSchedule from "../smart-schedule.js";

const NAME = "dependabot-alert-monitor";
const ISSUE_TITLE = "Alert: open Dependabot security alerts";
const PERMISSION_ISSUE_TITLE =
  "Alert: Claws GitHub App lacks Dependabot alerts read permission";
const FOOTER = "\n\n---\n*Automated by claws dependabot-alert-monitor*";
const DEFERRALS_PATH = ".claws/dependabot-deferrals.json";

const REMEDIATION_GUIDANCE = `## Remediation guidance (read before fixing)

Do NOT blanket-add a \`package.json\` \`overrides\` entry for every alert. The goal is a durable, low-maintenance fix, not silencing alerts. Follow this order per alert:

0. **Minimise dependencies first.** The most durable fix is fewer deps. Before patching, check whether the alerted package (or its direct parent) is still needed at all: an unused, redundant, or trivially-replaceable dependency should be removed rather than patched. Prefer direct deps with smaller/shallower transitive trees. Removing a dep eliminates its whole subtree of future alerts — this beats every override.
1. **Classify dev vs runtime.** Run \`npm ls <package>\` in the worktree to see who pulls it in. Dev/build-only tooling (eslint, babel, esbuild, test runners, bundlers) whose exploit path needs attacker-controlled input reaching CI has minimal runtime risk — prefer fixing by bumping the direct tool, not a permanent override.
2. **Prefer a direct-dependency bump.** If the alerted package — or a direct parent that pulls it in — can move to a version whose tree already resolves the patched version, bump that direct dep in \`dependencies\`/\`devDependencies\`. This is the durable fix; transitives update naturally. (Bumping a direct dep like \`dompurify\` directly, not via override, is the correct model.)
3. **Use \`overrides\` only as a fallback** for genuinely transitive deps with no reachable direct bump.
4. **In overrides, use \`>=\` or \`^\` ranges, NEVER exact pins.** An exact pin (e.g. \`"uuid": "11.1.1"\`) blocks npm from taking the next patch and re-triggers this same alert later. Write \`">=11.1.1"\` so fixes self-heal.
5. **Never force a major-version jump into a parent that declares a lower major** without verifying. Forcing e.g. \`uuid\` v8→v11 inside a package authored against v8 can break at runtime with no type error. If you cannot run a build + test exercising the affected path, LEAVE that alert open and note it for human review rather than risk a silent break.
6. **Annotate each override** in the PR body: the alert/GHSA link and the upstream version that will make the override removable, so stale entries can be pruned later.
7. **Verify before opening the PR:** run install (\`npm install\`), build, and test. If any forced version fails, revert that entry and flag the alert instead of shipping a broken pin.
8. **If an alert genuinely has no safe fix** (e.g. the only fix is a major-version bump that breaks the build, as rule 5 describes), do NOT open a no-op PR that only edits a notes file. Instead add the advisory's GHSA ID to \`.claws/dependabot-deferrals.json\` in this repo (create the file if absent), with a one-line \`reason\`. Claws reads this file and stops re-filing this alert, which closes this issue. Example:
   \`{ "deferrals": [ { "ghsa": "GHSA-xxxx-yyyy-zzzz", "reason": "fix requires major upgrade incompatible with current toolchain", "reviewAfter": "2026-09-27" } ] }\`
   Only defer alerts you have confirmed cannot be safely fixed; do not defer to silence fixable alerts.`;
const SEVERITY_ORDER = ["critical", "high", "medium", "low", "unknown"];

// Throttle the permission-remediation filing. The App permission is global, so
// every repo in a scan cycle would otherwise re-file/update the same SELF_REPO
// issue, inflating its occurrence count by N per cycle. File at most hourly.
const PERMISSION_THROTTLE_MS = 60 * 60 * 1000;
let lastPermissionFiledMs = 0;

/** Reset throttle state. Call from test afterEach only. */
export function resetThrottleForTest(): void {
  lastPermissionFiledMs = 0;
}

// Conservative numeric dotted comparison; any non-numeric segment → false (never triggers a dismissal).
export function versionAtLeast(have: string, want: string): boolean {
  const parse = (v: string): number[] | null => {
    const parts = v.split(".");
    const out: number[] = [];
    for (const p of parts) {
      if (!/^\d+$/.test(p)) return null; // e.g. "1.21.0rc1", "8.0.0-beta"
      out.push(Number(p));
    }
    return out;
  };
  const h = parse(have), w = parse(want);
  if (!h || !w) return false;
  const len = Math.max(h.length, w.length);
  for (let i = 0; i < len; i++) {
    const a = h[i] ?? 0, b = w[i] ?? 0;
    if (a > b) return true;
    if (a < b) return false;
  }
  return true;
}

// Leading dotted-numeric core only: "2.7.1-rc1" → "2.7.1", "1.21.0rc1" → "1.21.0", "2.12.0+cu124" → "2.12.0".
function versionCore(v: string): string {
  const m = /^\d+(?:\.\d+)*/.exec(v.trim());
  return m ? m[0] : "";
}

export function manifestSatisfiesPatch(pinned: string, patched: string): boolean {
  const have = versionCore(pinned), want = versionCore(patched);
  if (!have || !want) return false;
  return versionAtLeast(have, want);
}

export function parsePinnedRequirement(content: string, packageName: string): string | null {
  const norm = (s: string) => s.toLowerCase().replace(/[._]+/g, "-");
  const target = norm(packageName);
  for (const line of content.split("\n")) {
    const stripped = line.split("#")[0].trim();
    if (!stripped) continue;
    const m = /^([A-Za-z0-9._-]+)\s*(?:\[[^\]]*\])?\s*==\s*([^\s;,#]+)/.exec(stripped);
    if (m && norm(m[1]) === target) return m[2];
  }
  return null;
}

export function parseDeferredAdvisories(content: string | null): Set<string> {
  const out = new Set<string>();
  if (!content) return out;
  let data: unknown;
  try {
    data = JSON.parse(content);
  } catch {
    return out;
  }
  const add = (v: unknown) => {
    if (typeof v === "string" && v.trim()) out.add(v.trim().toLowerCase());
  };
  if (Array.isArray(data)) {
    for (const e of data) add(e);
  } else if (data && typeof data === "object" && Array.isArray((data as any).deferrals)) {
    for (const e of (data as any).deferrals) {
      if (e && typeof e === "object") add((e as any).ghsa ?? (e as any).ghsaId);
      else add(e);
    }
  }
  return out;
}

async function fetchDeferredAdvisories(repo: string): Promise<Set<string>> {
  let content: string | null;
  try {
    content = await gh.fetchRepoFileContent(repo, DEFERRALS_PATH);
  } catch (err) {
    log.warn(
      `[${NAME}] ${repo}: failed to read ${DEFERRALS_PATH} — skipping deferral suppression: ${String((err as Error)?.message ?? err)}`,
    );
    return new Set();
  }
  return parseDeferredAdvisories(content);
}

export function buildBody(repo: string, alerts: DependabotAlert[]): string {
  const sorted = [...alerts].sort(
    (a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity),
  );
  const bullets = sorted
    .map((a) => {
      const fix = a.patchedVersion
        ? ` — fix: upgrade to \`${a.patchedVersion}\``
        : " — no patched version yet";
      const adv = a.ghsaId ? ` ([${a.ghsaId}](${a.htmlUrl}))` : "";
      const where = a.manifestPath ? ` in \`${a.manifestPath}\`` : "";
      return `- **${a.packageName}** (${a.severity})${where}: ${a.summary}${adv}${fix}`;
    })
    .join("\n");
  return [
    `\`${repo}\` has **${alerts.length}** open Dependabot security alert(s).`,
    ``,
    `Review them at https://github.com/${repo}/security/dependabot`,
    ``,
    bullets,
    ``,
    REMEDIATION_GUIDANCE,
    FOOTER,
  ].join("\n");
}

async function filePermissionRemediationIssue(triggeringRepo: string): Promise<void> {
  const now = Date.now();
  if (now - lastPermissionFiledMs < PERMISSION_THROTTLE_MS) return;
  const body = [
    `The Claws GitHub App returned **403 "Resource not accessible by integration"** when`,
    `reading Dependabot alerts (first observed on \`${triggeringRepo}\`).`,
    ``,
    `\`dependabot-alert-monitor\` cannot read alerts for ANY repository until the App is`,
    `granted the **Dependabot alerts: Read** permission.`,
    ``,
    `**Remediation:** in the GitHub App settings, add the \`Dependabot alerts: Read\``,
    `repository permission and accept the permission update for the installation(s).`,
    FOOTER,
  ].join("\n");
  await ensureAlertIssue({
    repo: SELF_REPO,
    title: PERMISSION_ISSUE_TITLE,
    body,
    labels: [LABELS.priority],
    logPrefix: NAME,
  });
  lastPermissionFiledMs = now;
  log.warn(
    `[${NAME}] App lacks Dependabot alerts read permission — filed remediation issue on ${SELF_REPO}`,
  );
}

// Returns remaining live alerts. Logs and returns all alerts on SBOM error; never throws.
async function dismissStaleAlerts(
  repo: string,
  alerts: DependabotAlert[],
): Promise<DependabotAlert[]> {
  let sbom: gh.SbomPackage[];
  try {
    sbom = await gh.fetchRepoSbomPackages(repo);
  } catch (err) {
    log.warn(
      `[${NAME}] ${repo}: failed to fetch dependency graph SBOM — skipping stale dismissal: ${String((err as Error)?.message ?? err)}`,
    );
    return alerts;
  }

  const versionsByName = new Map<string, string[]>();
  for (const pkg of sbom) {
    const list = versionsByName.get(pkg.name);
    if (list) list.push(pkg.version);
    else versionsByName.set(pkg.name, [pkg.version]);
  }

  const dismissed = new Set<number>();
  for (const alert of alerts) {
    const patched = alert.patchedVersion;
    if (!patched) continue; // unfixable — keep open
    const resolved = versionsByName.get(alert.packageName.toLowerCase());
    if (!resolved) continue; // package absent from graph — keep open
    // Load-bearing: every resolved instance must be at or above the patch.
    if (!resolved.every((v) => versionAtLeast(v, patched))) continue;

    try {
      await gh.dismissDependabotAlert(
        repo,
        alert.number,
        "inaccurate",
        "Auto-dismissed by claws: the dependency graph resolves this package only at or above the patched version; the alert is stale pending GitHub re-scan.",
      );
      dismissed.add(alert.number);
      log.info(
        `[${NAME}] ${repo}: dismissed stale alert #${alert.number} (${alert.packageName})`,
      );
    } catch (err) {
      log.warn(
        `[${NAME}] ${repo}: failed to dismiss stale alert #${alert.number} (${alert.packageName}): ${String((err as Error)?.message ?? err)}`,
      );
    }
  }

  return alerts.filter((a) => !dismissed.has(a.number));
}

// Second staleness pass: dismiss alerts whose COMMITTED manifest already pins a
// satisfying version, even when the dependency-graph SBOM lags. Scoped to pip
// exact-pin manifests (the case the SBOM gets wrong); npm/etc. fall through unchanged.
async function dismissAlreadyPinnedAlerts(
  repo: string,
  alerts: DependabotAlert[],
): Promise<DependabotAlert[]> {
  const candidates = alerts.filter(
    (a) => a.ecosystem === "pip" && a.patchedVersion && a.manifestPath,
  );
  if (candidates.length === 0) return alerts;

  const contentByPath = new Map<string, string | null>();
  const dismissed = new Set<number>();
  for (const alert of candidates) {
    const path = alert.manifestPath!;
    if (!contentByPath.has(path)) {
      try {
        contentByPath.set(path, await gh.fetchRepoFileContent(repo, path));
      } catch (err) {
        log.warn(`[${NAME}] ${repo}: failed to read manifest ${path} — skipping pin check: ${String((err as Error)?.message ?? err)}`);
        contentByPath.set(path, null);
      }
    }
    const content = contentByPath.get(path);
    if (!content) continue;
    const pinned = parsePinnedRequirement(content, alert.packageName);
    if (!pinned || !manifestSatisfiesPatch(pinned, alert.patchedVersion!)) continue;
    try {
      await gh.dismissDependabotAlert(
        repo, alert.number, "inaccurate",
        `Auto-dismissed by claws: the committed manifest \`${path}\` pins \`${alert.packageName}\` at \`${pinned}\`, which satisfies the patched version \`${alert.patchedVersion}\`; the alert is stale pending GitHub re-scan.`,
      );
      dismissed.add(alert.number);
      log.info(`[${NAME}] ${repo}: dismissed pinned-but-stale alert #${alert.number} (${alert.packageName} pinned ${pinned} >= ${alert.patchedVersion})`);
    } catch (err) {
      log.warn(`[${NAME}] ${repo}: failed to dismiss alert #${alert.number} (${alert.packageName}): ${String((err as Error)?.message ?? err)}`);
    }
  }
  return alerts.filter((a) => !dismissed.has(a.number));
}

export async function processRepo(repo: Repo): Promise<void> {
  await smartSchedule.withDailyRepoMarking(
    NAME,
    repo.fullName,
    () => processRepoInner(repo),
  );
}

async function processRepoInner(repo: Repo): Promise<void> {
  let alerts: DependabotAlert[];
  try {
    alerts = await gh.listOpenDependabotAlerts(repo.fullName);
  } catch (err) {
    if (err instanceof gh.DependabotAlertsPermissionError) {
      try {
        await filePermissionRemediationIssue(repo.fullName);
      } catch (permErr) {
        reportError("dependabot-alert-monitor:permission-remediation", repo.fullName, permErr);
      }
      return;
    }
    reportError("dependabot-alert-monitor:list-alerts", repo.fullName, err);
    return;
  }

  try {
    if (alerts.length === 100) {
      log.warn(`[${NAME}] ${repo.fullName} returned 100 alerts (page cap) — more may exist`);
    }

    if (DEPENDABOT_AUTO_DISMISS_STALE && alerts.length > 0) {
      alerts = await dismissStaleAlerts(repo.fullName, alerts);
    }
    if (DEPENDABOT_AUTO_DISMISS_STALE && alerts.length > 0) {
      alerts = await dismissAlreadyPinnedAlerts(repo.fullName, alerts);
    }

    if (alerts.length > 0) {
      const ignored = getIgnoredAdvisoriesForRepo(repo.fullName);
      const deferred = await fetchDeferredAdvisories(repo.fullName);
      const suppress = new Set<string>([...ignored, ...deferred]);
      if (suppress.size > 0) {
        const before = alerts.length;
        alerts = alerts.filter((a) => !suppress.has(a.ghsaId.toLowerCase()));
        if (alerts.length < before) {
          log.info(
            `[${NAME}] ${repo.fullName}: suppressed ${before - alerts.length} acknowledged/deferred advisory alert(s) (config + ${DEFERRALS_PATH})`,
          );
        }
      }
    }

    if (alerts.length === 0) {
      const existing = await gh.findIssueByExactTitle(repo.fullName, ISSUE_TITLE);
      if (existing) {
        await gh.closeIssue(repo.fullName, existing.number, "completed");
        log.info(
          `[${NAME}] ${repo.fullName} has no open alerts — closed #${existing.number}`,
        );
      }
      return;
    }

    log.info(`[${NAME}] ${repo.fullName}: ${alerts.length} open alert(s) — filing/updating issue`);
    await ensureAlertIssue({
      repo: repo.fullName,
      title: ISSUE_TITLE,
      body: buildBody(repo.fullName, alerts),
      labels: [LABELS.priority],
      logPrefix: NAME,
    });
  } catch (err) {
    reportError("dependabot-alert-monitor:process-repo", repo.fullName, err);
  }
}
