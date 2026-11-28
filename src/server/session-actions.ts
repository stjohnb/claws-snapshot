/** Interactive-session helpers the dashboard routes share: session starts, audit comments, AWS sign-in answers, and agent capability-request views. */
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { commentOnIssue as ghCommentOnIssue } from "../github.js";
import { hasManualAction } from "../pr-state.js";
import { getRecentTasksForRepo, getAllSessionCapabilityDefaults, getIssueBlockedReasons, countLiveSessionsSpawnedBy, type ClawsPrRecord, type Task } from "../db.js";
import * as log from "../log.js";
import { isStalledPr } from "../issue-board.js";
import { loadIssueFlight } from "../issue-flight.js";
import { stageForIssue } from "../issue-stage.js";
import * as clawsIssues from "../claws-issues.js";
import { currentIssueActor } from "../issue-history-actor.js";
import { claudeAccountsStale, refreshClaudeAccounts } from "../claude-accounts.js";
import { describeCreateSessionError, createSessionErrorStatus, SESSION_PROVIDERS, type SessionMode, type SessionProvider } from "../sessions.js";
import { getSessionBackend } from "../session-backend.js";
import { normalizeInitialPrompt } from "../session-initial-prompt.js";
import { renameCapabilityIds } from "../capability-renames.js";
import { classifyLiveGrants, FIXED_AT_LAUNCH_REASON, validCapabilityIds, capabilityLabel, isAutoApproveCapability, defaultProviderAuthCapabilities, withImplicitCapabilities, isAwsCapabilityId } from "../capabilities.js";
import { MAX_PENDING_PER_SESSION as MAX_PENDING_CAPABILITY_REQUESTS, describeCapabilityRequest, recordAutoGrantAtLaunch, request as requestCapability, type CapabilityRequest, type GrantNoticeOutcome } from "../capability-requests.js";
import { awsSignInView, type AwsSignInView, type StartSignInResult } from "../aws-access.js";
import { listAwaitingSignInAwsGrantsForSession } from "../db.js";
import { defaultSessionModel, sessionModelsFor } from "../session-models.js";
import { buildIssueOpeningMessage, buildSessionBrief, buildSpawnedInitialMessage, buildStandaloneSessionBrief, MAX_SESSION_INITIAL_MESSAGE_CHARS, MAX_SESSION_INSTRUCTIONS_CHARS, issueSessionTitle, standaloneSessionTitle, MAX_SESSION_DESCRIPTION_LEN, type IssueSessionFocus } from "../session-brief.js";
import { preselectedSessionCapabilities } from "../session-form-defaults.js";
import { buildRetroOpeningMessage, loadRetroTriageContext } from "../retro-triage.js";
import { type Ctx, type Env, jsonOk } from "./http.js";
import { MAX_LIVE_STARTED_SESSIONS, type NativeIssueRecord, defaultMultiSessionProvider, defaultSessionProvider, isConfiguredRepo, loadSessionAgentDefaults } from "./shared.js";
import type { RouteContext } from "./routes/context.js";

