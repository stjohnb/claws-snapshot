import type { IssueRef } from "./issue-id.js";
import { SELF_REPO, issueUrl } from "./config.js";
import { AgentTimeoutError, AgentMemoryLimitError, AgentExternalKillError, AgentCliError, PushConflictError, API_TRANSIENT_RE, USAGE_LIMIT_RE, UNSUPPORTED_MODEL_RE, AllProvidersRateLimitedError } from "./claude.js";
import * as gh from "./github.js";
import { isRateLimited, RateLimitError, TransientGitHubError } from "./github.js";
import * as log from "./log.js";
import { diagnosticContext, type DiagnosticContext } from "./diagnostic-queries.js";
import { isShuttingDown, ShutdownError } from "./shutdown.js";
import { WhisperRateLimitError } from "./transcribe.js";
import { ensureAlertIssue } from "./occurrence-tracking.js";
import { guardContent, makeGuardCtx } from "./prompt-guard.js";
import { isGitHubDegraded } from "./github-status.js";
import { isAgentAuthFailure, noteAgentAuthFailure, agentAuthFingerprint, reauthInstruction } from "./agent-auth-state.js";
import type { DownloadFailure } from "./images.js";

/** Errors raised by the forge access wrappers, matched on their fixed message prefixes:
 *  `gh <args> failed: …` (src/github.ts), `git <args> failed in <cwd>: …` (src/claude.ts:107)
 *  and `forgejo <METHOD> <path> failed: …` (src/forgejo.ts). */
function isGitHubCliError(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error);
  return (
    /^gh [\s\S]*? failed:/.test(msg) ||
    /^git [\s\S]*? failed in /.test(msg) ||
    /^forgejo [\s\S]*? failed:/.test(msg)
  );
}

/**
 * Thrown instead of rethrowing the original error when the caller has already
 * filed its own alert issue for the failure (e.g. `[some-job] …` alert issued
 * by the job itself). reportError() recognizes it and skips filing a second
 * `[claws-error]` issue for the same incident — see the early return below.
 */
export class AlertIssueFiledError extends Error {
  readonly title: string;

  constructor(title: string, cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = "AlertIssueFiledError";
    this.title = title;
  }
}

const OUTPUT_TOKEN_LIMIT_RE = /exceeded the \d+ output token maximum/i;
const COOLDOWN_MS = 30 * 60 * 1000; // 30 minutes
const lastReported = new Map<string, number>();

/**
 * ImapFlow signals a dropped/closed IMAP connection by setting `code` on a
 * plain Error (see imapflow lib/imap-flow.js `createNoConnectionError` and
 * `close`). Matched structurally so error-reporter takes no dependency on
 * imapflow. email-monitor is the only IMAP consumer, and its 5-minute poll
 * cadence is itself the retry — an unread message is not flagged `\Seen`
 * until it has been fully processed (#2383).
 */
const IMAP_DROP_CODES = new Set(["NoConnection", "ClosedAfterConnectTLS", "ClosedAfterConnectText"]);

function isImapConnectionDrop(error: unknown): boolean {
  return (
    error instanceof Error &&
    typeof (error as Error & { code?: unknown }).code === "string" &&
    IMAP_DROP_CODES.has((error as Error & { code: string }).code)
  );
}

/**
 * Drop cooldown entries that can no longer suppress anything. An entry older
 * than COOLDOWN_MS already fails the `now - lastTime < COOLDOWN_MS` check, so
 * removing it is behaviour-preserving; it just keeps the map bounded by the
 * number of distinct fingerprints seen in the last 30 minutes rather than by
 * the lifetime of the (long-running) service process.
 */
function sweepExpiredCooldowns(now: number): void {
  for (const [fp, ts] of lastReported) {
    if (now - ts >= COOLDOWN_MS) lastReported.delete(fp);
  }
}

/** Test-only: clear the cooldown map between test cases. */
export function __resetCooldownsForTests(): void {
  lastReported.clear();
}

/** Test-only: number of live cooldown entries. */
export function __cooldownSizeForTests(): number {
  return lastReported.size;
}

