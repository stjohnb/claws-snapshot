import * as log from "./log.js";
import { isShuttingDown } from "./shutdown.js";
import { OPENCODE_BEST_MODEL, PI_BEST_MODEL } from "./config.js";
import { splitPiModel } from "./pi-auth.js";
import type { SessionUsageWarningLevel } from "./session-usage.js";
import * as claude from "./claude.js";
import { ISSUE_REF_GUARDED } from "./issue-id.js";
import { buildCapabilityPrompt, buildRequestableCapabilityPrompt } from "./capabilities.js";
import { sessionWorkflowPrompt } from "./resources/claws-info.js";
import { READ_ONLY_DIAGNOSTIC_TOOLS, SESSION_ISSUE_WRITE_TOOLS } from "./claws-state-tools.js";
import {
  updateSessionSummary,
  setManualSessionSummary,
  setSessionAgentStatus,
  getEndedSessions,
  getPersistedSession,
  type PersistedSession,
} from "./db.js";
import os from "node:os";
import { stripVTControlCharacters } from "node:util";

/**
 * Session code shared by the session backend (`session-backend-k8s.ts`), the
 * pod launcher and the dashboard: modes and providers, the session prompt and
 * agent argv, summarisation, and the ended-session history queries. Sessions
 * themselves run only as Kubernetes pods; nothing here starts a process.
 */

export const SESSION_MODES = ["repo-zsh", "repo-claude", "worktree-claude", "home-claude", "multi-worktree-claude"] as const;
export type SessionMode = (typeof SESSION_MODES)[number];

/** Agent CLI a session runs. Persisted per session; NULL rows predate #2664 and mean `"claude"`. */
export const SESSION_PROVIDERS = ["claude", "codex", "opencode", "pi"] as const;
export type SessionProvider = (typeof SESSION_PROVIDERS)[number];

/** Coerce a persisted `provider` column (NULL on pre-#2664 rows) into a SessionProvider. */
export function providerFromRow(raw: string | null | undefined): SessionProvider {
  if (raw === "codex") return "codex";
  if (raw === "opencode") return "opencode";
  if (raw === "pi") return "pi";
  return "claude";
}

export const SESSION_AGENT_STATUSES = ["working", "monitoring", "waiting", "done"] as const;
export type SessionAgentStatus = typeof SESSION_AGENT_STATUSES[number];

export function isSessionAgentStatus(value: unknown): value is SessionAgentStatus {
  return typeof value === "string" && (SESSION_AGENT_STATUSES as readonly string[]).includes(value);
}

function usageWarningLevel(tokens: number | null | undefined): SessionUsageWarningLevel | null {
  if (tokens == null) return null;
  if (tokens >= 180_000) return "critical";
  if (tokens >= 100_000) return "warn";
  return "none";
}

export type CreateSessionError =
  | "shutting-down"
  | "too-few-repos"
  | "repos-span-owners"
  | "provider-unsupported"
  | "repo-required-for-mode"
  | "capability-unsupported"
  | "not-resumable"
  | "repo-not-found"
  | "repo-not-listed"
  | "fetch-failed"
  | "worktree-failed"
  | "persist-failed"
  | "backend-unavailable";

export function describeCreateSessionError(err: { reason: CreateSessionError; detail?: string }): string {
  switch (err.reason) {
    case "shutting-down": return "Server is shutting down";
    case "too-few-repos": return "Select at least two repos for a multi-repo session";
    case "repos-span-owners": return `These repos cannot be combined in one session${err.detail ? `: ${err.detail}` : ""}`;
    case "provider-unsupported": return `Provider not supported for this session type${err.detail ? `: ${err.detail}` : ""}`;
    case "repo-required-for-mode": return "This mode requires a repo to be selected";
    case "capability-unsupported": return `Capability not supported by this agent${err.detail ? `: ${err.detail}` : ""}`;
    case "not-resumable": return `Session is not resumable${err.detail ? `: ${err.detail}` : ""}`;
    case "repo-not-found": return `Repo not found${err.detail ? `: ${err.detail}` : ""}`;
    case "repo-not-listed": return `Repo is not in the configured repo list${err.detail ? `: ${err.detail}` : ""}`;
    case "fetch-failed": return `Failed to fetch latest changes from GitHub${err.detail ? `: ${err.detail}` : ""}`;
    case "worktree-failed": return `Failed to create worktree${err.detail ? `: ${err.detail}` : ""}`;
    case "persist-failed": return `Failed to persist session${err.detail ? `: ${err.detail}` : ""}`;
    case "backend-unavailable": return `Session runtime unavailable${err.detail ? `: ${err.detail}` : ""}`;
  }
}