/** The audit comment for a session write (on an issue or PR); a failure is logged, never fails the write. */
export async function postSessionAudit(repo: string, id: string | number, body: string): Promise<void> {
  try {
    await ghCommentOnIssue(repo, id, body);
  } catch (err) {
    log.warn(`[server] Issue ${id}: failed to post session audit comment: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * The body of both start-session routes: option parsing, capability checks,
 * the live-session cap and the create. `issue` is null for an issue-less
 * start, which differs only in the repos default, the brief, the null
 * `spawnedForIssue` and the absent issue audit comment.
 */
export async function startSpawnedSession(
  { controller }: RouteContext,
  c: Context<Env>,
  sid: string,
  issue: { record: NativeIssueRecord; id: string; repo: string } | null,
): Promise<Response> {
  let body: unknown;
  try { body = await c.req.json(); } catch { return jsonOk(c, { error: "Invalid JSON body" }, 400); }
  const raw = (body ?? {}) as { repos?: unknown; provider?: unknown; model?: unknown; instructions?: unknown; initial_message?: unknown; title?: unknown; request_capabilities?: unknown; reason?: unknown };

  let repos: string[];
  if (raw.repos === undefined) {
    repos = issue && issue.repo ? [issue.repo, ...issue.record.repos.filter((r) => r !== issue.repo)] : [];
  } else {
    if (!Array.isArray(raw.repos) || raw.repos.some((r) => typeof r !== "string" || !/^[^/\s]+\/[^/\s]+$/.test(r))) {
      return jsonOk(c, { error: "repos must be an array of owner/name strings" }, 400);
    }
    repos = [...new Set(raw.repos as string[])];
  }
  const multi = repos.length > 1;

  const agentDefaults = await loadSessionAgentDefaults();
  let provider: SessionProvider;
  if (raw.provider === undefined) {
    const providers = await controller.providerStatus();
    provider = multi ? defaultMultiSessionProvider(agentDefaults.lastProvider, providers) : defaultSessionProvider(agentDefaults.lastProvider, providers);
  } else if (typeof raw.provider === "string" && SESSION_PROVIDERS.includes(raw.provider as SessionProvider)) {
    provider = raw.provider as SessionProvider;
  } else {
    return jsonOk(c, { error: `Unknown provider ${JSON.stringify(raw.provider)}. Allowed: ${SESSION_PROVIDERS.join(", ")}` }, 400);
  }

  const offeredModels = sessionModelsFor(provider).map((m) => m.id);
  let model: string | null;
  if (raw.model === undefined) {
    model = defaultSessionModel(provider) || null;
  } else if (typeof raw.model === "string" && offeredModels.includes(raw.model.trim())) {
    model = raw.model.trim();
  } else {
    return jsonOk(c, { error: `Model ${JSON.stringify(raw.model)} is not offered for ${provider}. Allowed: ${offeredModels.length > 0 ? offeredModels.join(", ") : "none"}` }, 400);
  }

  if (raw.instructions !== undefined && typeof raw.instructions !== "string") return jsonOk(c, { error: "instructions must be a string" }, 400);
  const instructions = (raw.instructions as string | undefined)?.trim() ?? "";
  if (instructions.length > MAX_SESSION_INSTRUCTIONS_CHARS) {
    return jsonOk(c, { error: `instructions must be at most ${MAX_SESSION_INSTRUCTIONS_CHARS} characters (got ${instructions.length})` }, 400);
  }
  if (raw.initial_message !== undefined && typeof raw.initial_message !== "string") return jsonOk(c, { error: "initial_message must be a string" }, 400);
  const initialMessage = normalizeInitialPrompt(raw.initial_message);
  if (initialMessage && initialMessage.length > MAX_SESSION_INITIAL_MESSAGE_CHARS) {
    return jsonOk(c, { error: `initial_message must be at most ${MAX_SESSION_INITIAL_MESSAGE_CHARS} characters (got ${initialMessage.length})` }, 400);
  }
  const hasInitialMessage = initialMessage !== null;
  if (raw.title !== undefined && typeof raw.title !== "string") return jsonOk(c, { error: "title must be a string" }, 400);
  const title = (raw.title as string | undefined)?.trim() ?? "";
  if (title.length > MAX_SESSION_DESCRIPTION_LEN) {
    return jsonOk(c, { error: `title must be at most ${MAX_SESSION_DESCRIPTION_LEN} characters (got ${title.length})` }, 400);
  }
  if (issue && title) return jsonOk(c, { error: "title cannot be set for an issue session — it is titled from the issue" }, 400);
  if (raw.reason !== undefined && typeof raw.reason !== "string") return jsonOk(c, { error: "reason must be a string" }, 400);
  const reason = (raw.reason as string | undefined)?.trim() ?? "";

  let requested: string[] = [];
  if (raw.request_capabilities !== undefined) {
    if (!Array.isArray(raw.request_capabilities) || raw.request_capabilities.some((cap) => typeof cap !== "string")) {
      return jsonOk(c, { error: "request_capabilities must be an array of capability ids" }, 400);
    }
    // A renamed id (e.g. `prod-observability`) is asked for under its current id.
    requested = renameCapabilityIds(raw.request_capabilities as string[]);
  }
  if (requested.length > MAX_PENDING_CAPABILITY_REQUESTS) {
    return jsonOk(c, { error: `At most ${MAX_PENDING_CAPABILITY_REQUESTS} capabilities may be requested (got ${requested.length})` }, 400);
  }

  // A login stored since this process last read the accounts keeps claude-auth.
  if (claudeAccountsStale()) await refreshClaudeAccounts();
  const mode: SessionMode = repos.length === 0 ? "home-claude" : "worktree-claude";
  const baseline = withImplicitCapabilities(defaultProviderAuthCapabilities(provider, mode), repos);
  const backend = getSessionBackend();
  const classified = classifyLiveGrants(baseline, backend.kind, { provider, mode });
  const grantable = classified.filter((entry) => entry.state === "grantable").map((entry) => entry.cap.id);
  const available = validCapabilityIds(requested);
  const toRequest: string[] = [];
  // Auto-approve capabilities are granted at launch, not queued for the operator.
  const autoGranted: string[] = [];
  for (const cap of requested) {
    if (baseline.includes(cap)) continue;
    if (!available.includes(cap)) {
      return jsonOk(c, { error: `Unknown or unavailable capability ${cap}. Requestable: ${grantable.length > 0 ? grantable.join(", ") : "none"}` }, 400);
    }
    if (!grantable.includes(cap)) {
      // A capability this provider cannot use at all (browser on codex) gives its own reason: launching from the dashboard would not help.
      const reason = classified.find((entry) => entry.cap.id === cap)?.reason;
      const why = reason && reason !== FIXED_AT_LAUNCH_REASON
        ? `${cap} cannot be requested: ${reason}`
        : `${cap} is only grantable at launch — ask the operator to create the session from the dashboard`;
      return jsonOk(c, { error: `${why}. Requestable: ${grantable.length > 0 ? grantable.join(", ") : "none"}` }, 400);
    }
    if (isAutoApproveCapability(cap)) autoGranted.push(cap);
    else toRequest.push(cap);
  }

  const live = await countLiveSessionsSpawnedBy(sid);
  if (live >= MAX_LIVE_STARTED_SESSIONS) {
    return jsonOk(c, { error: `This session already has ${live} live sessions it started (limit ${MAX_LIVE_STARTED_SESSIONS}) — end one before starting another` }, 409);
  }

  let brief: string;
  if (issue) {
    const plans = await clawsIssues.listPlans(issue.id);
    brief = buildSessionBrief({
      issueId: issue.id,
      title: issue.record.title,
      url: clawsIssues.dashboardIssueUrl(issue.id),
      body: issue.record.body,
      planBody: plans.length > 0 ? plans[plans.length - 1]!.body : null,
      instructions,
      startedBy: sid,
      hasInitialMessage,
    });
  } else {
    brief = buildStandaloneSessionBrief({ instructions, startedBy: sid, hasInitialMessage });
  }
  const spawn = {
    brief,
    spawnedBySession: sid,
    spawnedForIssue: issue?.id ?? null,
    title: issue ? issueSessionTitle(issue.record.title) : standaloneSessionTitle(title, instructions, sid, initialMessage ?? ""),
    ...(initialMessage ? { initialPrompt: buildSpawnedInitialMessage(sid, initialMessage) } : {}),
  };
  const result = await backend.create({ repos, mode, capabilities: [...baseline, ...autoGranted], provider, model, ...spawn });
  if (!result.ok) {
    const status = createSessionErrorStatus(result);
    return jsonOk(c, { error: `Cannot create session: ${describeCreateSessionError(result)}` }, status);
  }
  const newId = result.id;

  const requestReason = `Requested by session ${sid} at start${reason ? `: ${reason}` : ""}`;
  for (const cap of autoGranted) {
    try {
      await recordAutoGrantAtLaunch(newId, cap, requestReason);
    } catch (err) {
      log.warn("Failed to record a capability granted automatically at launch", { component: "capability-requests", session: newId, capability: cap, error: String(err) });
    }
    log.info("Auto-approved capability request", { component: "capability-requests", session: newId, capability: cap, outcome: "granted-at-launch" });
  }
  const pending: string[] = [];
  for (const cap of toRequest) {
    const created = await requestCapability(newId, cap, requestReason);
    if (created.ok) pending.push(cap);
  }
  const url = clawsIssues.dashboardSessionUrl(newId);
  if (issue) {
    await postSessionAudit(issue.repo, issue.id, `Session \`${sid}\` started session [\`${newId}\`](${url}) for this issue (${provider}${model ? `, ${model}` : ""}; ${repos.length > 0 ? repos.join(", ") : "home directory"})${hasInitialMessage ? " with a first message" : ""}.${autoGranted.length > 0 ? ` Granted automatically: ${autoGranted.join(", ")}.` : ""}${pending.length > 0 ? ` Capabilities awaiting the operator: ${pending.join(", ")}.` : ""}`);
  }
  log.info(`[sessions] Session ${sid} started session ${newId} ${issue ? `for issue ${issue.id}` : "(no issue)"} (title: ${JSON.stringify(spawn.title)}, provider: ${provider}, model: ${model ?? "default"}, repos: ${repos.join(", ") || "none"}, granted capabilities: ${autoGranted.join(", ") || "none"}, pending capabilities: ${pending.join(", ") || "none"}, initial message: ${initialMessage ? `${initialMessage.length} chars` : "none"})`);
  return jsonOk(c, {
    ok: true, id: newId, url, provider, model, repos, granted_capabilities: autoGranted, pending_capabilities: pending,
    initial_message: hasInitialMessage ? "queued" : "none",
    first_turn: hasInitialMessage ? "It starts on your initial message as soon as its agent is ready." : "It waits for the operator's first message.",
  });
}