/** Report private error details separately from explicitly supplied public diagnostic identities. */
export async function reportError(
  fingerprint: string,
  context: string,
  error: unknown,
  publicContext?: DiagnosticContext,
): Promise<void> {
  if (!(error instanceof ShutdownError)) {
    log.warn("Operational failure", error instanceof AgentTimeoutError ? "agent_timeout"
      : error instanceof AgentMemoryLimitError ? "agent_memory_limit"
      : error instanceof RateLimitError || error instanceof AllProvidersRateLimitedError ? "rate_limited"
      : "operation_failed", diagnosticContext(publicContext));
  }
  if (error instanceof ShutdownError) {
    log.info(`[${fingerprint}] ${context}: ${error.message} (shutdown — not reported)`);
    return;
  }

  // RateLimitError is an expected transient condition handled by the circuit
  // breaker — downgrade to warn so individual per-repo failures don't spam Slack.
  if (error instanceof RateLimitError) {
    log.warn(`[${fingerprint}] ${context}: ${error}`);
    return;
  }

  // PushConflictError is a transient race — another actor pushed to the branch
  // while we were working. The task is recorded as failed in the DB so the
  // circuit breaker counts it, and the dispatcher will retry on the next cycle.
  if (error instanceof PushConflictError) {
    log.warn(`[${fingerprint}] ${context}: ${error.message} (push conflict — not reported)`);
    return;
  }

  // The caller already filed its own alert issue for this failure before
  // rethrowing (e.g. some-job). Filing a second [claws-error] issue
  // would just be a duplicate of the one the caller already raised.
  if (error instanceof AlertIssueFiledError) {
    log.warn(`[${fingerprint}] ${context}: ${error.message} (alert issue already filed — not reported)`);
    return;
  }

  // Every provider is inside its rate-limit cooldown, so no agent call was even
  // attempted. Expected and transient — the dispatcher retries next cycle and
  // the dashboard's provider panel shows the cooldown (#2590).
  if (error instanceof AllProvidersRateLimitedError) {
    log.warn(`[${fingerprint}] ${context}: ${error.message} (all providers rate-limited — not reported)`);
    return;
  }

  // A GitHub-side 5xx that outlived gh()'s retry window (3 retries over ~7s).
  // Self-healing — the task is marked failed in the DB so the circuit breaker
  // counts it, and the dispatcher retries next cycle. Warn only; no issue.
  if (error instanceof TransientGitHubError) {
    log.warn(`[${fingerprint}] ${context}: ${error.message} (transient GitHub API error — not reported)`);
    return;
  }

  // GitHub itself is mid-incident: its API returns 403 "Resource not accessible by
  // integration", 5xx, and assorted permission errors across every repo at once.
  // One [claws-error] issue + Slack line per repo per dispatcher tick is pure noise
  // for something no code change fixes (#2486). Warn only; the dashboard's GitHub
  // row and the one-shot Slack incident notice carry the signal.
  if (isGitHubCliError(error) && isGitHubDegraded()) {
    log.warn(`[${fingerprint}] ${context}: ${error} (GitHub incident in progress — not reported)`);
    return;
  }

  // WhisperRateLimitError is a transient OpenAI rate limit — suppress to warn.
  if (error instanceof WhisperRateLimitError) {
    log.warn(`[${fingerprint}] ${context}: ${error.message} (Whisper rate limit — not reported)`);
    return;
  }

  // A dropped IMAP connection (Gmail or the network closing the socket
  // mid-session) is self-healing: email-monitor reconnects on its next
  // 5-minute tick and the unread message is still unflagged, so nothing is
  // lost. Downgrade to warn; the failure is still surfaced on the dashboard
  // via getEmailStatus().lastError.
  if (isImapConnectionDrop(error)) {
    log.warn(`[${fingerprint}] ${context}: ${error} (IMAP connection dropped — not reported)`);
    return;
  }

  // CLI-level errors that match usage-limit messages are transient —
  // the Claude CLI ran out of credits. Downgrade to warn; no GitHub issue needed.
  if (error instanceof AgentCliError && USAGE_LIMIT_RE.test(error.message)) {
    log.warn(`[${fingerprint}] ${context}: ${error.message}`);
    return;
  }

  // Transient API 5xx errors (500, 502, 503, etc.) are self-healing —
  // the dispatcher will re-queue the task. Downgrade to warn; no GitHub issue needed.
  if (error instanceof AgentCliError && API_TRANSIENT_RE.test(error.message)) {
    log.warn(`[${fingerprint}] ${context}: ${error.message} (transient API error — not reported)`);
    return;
  }

  // Output token limit errors indicate CLAUDE_CODE_MAX_OUTPUT_TOKENS is not
  // configured. Downgrade to warn with a hint — no GitHub issue needed.
  if (error instanceof AgentCliError && OUTPUT_TOKEN_LIMIT_RE.test(error.message)) {
    log.warn(`[${fingerprint}] ${context}: ${error.message} (set CLAUDE_CODE_MAX_OUTPUT_TOKENS in ~/.claws/env to increase the limit — not reported)`);
    return;
  }

  // Classified before the 0-turn short-circuit below: `numTurns` is a
  // per-backend heuristic ("we never got a turn, so assume a flaky init"), but
  // an auth-failure message is authoritative about *why* there was no turn.
  // Codex and OpenCode both report a credential failure with no agent message
  // and therefore 0 turns, so checking numTurns first would downgrade a
  // permanent credential expiry to a "transient CLI init failure" warning
  // forever — no Slack alert and no [claws-error] issue, ever.
  const authExpired = error instanceof AgentCliError && isAgentAuthFailure(error);

  // Classified ahead of the numTurns===0 short-circuit for the same reason as
  // authExpired: a 400 for an unsupported model ID produces no agent message,
  // so "transient CLI init failure" would hide a permanent config fault forever
  // while every Use Codex item retried in a loop (#2694).
  const unsupportedModel = error instanceof AgentCliError && UNSUPPORTED_MODEL_RE.test(error.message);

  // Transient CLI init failures (0 turns) are already retried in runClaude().
  // If both attempts fail, it's transient — downgrade to warn, no GitHub issue.
  if (!authExpired && !unsupportedModel && error instanceof AgentCliError && error.numTurns === 0) {
    log.warn(`[${fingerprint}] ${context}: ${error.message} (transient CLI init failure — not reported)`);
    return;
  }

  // Memory-limit kills are handled by feeding the failure back to the originating
  // issue/PR (see reportMemoryLimitOnItem, called from the worker). The watchdog
  // already killed the process cleanly — no [claws-error] alert needed.
  if (error instanceof AgentMemoryLimitError) {
    log.warn(`[${fingerprint}] ${context}: ${error.message} (memory limit — reported on the source item, not escalated)`);
    return;
  }

  // An external kill is not Claws' doing: something outside the process — the
  // kernel OOM killer, kubelet, a node drain — took the CLI out from under the
  // watchdog. The failure is real and worth an issue, but the generic body says
  // only "killed externally by signal X", so the remediation section in the body
  // below names what an operator actually has to look at.
  // No SIGTERM grace is needed here: claude.ts already waits
  // EXTERNAL_SIGTERM_SHUTDOWN_GRACE_MS and re-checks isShuttingDown() *before*
  // deciding between ShutdownError and AgentExternalKillError, so an
  // AgentExternalKillError that reaches this point has already outlived the
  // shutdown race — and the task outcome and work-queue row agree with it.
  const externalKill = error instanceof AgentExternalKillError;

  // Agent-CLI credential expiry is global, not per-task: every queued item
  // routed to that provider fails identically until a human re-authenticates.
  // Alert once per episode (plus an hourly nag) under one stable fingerprint
  // instead of once per task per job kind (#2538).
  //
  // The latch is keyed by `error.provider`: AGENT_AUTH_FAILURE_RE is
  // deliberately broad (it matches `authentication_error`, Anthropic's own API
  // error-type string), so a codex/opencode credential failure must not set the
  // claude latch and point the operator at a claude re-auth, which cannot fix it.
  let reportFingerprint = fingerprint;
  const authProvider = authExpired ? error.provider ?? "claude" : "claude";
  if (authExpired) {
    if (!noteAgentAuthFailure(`[${fingerprint}] ${context}`, undefined, authProvider)) {
      log.warn(`[${fingerprint}] ${context}: ${error} (${authProvider} CLI auth expired — already alerted)`);
      return;
    }
    reportFingerprint = agentAuthFingerprint(authProvider);
    log.error(
      `[${reportFingerprint}] The ${authProvider} CLI's credentials have expired — every ${authProvider} task will keep failing until you re-authenticate: ${reauthInstruction(authProvider)}. First failure: [${fingerprint}] ${context}: ${error}`,
    );
  } else if (unsupportedModel) {
    reportFingerprint = `agent-model-unsupported-${error instanceof AgentCliError ? error.provider ?? "codex" : "codex"}`;
    log.error(`[${reportFingerprint}] ${context}: ${error}`);
  } else {
    log.error(`[${fingerprint}] ${context}: ${error}`);
  }

  if (isShuttingDown()) return;

  if (isRateLimited()) {
    log.warn(`[error-reporter] Skipping report for "${reportFingerprint}" — rate-limited`);
    return;
  }

  const now = Date.now();
  sweepExpiredCooldowns(now);
  // noteAgentAuthFailure() above already gates cadence for the auth latch
  // (once per episode, plus an hourly nag) — a stale cooldown entry from a
  // prior episode must not suppress the issue update for a fresh one.
  if (authExpired) {
    lastReported.delete(reportFingerprint);
  }
  const lastTime = lastReported.get(reportFingerprint);
  if (lastTime && now - lastTime < COOLDOWN_MS) {
    log.warn(`[error-reporter] Skipping duplicate report for "${reportFingerprint}" (cooldown)`);
    return;
  }
  lastReported.set(reportFingerprint, now);

  try {
    const title = `[claws-error] ${reportFingerprint}`;
    const errorStr =
      error instanceof Error
        ? error.stack ?? error.message
        : typeof error === "object" && error !== null
          ? JSON.stringify(error, null, 2).slice(0, 5000)
          : String(error);
    const timestamp = new Date().toISOString();

    const diagnostics =
      error instanceof AgentTimeoutError
        ? [
            "",
            "**Diagnostics:**",
            `- Working directory: \`${error.cwd}\``,
            `- Total stdout: ${error.outputBytes} bytes`,
            `- The process ${error.outputBytes === 0 ? "produced no output (likely stuck or waiting for input)" : "was actively producing output"}`,
            "",
            error.lastOutput
              ? `<details><summary>Last stdout (up to 3000 chars)</summary>\n\n\`\`\`\n${error.lastOutput}\n\`\`\`\n</details>`
              : "",
            error.lastStderr
              ? `<details><summary>Last stderr (up to 1000 chars)</summary>\n\n\`\`\`\n${error.lastStderr}\n\`\`\`\n</details>`
              : "",
          ]
            .filter(Boolean)
            .join("\n")
        : "";

    const body = [
      `**Auto-created by Claws error reporter**`,
      "",
      `**Fingerprint:** \`${reportFingerprint}\``,
      `**Context:** ${context}`,
      `**Timestamp:** ${timestamp}`,
      "",
      "```",
      errorStr,
      "```",
      diagnostics,
      authExpired
        ? `\nThis is a host-level credential problem, not a code defect. Re-authenticate the ${authProvider} CLI: ${reauthInstruction(authProvider)}; the alert clears automatically on the next successful ${authProvider} run.`
        : "",
      externalKill ? externalKillRemediation(error) : "",
      unsupportedModel
        ? `\nThis is a host configuration problem, not a code defect. The agent CLI's account rejected the model ID Claws asked for. Claws validates pinned Codex model IDs against \`codex debug models\` when available, repairs stale aliases onto the shipped Codex family, falls back to the Codex CLI default for hidden IDs, and uses provider fallback when allowed. The shipped Codex defaults are \`gpt-5.5\`, \`gpt-5.6-terra\`, and \`gpt-5.6-luna\`; clear or change \`codexDefaultModel\` / \`codexLightModel\` / \`codexCheapModel\` in \`~/.claws/config.json\` or on the dashboard config page if this account does not support one of them.`
        : "",
    ]
      .filter(Boolean)
      .join("\n");
    await ensureAlertIssue({
      repo: SELF_REPO,
      title,
      body,
      timestamp,
      logPrefix: "error-reporter",
    });
  } catch (reportErr) {
    log.warn(`[error-reporter] Failed to report error for "${reportFingerprint}": ${reportErr}`);
  }
}