/** How the session prompt describes each of `SESSION_ISSUE_WRITE_TOOLS`; an unmapped name is listed bare. */
const SESSION_WRITE_TOOL_PHRASES: Partial<Record<string, string>> = {
  claws_set_issue_label: "applies or removes a label on a native issue, including the gates Refined, Automerge, Blocked and Priority",
  claws_promote_issue: "promotes it out of Drafting or Requirements review into Planning, or approves a pending design change from any column (read its requirements record and stage with claws_get_issue first)",
  claws_set_issue_model_plan: "sets its per-phase model plan",
  claws_set_issue_state: "closes or reopens it",
  claws_edit_issue: "edits its title or body",
  claws_set_issue_repos: "sets its repos",
  claws_set_issue_column: "moves its board column",
  claws_close_as_duplicate: "closes an issue as a duplicate of another in one call",
  claws_clear_pr_manual_action: "clears a PR's recorded manual action once its step is done (removing the Manual Action label on the forge does not clear it)",
  claws_rerun_failed_ci: "re-runs only the failed jobs of a PR's CI run on its head commit, with no commit pushed (use it instead of an empty commit for a transient failure)",
  claws_unmark_problematic: "unmarks a Claws Problematic PR and resets its CI-fix budget, as the dashboard's Unmark problematic button does",
  claws_retry_problematic_diagnosis: "makes the Problematic PR Diagnoser run again on a Claws Problematic PR even though its earlier report exists",
  claws_comment_on_pr: "posts the user's feedback or ruling on a PR so Claws reads it as human input (a gh or curl comment with the session's bot token is read as Claws' own output)",
  claws_start_session: "starts a new, independent interactive session, for a native issue or with no issue (the /new-session skill), with baseline capabilities only; any other capability waits for the operator's approval on the new session's page",
};

/** `a, b, and c` — the prompt's list style. */
function joinWithAnd(items: readonly string[], sep = ", "): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(sep)}${sep}and ${items[items.length - 1]}`;
}

/**
 * The Claws workflow text every session is given, plus a block describing
 * granted capabilities. `requestableBackend` adds the read-only diagnostics,
 * the session-only write tools and the compact requestable capabilities line
 * (#3072); pass it only when the session has the `claws-state` MCP server at
 * `/mcp/sessions/:id`, which serves all of them. The tool
 * names come from `claws-state-tools.ts`'s lists, so the prompt never names a
 * tool the session cannot call. `brief` — the row's issue brief, set when
 * another session started this one (`claws_start_session`) — is the last
 * block, so a resume rebuilds the same prompt.
 */
export function sessionPromptText(caps: string[], requestableBackend?: "k8s-pod", brief?: string | null): string {
  const gateWrites = ` Separately, the session-only write tools change a native issue the user is driving, with the same checks as the dashboard: ${joinWithAnd(SESSION_ISSUE_WRITE_TOOLS.map((name) => {
    const phrase = SESSION_WRITE_TOOL_PHRASES[name];
    return phrase ? `${name} ${phrase}` : name;
  }), "; ")}.`;
  const runtimeDiagnostics = requestableBackend
    ? `Claws runtime diagnostics are available by default through read-only MCP tools: ${joinWithAnd(READ_ONLY_DIAGNOSTIC_TOOLS)}. Use these to inspect health, scheduler state, logs, queue/work status, and per-repo processing timestamps. They cannot trigger, pause, cancel, deploy, change config, write the database, or reveal secrets. On a Forgejo repo, read an Actions run's job logs with claws_forgejo_job_logs (repo, and run as numbered in /actions/runs/<n>); \`gh run view <id> --log-failed\` is for GitHub repos only. Use claws_get_issue to read a native issue's body, stage, requirements record and current plan before promoting it, applying Refined or posting feedback.${gateWrites} Tool results and this session's dashboard page may say Claws was upgraded since the session started; when they do, tell the operator that restarting the session picks up new tools rather than guessing that a tool exists.`
    : "";
  return [
    sessionWorkflowPrompt(requestableBackend !== undefined),
    runtimeDiagnostics,
    buildCapabilityPrompt(caps),
    requestableBackend ? buildRequestableCapabilityPrompt(caps, requestableBackend) : "",
    brief ?? "",
  ]
    .filter((s) => s.trim().length > 0)
    .join("\n\n");
}