/**
 * How a grant reached the agent (#3106): a waiting agent collected it, or
 * Claws typed a notice into its terminal; `notifyFailure` when it could not;
 * `agentNoticeQueued` when the agent is restarting and is told once it is back.
 */
export const agentNoticeFields = (notice: GrantNoticeOutcome) => ({
  agentPickedUp: notice.agentPickedUp,
  agentNotified: notice.agentNotified,
  notifyFailure: notice.notifyFailure,
  agentNoticeQueued: notice.agentNoticeQueued,
});

/** Who approved an AWS grant: the signed-in dashboard user, else `operator`. */
export const operatorName = (): string => {
  const actor = currentIssueActor();
  return actor.kind === "operator" && actor.name ? actor.name : "operator";
};

/** The session's AWS sign-ins still awaiting the operator; a DB failure reads as none. */
export const sessionSignIns = async (sessionId: string): Promise<AwsSignInView[]> => {
  try {
    return (await listAwaitingSignInAwsGrantsForSession(sessionId))
      .map(awsSignInView)
      .filter((v): v is AwsSignInView => v !== null);
  } catch (err) {
    log.warn("Could not read AWS sign-ins", { component: "aws-access", session: sessionId, error: String(err) });
    return [];
  }
};

/** The route answer to `startSignIn`: the link and code to show, or why not. */
export const signInResponse = (c: Ctx, capability: string, started: StartSignInResult) => {
  if (started.ok) {
    return jsonOk(c, {
      status: "awaiting-signin",
      capability,
      label: capabilityLabel(capability),
      signIn: { verificationUrl: started.verificationUrl, userCode: started.userCode, expiresAt: started.expiresAt },
    });
  }
  const status = started.reason === "not-found" ? 404 : started.reason === "unavailable" ? 503 : started.reason === "aws-error" ? 502 : 400;
  return jsonOk(c, { error: started.detail, ...(started.reason === "not-found" ? { code: "session-not-found" } : {}) }, status);
};

