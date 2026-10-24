import type { SessionPodSettings } from "./config.js";
import { SELF_REPO } from "./config.js";
import { noteSessionMemoryCaptureFailed, recordSessionMemoryCapture, type SessionMemoryFiles } from "./db.js";
import type { K8sClient, K8sError, K8sObject } from "./k8s/api.js";
import { MEMORY_CAPTURE_WORKLOAD_KIND, buildMemoryCapturePod, workloadName } from "./k8s/workload.js";
import { closeAlertIssueIfResolved, ensureAlertIssue } from "./occurrence-tracking.js";
import { MEMORY_DUMP_VERSION } from "./session-pod/dump-memories.js";
import * as log from "./log.js";

// Reads an ended interactive session's Claude memory files off its HOME PVC into
// `session_memory_captures`, for claude-memory-backup to push to the
// `claude-memories` branch. A one-shot pod mounts the PVC read-only and prints the
// files as one JSON line (`session-pod/dump-memories.ts`), read back through the
// pod-log API. This module only writes the database; claude-memory-backup is the
// branch's single git writer.

const NAME = "claude-memory-backup";
/** Failed capture attempts after which an ended session's PVC may be deleted uncaptured. */
export const MAX_MEMORY_CAPTURE_ATTEMPTS = 3;
export const MEMORY_CAPTURE_ALERT_TITLE = "[claude-memory-backup] Session memory capture is failing";
/** How long the capture pod may take to schedule, start and finish. */
export const MEMORY_CAPTURE_TIMEOUT_MS = 180_000;
const MEMORY_CAPTURE_POLL_MS = 1_000;
/** Cap on the pod log read; the dump's content cap is 2 MiB, so JSON escaping fits within it. */
const MEMORY_CAPTURE_LOG_LIMIT_BYTES = 4 * 1024 * 1024;

export interface CaptureSessionMemoriesOptions {
  client: K8sClient;
  ns: string;
  settings: Pick<SessionPodSettings, "image" | "imagePullSecrets" | "nodeSelector">;
  id: string;
  /** The row's `ended_at` the capture belongs to; NULL for an open row being deleted. */
  endedAt: number | null;
  /** The session's HOME PVC. */
  homeClaimName: string;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
}

export type CaptureSessionMemoriesResult =
  | { ok: true; files: number; recorded: boolean }
  | { ok: false; error: string };

/** The dump's projects from the pod log's last non-empty line, or null when it is not a valid dump. */
export function parseMemoryDump(logText: string): SessionMemoryFiles | null {
  const line = logText.split("\n").map((l) => l.trim()).filter(Boolean).at(-1);
  if (!line) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const dump = parsed as { v?: unknown; projects?: unknown };
  if (dump.v !== MEMORY_DUMP_VERSION || !dump.projects || typeof dump.projects !== "object" || Array.isArray(dump.projects)) return null;
  const out: SessionMemoryFiles = {};
  for (const [slug, files] of Object.entries(dump.projects as Record<string, unknown>)) {
    if (!files || typeof files !== "object" || Array.isArray(files)) return null;
    const entries = Object.entries(files as Record<string, unknown>);
    if (entries.some(([name, content]) => typeof content !== "string" || !name.endsWith(".md") || name.includes("/") || name.startsWith("."))) return null;
    if (slug.includes("/") || slug.startsWith(".")) return null;
    out[slug] = Object.fromEntries(entries) as Record<string, string>;
  }
  return out;
}

const describe = (res: K8sError): string => res.message;

/**
 * One capture attempt for session `id`. Never throws: a failure counts one
 * attempt on the row, logs a warning and upserts the single
 * `MEMORY_CAPTURE_ALERT_TITLE` alert issue. The capture pod is always deleted
 * before this returns.
 */