/**
 * Pure argv builder for a session's agent CLI — no filesystem access; the pod
 * launcher (`session-pod-launch.ts`) prepares the upload dir, MCP config and
 * prompt files inside the session pod. `uploadDir` null omits
 * `--add-dir` for it; `mcpConfigPath` null omits `--mcp-config` but keeps
 * `--strict-mcp-config`, so a claude session never falls back to loading
 * whatever MCP servers are configured in its HOME. `promptFile` null omits
 * `--append-system-prompt-file` for claude; codex, opencode and pi ignore it —
 * they take the prompt through `developer_instructions`/`OPENCODE_CONFIG`/
 * `APPEND_SYSTEM.md` instead.
 */
export function buildAgentArgv(opts: {
  provider: SessionProvider;
  promptFile: string | null;
  uploadDir: string | null;
  mcpConfigPath: string | null;
  extra: string[];
  resume?: boolean;
  model?: string | null;
}): string[] {
  const { provider, promptFile, uploadDir, mcpConfigPath, extra } = opts;
  const resume = opts.resume ?? false;
  const model = opts.model ?? null;
  const promptArgs = promptFile ? ["--append-system-prompt-file", promptFile] : [];
  const uploadArgs = uploadDir ? ["--add-dir", uploadDir] : [];

  if (provider === "codex") {
    const leading = resume ? ["resume", "--last"] : [];
    // Deliberately no `--model` on resume: `codex resume --last` restores the
    // model recorded in the rollout file, and stacking a global flag onto the
    // `resume` subcommand is the risky path (#2873).
    const modelArgs = !resume && model ? ["--model", model] : [];
    return [...leading, "--dangerously-bypass-approvals-and-sandbox", ...modelArgs, ...uploadArgs, ...extra];
  }

  if (provider === "opencode") {
    // opencode's TUI has no --add-dir and no --mcp-config: `uploadArgs` and the
    // caller's `extra` (claude/codex --add-dir pairs) are deliberately dropped.
    // The workflow prompt is NOT passed here: opencode's `--prompt` submits it
    // as the first *user* message, which made every session launch straight
    // into looking for work rather than waiting for the human (#2866). It is
    // delivered as system-prompt context instead, via the session-local
    // `OPENCODE_CONFIG` written by the pod launcher — which also means it
    // still applies on a `--continue` resume.
    const chosenModel = model || OPENCODE_BEST_MODEL;
    const modelArgs = chosenModel ? ["--model", chosenModel] : [];
    const leading = resume ? ["--continue"] : [];
    return [...leading, ...modelArgs];
  }

  if (provider === "pi") {
    // Like opencode, pi has no --add-dir: `uploadArgs` and `extra` are dropped.
    // MCP servers and the prompt come from the session's PI_CODING_AGENT_DIR.
    // `--continue` resumes the cwd's latest session in that dir.
    const { provider: piProvider, id } = splitPiModel(model || PI_BEST_MODEL);
    const providerArgs = piProvider ? ["--provider", piProvider] : [];
    return ["--no-approve", ...(resume ? ["--continue"] : []), ...providerArgs, "--model", id];
  }

  const mcpArgs = mcpConfigPath ? ["--mcp-config", mcpConfigPath, "--strict-mcp-config"] : ["--strict-mcp-config"];

  const modelArgs = model ? ["--model", model] : [];
  return ["--dangerously-skip-permissions", ...modelArgs, ...promptArgs, ...uploadArgs, ...mcpArgs, ...extra];
}