/**
 * A pending request as the agent sees it: `awaiting-signin` while the
 * operator approved it and Claws' AWS sign-in is under way. Never carries the
 * sign-in link or code: only the operator signs in.
 */
export const describeAgentRequest = async (entry: CapabilityRequest): Promise<Record<string, unknown>> => {
  const base = describeCapabilityRequest(entry);
  if (entry.status !== "pending" || !isAwsCapabilityId(entry.capability)) return base;
  const awaiting = (await sessionSignIns(entry.sessionId)).some((v) => v.capability === entry.capability);
  return awaiting ? { ...base, status: "awaiting-signin" } : base;
};

export const runtimeUnavailable = (c: Ctx, detail?: string) =>
  jsonOk(c, { error: `Session runtime unavailable${detail ? `: ${detail}` : ""}` }, 503);

/**
 * The provider, model and capabilities the New session form would
 * pre-select for `repos` right now. Reads the remembered defaults only; the
 * dashboard's one-click starts never write them.
 */
export async function sessionFormDefaultsFor({ controller }: RouteContext, repos: string[]): Promise<{ provider: SessionProvider; model: string | null; capabilities: string[] }> {
  const agentDefaults = await loadSessionAgentDefaults();
  const providers = await controller.providerStatus();
  const provider: SessionProvider = repos.length > 1 ? defaultMultiSessionProvider(agentDefaults.lastProvider, providers) : defaultSessionProvider(agentDefaults.lastProvider, providers);
  const model = defaultSessionModel(provider) || null;
  let remembered = new Map<string, string[]>();
  try {
    remembered = await getAllSessionCapabilityDefaults();
  } catch (err) {
    log.warn(`[sessions] Could not load remembered capability defaults: ${err instanceof Error ? err.message : String(err)}`);
  }
  return { provider, model, capabilities: preselectedSessionCapabilities(repos, remembered, provider) };
}

/**
 * The problem an issue-started session's first message points at (see
 * `IssueSessionFocus`); null when the issue looks healthy.
 */