/** Operator-facing remediation for a kill Claws did not perform. The watchdog
 *  reports its own kills via reportMemoryLimitOnItem() and says so explicitly,
 *  so the first job here is to rule that out. */
function externalKillRemediation(error: AgentExternalKillError): string {
  const mib = (bytes: number) => `${Math.round(bytes / 1048576)} MiB`;
  // The run's own admission numbers are the single most useful fact for a
  // SIGKILL: they say what Claws believed the container could hold at the
  // moment the kernel disagreed.
  const policy = error.containerLimitBytes === null && error.sharedBudgetBytes === null
    ? []
    : [
        "",
        "The memory policy this run was admitted under:",
        "",
        `- container limit: ${error.containerLimitBytes === null ? "unknown (no cgroup limit visible)" : mib(error.containerLimitBytes)}`,
        `- shared admission budget: ${error.sharedBudgetBytes === null ? "not derived (admission inactive)" : mib(error.sharedBudgetBytes)}`,
        `- headroom withheld for the service: ${error.headroomBytes === null ? "unknown" : mib(error.headroomBytes)}`,
        `- reserved by this run: ${error.reservedBytes === null ? "nothing (admission inactive)" : mib(error.reservedBytes)}`,
      ];
  return [
    "",
    `This was **not** a Claws watchdog kill. The CLI process tree was terminated by signal \`${error.signal}\` from outside Claws. A \`SIGKILL\` here is exactly what a Kubernetes or kernel OOMKill looks like from inside the pod; a \`SIGTERM\` is a deliberate stop (node drain, rollout, \`systemctl restart\`) that raced Claws' own shutdown.`,
    ...policy,
    "",
    "Check, for the Claws workload:",
    "",
    "- `kubectl describe pod <claws-pod>` — the previous container's `Last State` / `Reason: OOMKilled`, and the container's restart count",
    "- `kubectl get events --field-selector involvedObject.name=<claws-pod>` — `OOMKilling` or `Evicted` events around the timestamp above",
    "- the container's `resources.limits.memory` against `agentWorkerMemorySharedBudgetBytes` and `agentWorkerMemoryHeadroomBytes` — if the shared admission budget plus the service's own footprint exceeds the pod limit, the kernel keeps winning before the watchdog can act, and the headroom needs raising or the budget lowering",
  ].join("\n");
}