export async function captureSessionMemories(opts: CaptureSessionMemoriesOptions): Promise<CaptureSessionMemoriesResult> {
  const { client, ns, id } = opts;
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const timeoutMs = opts.timeoutMs ?? MEMORY_CAPTURE_TIMEOUT_MS;
  const podName = workloadName(MEMORY_CAPTURE_WORKLOAD_KIND, id);

  let result: CaptureSessionMemoriesResult;
  try {
    const files = await readMemoriesViaPod();
    const recorded = await recordSessionMemoryCapture(id, opts.endedAt, files, now());
    const count = Object.values(files).reduce((n, f) => n + Object.keys(f).length, 0);
    if (recorded) log.info(`[${NAME}] Captured ${count} memory file(s) from session ${id}`);
    else log.info(`[${NAME}] Discarded the memory capture of session ${id}: it was resumed or deleted meanwhile`);
    result = { ok: true, files: count, recorded };
  } catch (err) {
    result = { ok: false, error: err instanceof Error ? err.message : String(err) };
  }

  if (result.ok) {
    try {
      await closeAlertIssueIfResolved({ repo: SELF_REPO, title: MEMORY_CAPTURE_ALERT_TITLE, logPrefix: NAME, reason: "session memory capture succeeded" });
    } catch (err) {
      log.debug(`[${NAME}] Failed to close the capture alert issue: ${err}`);
    }
    return result;
  }

  log.warn(`[${NAME}] Capturing memories of session ${id} failed: ${result.error}`);
  try {
    await noteSessionMemoryCaptureFailed(id, opts.endedAt);
  } catch (err) {
    log.warn(`[${NAME}] Failed to record the failed memory capture of session ${id}: ${err}`);
  }
  try {
    await ensureAlertIssue({
      repo: SELF_REPO,
      title: MEMORY_CAPTURE_ALERT_TITLE,
      body: [
        `Reading interactive sessions' Claude memory files off their storage (namespace \`${ns}\`) has been failing.`,
        `Latest error (session ${id}): ${result.error}`,
        "Each ended session gets 3 attempts; after that its storage is deleted uncaptured and its memories never reach the `claude-memories` branch.",
        "A 403 on `pods/log` means the `claws-session-backend` Role lacks `get pods/log`.",
      ].join("\n"),
      logPrefix: NAME,
    });
  } catch (err) {
    log.warn(`[${NAME}] Failed to file the capture alert issue: ${err}`);
  }
  return result;

  async function deletePod(): Promise<void> {
    const res = await client.delete("pods", ns, podName);
    if (!res.ok && res.kind !== "not-found") throw new Error(`deleting capture pod: ${describe(res)}`);
  }

  async function readMemoriesViaPod(): Promise<SessionMemoryFiles> {
    if (!opts.settings.image) throw new Error("CLAWS_SESSION_IMAGE is empty");
    // A pod left by an attempt cut short (e.g. a Claws restart) would 409 the create.
    await deletePod();
    try {
      const pod = buildMemoryCapturePod({
        id,
        namespace: ns,
        image: opts.settings.image,
        homeClaimName: opts.homeClaimName,
        imagePullSecrets: opts.settings.imagePullSecrets,
        nodeSelector: opts.settings.nodeSelector,
      });
      // Counted in polls rather than wall-clock time, so a stalled clock cannot spin this forever.
      let polls = Math.max(1, Math.ceil(timeoutMs / MEMORY_CAPTURE_POLL_MS));
      let created = await client.create("pods", ns, pod);
      // The deleted pod may still be terminating; wait it out within the same budget.
      while (!created.ok && created.kind === "conflict" && polls-- > 0) {
        await sleep(MEMORY_CAPTURE_POLL_MS);
        created = await client.create("pods", ns, pod);
      }
      if (!created.ok) throw new Error(`creating capture pod: ${describe(created)}`);

      let phase: string | undefined;
      for (;;) {
        const got = await client.get<K8sObject & { status?: { phase?: string } }>("pods", ns, podName);
        if (!got.ok) throw new Error(`reading capture pod: ${describe(got)}`);
        phase = got.value.status?.phase;
        if (phase === "Succeeded" || phase === "Failed") break;
        if (polls-- <= 0) throw new Error(`capture pod still ${phase ?? "unknown"} after ${Math.round(timeoutMs / 1000)}s`);
        await sleep(MEMORY_CAPTURE_POLL_MS);
      }
      if (phase === "Failed") throw new Error("capture pod failed");

      const logRes = await client.podLog(ns, podName, { container: MEMORY_CAPTURE_WORKLOAD_KIND, limitBytes: MEMORY_CAPTURE_LOG_LIMIT_BYTES });
      if (!logRes.ok) throw new Error(`reading capture pod log: ${describe(logRes)}`);
      const files = parseMemoryDump(logRes.value);
      if (!files) throw new Error("capture pod printed no valid memory dump");
      return files;
    } finally {
      try {
        await deletePod();
      } catch (err) {
        log.warn(`[${NAME}] Failed to delete memory capture pod ${podName}: ${err instanceof Error ? err.message : err}`);
      }
    }
  }
}