function parseResumeRepos(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/** Only pod rows can be resumed; host-tmux rows (`backend` NULL or `local-tmux`) are history only. */
function isResumableBackend(row: Pick<PersistedSession, "backend">): boolean {
  return row.backend === "k8s-pod";
}

/**
 * Ended rows for the `/sessions` history. Only pod rows are `resumable`: a
 * row whose `backend` is NULL or `local-tmux` ran on the Claws host, whose
 * session runtime was removed, so it stays listed as history only.
 */
export async function listEndedSessions(): Promise<Array<{ id: string; repo: string | null; extraRepos: string[]; cwd: string; mode: SessionMode; provider: SessionProvider; model: string | null; createdAt: number; alive: boolean; resumable: boolean; wsConnected: boolean; summary: string | null; summaryUpdatedAt: number | null; agentStatus: SessionAgentStatus | null; agentStatusUpdatedAt: number | null; endedAt: number | null; tokensUsed: number | null; costUsd: number | null; lastContextTokens: number | null; usageUpdatedAt: number | null; usageWarningLevel: SessionUsageWarningLevel | null; exitCode: number | null }>> {
  return (await getEndedSessions()).map((row) => ({
    id: row.id, repo: row.repo,
    extraRepos: parseResumeRepos(row.resume_repos).filter((r) => r && r !== row.repo),
    cwd: row.cwd, mode: row.mode as SessionMode, provider: providerFromRow(row.provider), model: row.model ?? null, createdAt: row.created_at,
    alive: false, resumable: isResumableBackend(row), wsConnected: false,
    summary: row.summary, summaryUpdatedAt: row.summary_updated_at,
    agentStatus: null, agentStatusUpdatedAt: null, endedAt: row.ended_at,
    tokensUsed: row.tokens_used, costUsd: row.cost_usd, lastContextTokens: row.last_context_tokens,
    usageUpdatedAt: row.usage_updated_at, usageWarningLevel: usageWarningLevel(row.last_context_tokens),
    exitCode: row.exit_code ?? null,
  }));
}

/**
 * History lookup for one ended session. Returns undefined when the id has no
 * persisted row, or has a row that is still live (`ended_at IS NULL`).
 * `resumable` is false for a host-tmux row (`backend` NULL or `local-tmux`),
 * which can no longer be resumed.
 */
export async function getEndedSession(id: string): Promise<{
  id: string; repo: string | null; extraRepos: string[]; cwd: string;
  provider: SessionProvider; createdAt: number; endedAt: number; summary: string | null;
  mode: SessionMode; exitCode: number | null; lastOutput: string | null; failureReason: string | null;
  resumable: boolean;
  startedBy?: { session: string; issue: string | null } | null;
} | undefined> {
  const row = await getPersistedSession(id);
  if (!row || row.ended_at == null) return undefined;
  return {
    id: row.id, repo: row.repo,
    extraRepos: parseResumeRepos(row.resume_repos).filter((r) => r && r !== row.repo),
    cwd: row.cwd, provider: providerFromRow(row.provider), createdAt: row.created_at,
    endedAt: row.ended_at, summary: row.summary,
    mode: row.mode as SessionMode, exitCode: row.exit_code ?? null, lastOutput: row.last_output ?? null,
    failureReason: row.startup_failure ?? null,
    resumable: isResumableBackend(row),
    ...(row.spawned_by_session ? { startedBy: { session: row.spawned_by_session, issue: row.spawned_for_issue ?? null } } : {}),
  };
}

const inFlightSummaries = new Set<string>();

const IDLE_SUMMARY_RE = /^\s*(?:idle|waiting|sitting)\b/i;
const IDLE_AGENT_RE = /claude|codex|opencode|\bpi\b|agent/i;

export function isIdlePlaceholder(summary: string | null): boolean {
  return summary != null && IDLE_SUMMARY_RE.test(summary);
}

// Matches "#123", "PR #123", "issue #123", "owner/repo#123", "owner/repo #123",
// "pull request #123". Both the keyword and the owner/repo prefix tolerate a space
// before the "#" — otherwise "owner/repo #123" leaves the repo name behind as two
// tokens and passes for content.
const ISSUE_REF_RE = new RegExp(
  `(?:\\b(?:issues?|prs?|pull\\s+requests?|tickets?)\\b\\s*)?(?:[A-Za-z0-9._-]+/[A-Za-z0-9._-]+\\s*)?#${ISSUE_REF_GUARDED}`,
  "gi",
);

// Words that carry no information about WHAT is being worked on. If a summary
// mentions an issue/PR number and everything else it says is on this list, the
// number is doing all the work and the summary is useless to a reader.
const SUMMARY_FILLER_WORDS = new Set([
  "a", "an", "and", "at", "for", "from", "in", "into", "of", "on", "onto", "the", "to", "with", "via",
  "this", "that", "its", "some",
  "work", "works", "working", "worked",
  "review", "reviews", "reviewing", "reviewed",
  "merge", "merges", "merging", "merged",
  "fix", "fixes", "fixing", "fixed",
  "check", "checks", "checking", "checked",
  "look", "looks", "looking",
  "plan", "plans", "planning",
  "issue", "issues", "pr", "prs", "pull", "request", "requests", "ticket", "tickets",
  "comment", "comments", "feedback",
  "task", "tasks", "item", "items", "thread", "threads",
  "repo", "repos", "repository", "branch", "change", "changes", "code", "stuff", "things",
  "add", "adds", "adding", "added",
  "address", "addresses", "addressing", "addressed",
  "do", "does", "doing", "done",
  "handle", "handles", "handling", "handled",
  "implement", "implements", "implementing", "implemented",
  "resolve", "resolves", "resolving", "resolved",
  "update", "updates", "updating", "updated",
  "about", "after", "again", "before", "currently", "here", "it", "just", "now",
  "latest", "more", "new", "next", "other", "another", "several", "still", "then", "there",
  "progress", "session", "sessions", "terminal", "output",
]);

/** Remove issue/PR references and tidy the punctuation they leave behind. */
export function stripIssueRefs(summary: string): string {
  return summary
    .replace(ISSUE_REF_RE, " ")
    .replace(/\s+([,;:.])/g, "$1")
    .replace(/\s{2,}/g, " ")
    .replace(/^[\s,;:.\-–—]+|[\s,;:.\-–—]+$/g, "")
    .trim();
}

/** How many words in a stripped summary actually say something about the subject. */
function contentWordCount(stripped: string): number {
  const words = stripped.toLowerCase().match(/[a-z0-9][a-z0-9'-]*/g) ?? [];
  return words.filter((w) => !SUMMARY_FILLER_WORDS.has(w)).length;
}

const HAS_ISSUE_REF_RE = new RegExp(`#${ISSUE_REF_GUARDED}`);

/** True when a summary names an issue/PR number and says nothing substantive besides. */
export function isNumberOnlySummary(summary: string): boolean {
  if (!HAS_ISSUE_REF_RE.test(summary)) return false;
  return contentWordCount(stripIssueRefs(summary)) < 2;
}

export const SUMMARY_RETRY_INSTRUCTION =
  "Your previous answer was REJECTED because it identified the work only by an issue or PR number, which tells a reader nothing. Answer again without mentioning any number at all: name the actual feature, component, bug or symptom visible in the terminal output above.";

/** First line, unquoted, length-capped, with idle output collapsed to a canonical string. Returns "" when unusable. */
function normalizeSummary(raw: string): string {
  let s = (raw.trim().split("\n")[0] ?? "").replace(/^["']|["']$/g, "").trim().slice(0, MAX_SESSION_DESCRIPTION_LEN);
  if (!s) return "";
  if (IDLE_SUMMARY_RE.test(s)) return IDLE_AGENT_RE.test(s) ? "Idle at Claude prompt" : "Idle at shell prompt";
  return s;
}

/** The fields `summarizeSession` reads and updates — the backend's live-session record supplies them. */
export interface SummarizableSession {
  id: string;
  alive: boolean;
  scrollback: string;
  lastActivity: number;
  summary: string | null;
  summaryUpdatedAt: number | null;
  summaryManual: boolean;
}

export async function summarizeSession(session: SummarizableSession, opts: { force?: boolean } = {}): Promise<void> {
  if (isShuttingDown()) return;
  if (!session.alive) return;
  if (session.summaryManual) return;
  if (!opts.force) {
    // A number-only summary is treated like an idle placeholder: refreshable once
    // there is newer activity. Bounded — this function never persists a summary
    // that fails isNumberOnlySummary(), so at most one refresh per session.
    const refreshable = session.summary !== null &&
      (isIdlePlaceholder(session.summary) || isNumberOnlySummary(session.summary));
    if (session.summary && !refreshable) return;
    if (refreshable && session.lastActivity <= (session.summaryUpdatedAt ?? 0)) return;
  }
  if (inFlightSummaries.has(session.id)) return;
  if (!session.scrollback) return;

  const clean = stripVTControlCharacters(session.scrollback);
  const trimmed = clean.slice(-12000);
  if (trimmed.trim().length < 80) return;

  inFlightSummaries.add(session.id);
  try {
    const prompt = `Summarise what the user is currently doing in this interactive terminal session in <=8 words. Describe the actual feature, bug, or subject being worked on — name the behaviour, component, or symptom. NEVER write an issue or PR number unless the rest of the summary already names the actual subject on its own — a reader cannot look numbers up, so "Reviewing PR #1234 comments" is worthless while "Reviewing session-description edit PR" is good. When in doubt, leave the number out entirely. Do NOT include the repository, worktree, or directory name — that is already shown in a separate column, so it wastes space. Avoid generic phrases like "working on code" or "running commands". If the session is sitting at a plain shell prompt with no recent activity, reply exactly "Idle at shell prompt". If it is sitting at an idle Claude/agent prompt awaiting input, reply exactly "Idle at Claude prompt". Otherwise, if the most recent activity is a Claude/agent session, summarise the agent's current task, not the literal CLI invocation.

Reply with just the summary text. No quotes, no trailing punctuation, no preamble.

Good examples:
- Editing session summariser prompt
- Fixing WebSocket reconnect loop
- Running vitest suite on db layer
- Debugging k3s monitor alert noise
- Idle at shell prompt
- Idle at Claude prompt

Bad examples — identify the work by number alone:
- Working on #1234
- Reviewing PR #1234 comments
- Reviewing fleet-infra issue #1267 plan
- Merging PR #1566

Recent terminal output:
---
${trimmed}
---`;

    const raw = await claude.runClaude(prompt, os.homedir(), {
      provider: "claude",
      tier: "sonnet",
      timeoutMs: 60_000,
      agent: "plan",
    });

    if (session.summaryManual) return;

    let summary = normalizeSummary(raw);
    if (!summary) return;

    if (isNumberOnlySummary(summary)) {
      const retryRaw = await claude.runClaude(
        `${prompt}\n\n${SUMMARY_RETRY_INSTRUCTION}\nRejected answer: ${summary}`,
        os.homedir(),
        { provider: "claude", tier: "sonnet", timeoutMs: 60_000, agent: "plan" },
      );
      if (session.summaryManual) return; // pin may have landed during the retry
      const retry = normalizeSummary(retryRaw);
      if (retry && !isNumberOnlySummary(retry)) {
        summary = retry;
      } else {
        // Both attempts leaned on the number: strip it rather than persist it, and
        // never leave the field empty. Every candidate here is either a strip
        // product (no "#\d" left) or a hardcoded placeholder with no digits, so
        // anything this function persists passes isNumberOnlySummary() — that is
        // what bounds the refresh-gate above to a single extra call per session.
        // Keep whichever stripped candidate says the most rather than blindly
        // preferring the retry, which may be the weaker of two bad answers.
        const candidates = [stripIssueRefs(summary), retry ? stripIssueRefs(retry) : ""].filter((c) => c.length > 0);
        candidates.sort((a, b) => contentWordCount(b) - contentWordCount(a) || b.length - a.length);
        const stripped = (candidates[0] ?? "").slice(0, MAX_SESSION_DESCRIPTION_LEN);
        summary = stripped || "Unspecified session activity";
      }
    }

    session.summary = summary;
    session.summaryUpdatedAt = Date.now();
    await updateSessionSummary(session.id, summary, session.summaryUpdatedAt);
  } catch (err) {
    log.warn(`[sessions] Failed to summarize session ${session.id}: ${err}`);
  } finally {
    inFlightSummaries.delete(session.id);
  }
}

export const MAX_SESSION_DESCRIPTION_LEN = 120;

/**
 * Set or clear a user-authored description on the session row. An
 * empty/whitespace value clears the manual pin so auto-summarisation resumes.
 * Works for live and ended rows; `ok` is false when no row was updated.
 */
export async function setSessionDescription(id: string, description: string): Promise<{ ok: boolean; description: string | null }> {
  const value = description.replace(/\s+/g, " ").trim().slice(0, MAX_SESSION_DESCRIPTION_LEN);
  const next = value.length > 0 ? value : null;
  const updatedAt = next === null ? null : Date.now();
  let rowUpdated = false;
  try {
    rowUpdated = await setManualSessionSummary(id, next, updatedAt);
  } catch (err) {
    log.warn(`[sessions] Failed to persist description for session ${id}: ${err}`);
    return { ok: false, description: null };
  }
  return { ok: rowUpdated, description: next };
}

/**
 * Record the agent's self-reported status (#3083). Only live sessions are updated:
 * `ok` is false when the row is missing, already ended, or the write failed.
 */
export async function setSessionAgentStatusForSession(id: string, status: SessionAgentStatus): Promise<{ ok: boolean; status: SessionAgentStatus; updatedAt: number }> {
  const updatedAt = Date.now();
  let rowUpdated = false;
  try {
    rowUpdated = await setSessionAgentStatus(id, status, updatedAt);
  } catch (err) {
    log.warn(`[sessions] Failed to persist agent status for session ${id}: ${err}`);
    return { ok: false, status, updatedAt };
  }
  return { ok: rowUpdated, status, updatedAt };
}