export async function reportFailedAttachments(args: {
  sourceRepo: string;
  sourceIssueNumber: IssueRef;
  failures: DownloadFailure[];
  agentName?: string;
}): Promise<void> {
  if (args.failures.length === 0) return;

  if (isShuttingDown()) return;

  if (isRateLimited()) {
    log.warn(`[error-reporter] Skipping reportFailedAttachments — rate-limited`);
    return;
  }

  const fingerprint = `attachment-download-failures:${args.sourceRepo}:${args.sourceIssueNumber}`;
  const now = Date.now();
  sweepExpiredCooldowns(now);
  const lastTime = lastReported.get(fingerprint);
  if (lastTime && now - lastTime < COOLDOWN_MS) {
    log.warn(`[error-reporter] Skipping duplicate report for "${fingerprint}" (cooldown)`);
    return;
  }
  lastReported.set(fingerprint, now);

  const title = `[claws-error] Attachment download failures`;
  const sourceLink = issueUrl(args.sourceRepo, args.sourceIssueNumber);
  const agentName = args.agentName ?? "(unknown)";
  const timestamp = new Date().toISOString();
  // urls wrapped in backticks so extractImageUrls/extractAttachmentUrls don't re-match them
  const guardCtx = makeGuardCtx(args.sourceRepo, args.sourceIssueNumber);
  const urlList = args.failures
    .map((failure) => {
      const url = guardContent(failure.url, guardCtx("failed-download-url"));
      const reason = guardContent(failure.reason, guardCtx("failed-download-reason"));
      return `- \`${url}\` — ${reason}`;
    })
    .join("\n");

  try {
    const body = [
      `**Auto-created by Claws error reporter**`,
      "",
      `**Fingerprint:** \`${fingerprint}\``,
      `**Source:** ${sourceLink}`,
      `**Agent:** ${agentName}`,
      `**Timestamp:** ${timestamp}`,
      "",
      `Could not download the following file(s) referenced in the issue/comments:`,
      "",
      urlList,
    ].join("\n");
    await ensureAlertIssue({
      repo: SELF_REPO,
      title,
      body,
      timestamp,
      logPrefix: "error-reporter",
    });
  } catch (reportErr) {
    log.warn(`[error-reporter] Failed to report failed attachments: ${reportErr}`);
  }
}