export function issueSessionFocus(blocked: boolean, blockedReason: string | null, openPrs: readonly ClawsPrRecord[], lastTask: Task | null): IssueSessionFocus {
  if (blocked) return { kind: "blocked", reason: blockedReason };
  const stalled = openPrs.find((pr) => isStalledPr({ stage: pr.stage, needsHumanReview: pr.needsHumanReview, ciBlockedReason: pr.ciBlockedReason }));
  if (stalled) {
    return { kind: "stalled-pr", repo: stalled.repo, number: stalled.prNumber, reason: stalled.ciBlockedReason ?? "Claws gave up fixing its CI" };
  }
  const held = openPrs.find((pr) => hasManualAction(pr));
  if (held) return { kind: "manual-action", repo: held.repo, number: held.prNumber, reason: held.manualActionReason! };
  if (lastTask?.status === "failed") return { kind: "failed-work", job: lastTask.job_name, failureReason: lastTask.outcome };
  return null;
}

/**
 * Starts the interactive session behind both the board card's Start session
 * button and the issue page's Create Session button: the issue's repos
 * (primary first), the agent, model and capabilities the New session form
 * would pre-select, the issue's brief and the opening message naming its
 * stage and problem. The two origins differ only in the brief's first line
 * and `spawned_from`. Nothing is remembered; the audit comment (issue page
 * only) is the caller's.
 */
export async function startIssueSession(
  ctx: RouteContext,
  record: NonNullable<Awaited<ReturnType<typeof clawsIssues.getIssue>>>,
  id: string,
  origin: "board" | "issue-page",
): Promise<
  | { ok: true; id: string; url: string; provider: SessionProvider; model: string | null; repos: string[] }
  | { ok: false; status: ContentfulStatusCode; error: string }
> {
  const primary = record.repos.length > 0 ? clawsIssues.primaryRepo(record) : "";
  const repos = primary ? [primary, ...record.repos.filter((r) => r !== primary)] : [];
  for (const repo of repos) {
    if (!(await isConfiguredRepo(repo))) return { ok: false, status: 403, error: "Repository not configured" };
  }
  const { provider, model, capabilities } = await sessionFormDefaultsFor(ctx, repos);
  const mode: SessionMode = repos.length === 0 ? "home-claude" : "worktree-claude";

  const plans = await clawsIssues.listPlans(id);
  const brief = buildSessionBrief({
    issueId: id,
    title: record.title,
    url: clawsIssues.dashboardIssueUrl(id),
    body: record.body,
    planBody: plans.length > 0 ? plans[plans.length - 1]!.body : null,
    instructions: null,
    startedBy: null,
    origin,
  });
  const bestEffort = async <T>(what: string, read: () => Promise<T>, fallback: T): Promise<T> => {
    try {
      return await read();
    } catch (err) {
      log.warn(`[server] could not read the ${what} of issue ${id} for its session: ${err}`);
      return fallback;
    }
  };
  const blocked = record.lifecycle === "blocked";
  const [stage, blockedReason, flight, lastTask] = await Promise.all([
    bestEffort("stage", () => stageForIssue(record), null),
    blocked ? bestEffort("blocked reason", async () => (await getIssueBlockedReasons([id])).get(id) ?? null, null) : null,
    primary ? bestEffort("flight", () => loadIssueFlight(primary, id), null) : null,
    primary ? bestEffort("recent tasks", async () => (await getRecentTasksForRepo(primary)).find((t) => t.item_number === id) ?? null, null) : null,
  ]);
  const focus = issueSessionFocus(blocked, blockedReason, flight?.openPrs ?? [], lastTask);
  // A friction retrospective opens on its triage context instead (#clw_01M8A981K3C3359F231EYRFJTC).
  const retro = await bestEffort("retrospective triage context", () => loadRetroTriageContext(id), null);
  const spawn = {
    brief,
    spawnedBySession: null,
    spawnedForIssue: id,
    spawnedFrom: origin === "issue-page" ? ("issue-page" as const) : null,
    title: issueSessionTitle(record.title),
    initialPrompt: retro
      ? buildRetroOpeningMessage({ issueId: id, title: record.title, context: retro })
      : buildIssueOpeningMessage({ issueId: id, title: record.title, stageTitle: stage?.stage_title ?? null, repos, focus }),
  };
  const backend = getSessionBackend();
  const result = await backend.create({ repos, mode, capabilities, provider, model, ...spawn });
  if (!result.ok) return { ok: false, status: createSessionErrorStatus(result), error: describeCreateSessionError(result) };
  log.info(`[sessions] ${origin === "board" ? "Board" : "Issue page"} started session ${result.id} for issue ${id} (provider: ${provider}, model: ${model ?? "default"}, repos: ${repos.join(", ") || "none"}, capabilities: ${capabilities.join(", ") || "none"}, focus: ${focus?.kind ?? "none"}, retro: ${retro !== null})`);
  return { ok: true, id: result.id, url: clawsIssues.dashboardSessionUrl(result.id), provider, model, repos };
}