export async function reportMemoryLimitOnItem(
  repo: string,
  itemNumber: IssueRef,
  error: AgentMemoryLimitError,
  count: number,
  skipped: boolean,
): Promise<void> {
  const fingerprint = `memory-limit:${repo}#${itemNumber}`;
  const now = Date.now();
  sweepExpiredCooldowns(now);
  const lastTime = lastReported.get(fingerprint);
  // Always post the skip comment; only dedup the interim "retrying" comments.
  if (!skipped && lastTime && now - lastTime < COOLDOWN_MS) {
    log.warn(`[error-reporter] Skipping duplicate memory-limit comment for "${fingerprint}" (cooldown)`);
    return;
  }
  lastReported.set(fingerprint, now);

  const observed = Math.round(error.observedRssBytes / 1048576);
  const limit = Math.round(error.limitBytes / 1048576);
  const sharedBudget = error.sharedBudgetBytes === null ? "unknown" : `${Math.round(error.sharedBudgetBytes / 1048576)} MiB`;
  const containerLimit = error.containerLimitBytes === null ? "unknown" : `${Math.round(error.containerLimitBytes / 1048576)} MiB`;
  const headroom = `${Math.round(error.headroomBytes / 1048576)} MiB`;
  const parts = [
    `### Memory limit reached`,
    "",
    `Claws' application watchdog stopped the CLI process tree for this item after it exceeded the effective agent memory cap ` +
      `(${observed} MiB observed > ${limit} MiB cap). This was a Claws watchdog termination, not proof of a Kubernetes OOMKill.`,
    "",
  ];
  // Off-container there is no cgroup limit and admission is disabled, so the
  // headroom is a default that reserves nothing — printing it would claim a
  // budget that does not exist.
  if (error.containerLimitBytes !== null || error.sharedBudgetBytes !== null) {
    parts.push(
      `Memory budget at the time of the run: shared headless-agent budget ${sharedBudget}; container limit ${containerLimit}; reserved service headroom ${headroom}.`,
      "",
    );
  }
  if (skipped) {
    parts.push(
      `This item has hit the same memory cap ${count} times in a row and has been ` +
        `temporarily removed from the Claws queue to stop it retrying indefinitely. ` +
        `Use the dashboard to re-queue it once the cause is addressed. Remedies include splitting the task, setting a per-call override for this class of job, adjusting ` +
        `CLAWS_AGENT_WORKER_MEMORY_MAX_BYTES, or raising Kubernetes/VM budgets only after measuring aggregate cluster pressure.`,
    );
  } else if (error.outputBytes === 0) {
    parts.push(
      `The process was killed during startup before producing any output. ` +
        `If this repeats at the same cap, the item will be removed from the queue after ${3} consecutive memory-limit kills.`,
    );
  } else {
    parts.push(
      `Consider reducing the scope of this task, using a targeted per-call override, or changing the neutral agent memory settings after checking aggregate pod, k3s, and Proxmox headroom.`,
    );
  }
  await gh.commentOnIssue(repo, itemNumber, parts.join("\n"));
}

export async function reportTimeoutOnItem(
  repo: string,
  itemNumber: IssueRef,
  timeoutCount: number,
  error: AgentTimeoutError,
  skipped: boolean,
  newTimeoutMs: number | null,
): Promise<void> {
  const parts = [
    `### CLI Timeout`,
    "",
    `The CLI process timed out while working on this item (${timeoutCount} timeout${timeoutCount > 1 ? "s" : ""} in the last 2 hours).`,
    "",
    error.outputBytes > 0
      ? "The process was actively producing output when the timeout was reached — this item may need a longer timeout or a simpler breakdown."
      : "The process produced no output — this may be a transient issue.",
  ];
  if (newTimeoutMs && !skipped) {
    parts.push("", `The timeout for this item has been increased to ${Math.round(newTimeoutMs / 60_000)} minutes for the next attempt.`);
  }
  if (skipped) {
    parts.push("", "This item has been temporarily removed from the Claws queue to prevent repeated blocking. Use the dashboard to re-queue it when ready.");
  }
  await gh.commentOnIssue(repo, itemNumber, parts.join("\n"));
}
