/** Dashboard `/sessions/*` writes, capability requests, session attachments and `POST /logs/*`. Moved out of `registerRoutes` (src/server.ts) unchanged. */
import path from "node:path";
import { Readable } from "node:stream";
import { bodyLimit } from "hono/body-limit";
import { sessionMoveNotice } from "../../session-move.js";
import { listRepos } from "../../github.js";
import { getJobRun, cancelJobRunIfRunning, rememberSessionCapabilityDefaults, rememberSessionAgentDefault } from "../../db.js";
import * as log from "../../log.js";
import { claudeAccountsStale, refreshClaudeAccounts } from "../../claude-accounts.js";
import { describeCreateSessionError, createSessionErrorStatus, isSessionAgentStatus, SESSION_AGENT_STATUSES, SESSION_MODES, SESSION_PROVIDERS, type SessionMode, type SessionProvider } from "../../sessions.js";
import { getSessionBackend } from "../../session-backend.js";
import { CHAT_INPUT_MAX_BYTES, normalizeTranscriptLines } from "../../session-chat.js";
import { MAX_SESSION_INITIAL_PROMPT_CHARS, normalizeInitialPrompt } from "../../session-initial-prompt.js";
import { RETIRED_CAPABILITIES, isRetiredCapability, renameCapabilityIds } from "../../capability-renames.js";
import { liveGrantableCapabilities, validCapabilityIds, capabilityLabel, isAutoApproveCapability, isRememberableCapability, BROWSER_CAPABILITY_ID, isAwsCapabilityId, isRunningSessionOnlyCapability } from "../../capabilities.js";
import { MAX_PENDING_PER_SESSION as MAX_PENDING_CAPABILITY_REQUESTS, autoApprove as autoApproveCapabilityRequest, clearCapabilityRequest, clearCapabilityRequestsForSession, decide as decideCapabilityRequest, deliverGrantNotice, describeCapabilityRequest, describeGrantedCapability, get as getCapabilityRequest, listAutoGranted as listAutoGrantedCapabilities, listPending as listPendingCapabilityRequests, markGrantSeen as markCapabilityGrantSeen, markPolled as markCapabilityPolled, recordGrant as recordCapabilityGrant, recordRevoke as recordCapabilityRevoke, request as requestCapability } from "../../capability-requests.js";
import { awsGrantHistoryView, cancelAwsSignIns, recordAwsGrantEnd, startSignIn } from "../../aws-access.js";
import { getActiveSessionAwsGrant, listSessionAwsGrants } from "../../db.js";
import { sessionPageTitle } from "../../pages/sessions.js";
import { CUSTOM_MODEL_SENTINEL, isValidSessionModel } from "../../session-models.js";
import { MAX_UPLOAD_BYTES, MAX_LARGE_UPLOAD_BYTES, isAudioUpload } from "../../session-uploads-core.js";
import { transcribe, isAvailable as transcribeAvailable, voiceVocabularyPrompt } from "../../transcribe.js";
import { stageSessionAttachment, stageSessionAttachmentStream, findPendingSessionAttachments, deleteSessionAttachment, sweepPendingSessionAttachments, isSessionAttachmentId } from "../../session-attachments.js";
import { type Ctx, checkSessionAttachments, checkUploadTarget, describeUploadError, htmlError, jsonOk, parseFormBody, parseFormBodyMulti, readTextBody, shutdownRetryError, textPlain, uploadErrorResponse } from "../http.js";
import { apiAuthMiddleware, authMiddleware, sessionOwnTokenMiddleware } from "../auth.js";
import { agentNoticeFields, operatorName, sessionSignIns, signInResponse, describeAgentRequest, runtimeUnavailable } from "../session-actions.js";
import { Hono } from "hono";
import type { Env } from "../http.js";
import type { RouteContext } from "./context.js";

export function registerSessionWriteRoutes(app: Hono<Env>, ctx: RouteContext): void {
  const { controller } = ctx;
  // The explicit selection of a successful create becomes that repo
  // combination's pre-ticked default next time. Agent logins follow the Agent
  // select instead, and the always-forced cross-repo baseline is a disabled
  // checkbox that never posts, so neither is remembered; an explicit forgejo
  // tick for a repo selection it isn't forced on IS remembered like any other
  // capability. A DB failure must not fail the create, which has already
  // succeeded.
  const rememberCapabilityDefaults = async (repos: string[], capabilities: string[]): Promise<void> => {
    try {
      await rememberSessionCapabilityDefaults(repos, capabilities.filter((id) => isRememberableCapability(id)));
    } catch (err) {
      log.warn(`[sessions] Could not remember capability defaults for ${repos.join(", ")}: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  // The agent of a successful dashboard create becomes the next form's default
  // agent; the model is never remembered (every form starts on the agent's fixed default).
  const rememberAgentDefault = async (provider: SessionProvider): Promise<void> => {
    try {
      await rememberSessionAgentDefault(provider);
    } catch (err) {
      log.warn(`[sessions] Could not remember agent default ${provider}: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  app.post("/sessions/create", authMiddleware, async (c) => {
    const body = await readTextBody(c);
    const params = parseFormBody(body);
    // Ticked repo chips in picker order, the first one primary: none is a home-directory session.
    const repos = [...new Set(parseFormBodyMulti(body, "repo").filter(Boolean))];
    const rawMode = params["mode"] || "repo-zsh";
    if (!SESSION_MODES.includes(rawMode as SessionMode)) {
      return htmlError(c, 400, "Cannot create session", "Invalid mode", {
        actions: [{ href: "/sessions", label: "← Sessions" }],
      });
    }
    const mode = rawMode as SessionMode;
    const rawProvider = params["provider"] || "claude";
    if (!SESSION_PROVIDERS.includes(rawProvider as SessionProvider)) {
      return htmlError(c, 400, "Cannot create session", "Invalid provider", {
        actions: [{ href: "/sessions", label: "← Sessions" }],
      });
    }
    const provider = rawProvider as SessionProvider;
    // A login stored since this process last read the accounts keeps claude-auth.
    if (claudeAccountsStale()) await refreshClaudeAccounts();
    // aws-* is never granted at launch: a running session requests it (#clw_01M8426RTMG1TWE224NXW1V02S).
    const capabilities = validCapabilityIds(parseFormBodyMulti(body, "capability")).filter((id) => !isRunningSessionOnlyCapability(id));
    // Disabled <select>s are not submitted by the browser, so exactly one
    // `model` key arrives even though the form renders one per provider.
    const rawModel = params["model"] || "";
    const model = rawModel === CUSTOM_MODEL_SENTINEL ? (params["modelCustom"] || "").trim() : rawModel.trim();
    if (model && !isValidSessionModel(model)) {
      return htmlError(c, 400, "Cannot create session", "Invalid model id", {
        actions: [{ href: "/sessions", label: "← Sessions" }],
      });
    }
    const initialPrompt = normalizeInitialPrompt(params["initialPrompt"]);
    if (initialPrompt !== null && initialPrompt.length > MAX_SESSION_INITIAL_PROMPT_CHARS) {
      return htmlError(c, 400, "Cannot create session", `Initial prompt is too long (max ${MAX_SESSION_INITIAL_PROMPT_CHARS.toLocaleString("en-US")} characters)`, {
        actions: [{ href: "/sessions", label: "← Sessions" }],
      });
    }
    // "zsh in repo" starts no agent and sends no first message, so its attachment control is disabled and stray ids are dropped.
    const attachments = mode === "repo-zsh" ? [] : parseFormBodyMulti(body, "attachment");
    const attachmentError = await checkSessionAttachments(c, attachments);
    if (attachmentError) return attachmentError;
    const result = await getSessionBackend().create({ repos, mode, capabilities, provider, model: model || null, initialPrompt: mode === "repo-zsh" ? null : initialPrompt, attachments });
    if (!result.ok) {
      if (result.reason === "shutting-down") {
        const fields: Array<{ name: string; value: string }> = [];
        for (const r of repos) fields.push({ name: "repo", value: r });
        fields.push({ name: "mode", value: mode });
        fields.push({ name: "provider", value: provider });
        for (const cap of capabilities) fields.push({ name: "capability", value: cap });
        if (model) fields.push({ name: "model", value: model });
        if (initialPrompt) fields.push({ name: "initialPrompt", value: initialPrompt });
        for (const id of attachments) fields.push({ name: "attachment", value: id });
        return shutdownRetryError(c, "Cannot create session", "/sessions/create", fields);
      }
      return htmlError(c, createSessionErrorStatus(result), "Cannot create session", describeCreateSessionError(result), {
        actions: [{ href: "/sessions", label: "← Sessions" }],
      });
    }
    if (repos.length > 0) await rememberCapabilityDefaults(repos, capabilities);
    if (mode !== "repo-zsh") await rememberAgentDefault(provider);
    return c.redirect(`/sessions/${result.id}`, 303);
  });

  app.post("/sessions/:id/kill", authMiddleware, async (c) => {
    const id = c.req.param("id");
    if (!/^[a-f0-9]+$/.test(id)) {
      return textPlain(c, "Not found", 404);
    }
    const result = await getSessionBackend().end(id);
    if (!result.ok) {
      return result.reason === "unavailable"
        ? textPlain(c, `Session runtime unavailable${result.detail ? `: ${result.detail}` : ""}`, 503)
        : textPlain(c, "Session not found", 404);
    }
    await clearCapabilityRequestsForSession(id);
    return c.redirect("/sessions", 303);
  });

  app.post("/sessions/:id/delete", authMiddleware, async (c) => {
    const id = c.req.param("id");
    if (!/^[a-f0-9]+$/.test(id)) {
      return textPlain(c, "Not found", 404);
    }
    const result = await getSessionBackend().remove(id);
    if (!result.ok) {
      return result.reason === "unavailable"
        ? textPlain(c, `Session runtime unavailable${result.detail ? `: ${result.detail}` : ""}`, 503)
        : textPlain(c, "Session not found", 404);
    }
    await clearCapabilityRequestsForSession(id);
    return c.redirect("/sessions", 303);
  });

  app.post("/sessions/:id/resume", authMiddleware, async (c) => {
    const id = c.req.param("id");
    if (!/^[a-f0-9]+$/.test(id)) {
      return textPlain(c, "Not found", 404);
    }
    const result = await getSessionBackend().resume(id);
    if (!result.ok) {
      const status = result.reason === "shutting-down" || result.reason === "backend-unavailable" ? 503
        : result.reason === "repo-not-found" || result.reason === "repo-not-listed" ? 404
        : result.reason === "not-resumable" ? 409
        : 500;
      if ((c.req.header("accept") ?? "").includes("text/html")) {
        if (result.reason === "shutting-down") {
          return shutdownRetryError(c, "Cannot revive session", `/sessions/${id}/resume`, []);
        }
        return htmlError(c, status, "Cannot revive session", describeCreateSessionError(result), {
          detail: id, actions: [{ href: "/sessions", label: "← All sessions" }],
        });
      }
      return textPlain(c, `Cannot resume session: ${describeCreateSessionError(result)}`, status);
    }
    return c.redirect(`/sessions/${id}`, 303);
  });

  // Switch account (#clw_01M623AMK66JB6TBB4PP55Q2V6): relaunch the agent on another Claude account, conversation kept.
  app.post("/sessions/:id/switch-account", authMiddleware, async (c) => {
    const id = c.req.param("id");
    if (!/^[a-f0-9]+$/.test(id)) return jsonOk(c, { error: "Not found" }, 404);
    const result = await getSessionBackend().switchClaudeAccount(id);
    if (!result.ok) {
      if (result.reason === "invalid") return jsonOk(c, { error: result.detail }, 409);
      if (result.reason === "unavailable") {
        return jsonOk(c, { error: `Session runtime unavailable${result.detail ? `: ${result.detail}` : ""}` }, 503);
      }
      return jsonOk(c, { error: "Session not found" }, 404);
    }
    return jsonOk(c, { from: result.from, to: result.to });
  });

  const setDescriptionHandler = async (c: Ctx) => {
    const id = c.req.param("id") ?? "";
    if (!/^[a-f0-9]+$/.test(id)) return jsonOk(c, { error: "Not found" }, 404);
    let body: unknown;
    try { body = await c.req.json(); } catch { return jsonOk(c, { error: "Invalid JSON body" }, 400); }
    const raw = (body as { description?: unknown } | null)?.description;
    if (raw != null && typeof raw !== "string") return jsonOk(c, { error: "description must be a string" }, 400);
    const result = await getSessionBackend().setDescription(id, typeof raw === "string" ? raw : "");
    if (!result.ok) return jsonOk(c, { error: "Session not found" }, 404);
    return jsonOk(c, { description: result.description });
  };

  app.post("/sessions/:id/description", authMiddleware, setDescriptionHandler);
  app.post("/api/sessions/:id/description", apiAuthMiddleware, setDescriptionHandler);

  app.get("/api/sessions/:id/startup", apiAuthMiddleware, async (c) => {
    const id = c.req.param("id") ?? "";
    if (!/^[a-f0-9]+$/.test(id)) return jsonOk(c, { error: "Not found" }, 404);
    const result = await getSessionBackend().getStartupStatus(id);
    if (!result.ok) {
      return result.reason === "unavailable"
        ? jsonOk(c, { error: "Session runtime unavailable", detail: result.detail ?? null }, 503)
        : jsonOk(c, { error: "Not found" }, 404);
    }
    // The session's latest node move, for the page's "Moved from …" notice, or its latest restart
    // after an eviction when that is newer (same slot); a read failure just omits it.
    const moved = await sessionMoveNotice(id).catch(() => null);
    const evicted = result.restartNotice ?? null;
    const move = evicted && (!moved || (moved.finishedAt ?? Infinity) < (evicted.finishedAt ?? 0)) ? evicted : moved;
    return jsonOk(c, { ...result.status, move });
  });

  // Operator-only (#3072): never `apiAuthMiddleware`, whose INTERNAL_MCP_TOKEN
  // every agent holds — an agent must not be able to grant itself access.
  app.post("/sessions/:id/capabilities", authMiddleware, async (c) => {
    const id = c.req.param("id");
    if (!/^[a-f0-9]+$/.test(id)) return jsonOk(c, { error: "Not found" }, 404);
    let body: unknown;
    try { body = await c.req.json(); } catch { return jsonOk(c, { error: "Invalid JSON body" }, 400); }
    const capability = (body as { capability?: unknown } | null)?.capability;
    if (typeof capability !== "string" || !capability) return jsonOk(c, { error: "capability must be a non-empty string" }, 400);
    // AWS access is granted only once Claws' own sign-in completes (#clw_01M8426RTMG1TWE224NXW1V02S).
    if (isAwsCapabilityId(capability)) return signInResponse(c, capability, await startSignIn(id, capability, operatorName()));
    const result = await getSessionBackend().grantCapability(id, capability);
    if (!result.ok) {
      if (result.reason === "invalid") return jsonOk(c, { error: result.detail }, 400);
      if (result.reason === "unavailable") {
        return jsonOk(c, { error: `Session runtime unavailable${result.detail ? `: ${result.detail}` : ""}` }, 503);
      }
      return jsonOk(c, { error: "Session not found" }, 404);
    }
    const outcome = { live: result.live, loadPath: result.loadPath, marker: result.marker, delayed: result.delayed, landed: result.landed, restarted: result.restarted };
    // Resolve any pending request so its banner clears; the agent is told either way.
    await recordCapabilityGrant(id, capability);
    return jsonOk(c, { ...outcome, ...agentNoticeFields(await deliverGrantNotice(id, capability, result)) });
  });

  // Operator-only, like the grant: `ssh:*` and the auto-approve capabilities
  // are revocable. Revoking an auto-approve one stores a denial, so the agent
  // cannot have it granted automatically again; the operator can still Grant it.
  app.delete("/sessions/:id/capabilities/:capability", authMiddleware, async (c) => {
    const id = c.req.param("id");
    if (!/^[a-f0-9]+$/.test(id)) return jsonOk(c, { error: "Not found" }, 404);
    const capability = c.req.param("capability");
    const result = await getSessionBackend().revokeCapability(id, capability);
    if (!result.ok) {
      if (result.reason === "invalid") return jsonOk(c, { error: result.detail }, 400);
      if (result.reason === "unavailable") {
        return jsonOk(c, { error: `Session runtime unavailable${result.detail ? `: ${result.detail}` : ""}` }, 503);
      }
      return jsonOk(c, { error: "Session not found" }, 404);
    }
    if (isAutoApproveCapability(capability)) await recordCapabilityRevoke(id, capability);
    else await clearCapabilityRequest(id, capability);
    await recordAwsGrantEnd(id, capability, "revoked");
    return jsonOk(c, { live: result.live, keysRemoved: result.keysRemoved, restarted: result.restarted });
  });

  // A session drops its own aws-* grant (`claws_release_capability`,
  // #clw_01M8426RTMG1TWE224NXW1V02S). It can only take access away: only an
  // aws-* id the session holds is accepted, and only with that session's own
  // scoped token (`sessionOwnTokenMiddleware`), never the shared internal token
  // every agent holds, so no agent can release another session's grant.
  app.delete("/api/sessions/:sid/capabilities/:capability", sessionOwnTokenMiddleware, async (c) => {
    const id = c.req.param("sid");
    if (!/^[a-f0-9]+$/.test(id)) return jsonOk(c, { error: "Not found" }, 404);
    const capability = c.req.param("capability");
    if (!isAwsCapabilityId(capability)) return jsonOk(c, { error: `${capability} cannot be released by the session; only aws-* capabilities can` }, 400);
    const backend = getSessionBackend();
    const live = await backend.getLive(id);
    if (!live.ok && live.reason === "unavailable") return runtimeUnavailable(c, live.detail);
    if (!live.ok || !live.session.alive) return jsonOk(c, { error: "Session not found" }, 404);
    if (!live.session.capabilities.includes(capability)) return jsonOk(c, { error: `This session does not hold ${capability}` }, 400);
    const result = await backend.revokeCapability(id, capability);
    if (!result.ok) {
      if (result.reason === "invalid") return jsonOk(c, { error: result.detail }, 400);
      if (result.reason === "unavailable") return runtimeUnavailable(c, result.detail);
      return jsonOk(c, { error: "Session not found" }, 404);
    }
    await clearCapabilityRequest(id, capability);
    await recordAwsGrantEnd(id, capability, "released");
    return jsonOk(c, { ok: true, capability, released: true, live: result.live });
  });

  // ── Agent-initiated capability requests (#3072) ──
  // The agent asks through `claws_request_capability` (INTERNAL_MCP_TOKEN, so
  // `apiAuthMiddleware`); only the operator's OIDC session may approve or deny.

  /** A capability the live session holds, described with how it is delivered now (see `SessionBackend.grantDelivery`). */
  const grantedCapabilityResponse = async (c: Ctx, id: string, capability: string) => {
    const delivery = await getSessionBackend().grantDelivery(id, capability);
    if (!delivery.ok) {
      return delivery.reason === "unavailable" ? runtimeUnavailable(c, delivery.detail) : jsonOk(c, { error: "Session not found" }, 404);
    }
    await markCapabilityGrantSeen(id, capability);
    const described = describeGrantedCapability(capability, delivery, await getCapabilityRequest(id, capability));
    if (isAwsCapabilityId(capability)) {
      const grant = await getActiveSessionAwsGrant(id).catch(() => undefined);
      if (grant && grant.capability === capability) {
        described["aws"] = { permissionSet: grant.permission_set, accountId: grant.account_id, expiresAt: grant.credentials_expire_at };
      }
    }
    return jsonOk(c, described);
  };

  /** The answer to a request for a retired capability (`RETIRED_CAPABILITIES`):
   *  a clean denial with why, so a pod on an older image that still asks for
   *  one prints it as a denial (#clw_01M7NKT2H402M07VGCAE1TBX8G). */
  const retiredCapabilityResponse = (c: Ctx, id: string, capability: string) => {
    log.info("Answered a request for a retired capability", { component: "capability-requests", session: id, capability, outcome: "retired" });
    return jsonOk(c, { status: "denied", capability, retired: true, message: RETIRED_CAPABILITIES[capability] });
  };

  app.post("/api/sessions/:id/capability-requests", apiAuthMiddleware, async (c) => {
    const id = c.req.param("id");
    if (!/^[a-f0-9]+$/.test(id)) return jsonOk(c, { error: "Not found" }, 404);
    let body: unknown;
    try { body = await c.req.json(); } catch { return jsonOk(c, { error: "Invalid JSON body" }, 400); }
    const { capability: rawCapability, reason } = (body ?? {}) as { capability?: unknown; reason?: unknown };
    if (typeof rawCapability !== "string" || !rawCapability) return jsonOk(c, { error: "capability must be a non-empty string" }, 400);
    // A pod on an older image may ask for a renamed id (#clw_01M7Q9T4AQAGSG48Z3P7B273HR).
    const capability = renameCapabilityIds([rawCapability])[0]!;
    if (typeof reason !== "string" || !reason.trim()) return jsonOk(c, { error: "reason must be a non-empty string" }, 400);
    if (isRetiredCapability(capability)) return retiredCapabilityResponse(c, id, capability);
    await markCapabilityPolled(id, capability);
    const backend = getSessionBackend();
    const live = await backend.getLive(id);
    if (!live.ok && live.reason === "unavailable") return runtimeUnavailable(c, live.detail);
    if (!live.ok || !live.session.alive) return jsonOk(c, { error: "Session not found" }, 404);
    if (live.session.capabilities.includes(capability)) return grantedCapabilityResponse(c, id, capability);
    const requestable = liveGrantableCapabilities(live.session.capabilities, backend.kind, live.session).map((cap) => cap.id);
    if (!requestable.includes(capability)) {
      return jsonOk(c, {
        error: `${capability} is not requestable for this session. Requestable: ${requestable.length > 0 ? requestable.join(", ") : "none"}`,
      }, 400);
    }
    const auto = isAutoApproveCapability(capability);
    const created = await requestCapability(id, capability, reason, Date.now(), { skipPendingLimit: auto });
    if (!created.ok) {
      return jsonOk(c, { error: `This session already has ${MAX_PENDING_CAPABILITY_REQUESTS} pending capability requests — wait for the user to decide them` }, 429);
    }
    if (auto && created.request.status === "pending") {
      // Safe, read-only capabilities are granted at once (#clw_01M77K5B15JHY1N6JMGRZDFQ0D);
      // a failed grant leaves the request pending for the operator.
      const approved = await autoApproveCapabilityRequest(id, capability);
      const outcome = approved.ok ? "granted" : approved.reason === "grant-failed" ? `grant-failed-${approved.grant.reason}` : approved.reason;
      log.info("Auto-approved capability request", { component: "capability-requests", session: id, capability, outcome });
      if (approved.ok) {
        // A grant that restarted the agent is told to it once it is back; its
        // tool call is ending, so describe the grant from the result itself.
        if (approved.grant.restarted) return jsonOk(c, describeGrantedCapability(capability, approved.grant, approved.request));
        return grantedCapabilityResponse(c, id, capability);
      }
      const current = await getCapabilityRequest(id, capability);
      return jsonOk(c, describeCapabilityRequest(current ?? created.request));
    }
    return jsonOk(c, await describeAgentRequest(created.request));
  });

  app.get("/api/sessions/:id/capability-requests/:cap", apiAuthMiddleware, async (c) => {
    const id = c.req.param("id");
    const capability = renameCapabilityIds([c.req.param("cap")])[0]!;
    if (!/^[a-f0-9]+$/.test(id)) return jsonOk(c, { error: "Not found" }, 404);
    if (isRetiredCapability(capability)) return retiredCapabilityResponse(c, id, capability);
    await markCapabilityPolled(id, capability);
    const entry = await getCapabilityRequest(id, capability);
    if (entry && entry.status !== "approved") return jsonOk(c, await describeAgentRequest(entry));
    const live = await getSessionBackend().getLive(id);
    if (!live.ok && live.reason === "unavailable") return runtimeUnavailable(c, live.detail);
    if (live.ok && live.session.alive && live.session.capabilities.includes(capability)) {
      return grantedCapabilityResponse(c, id, capability);
    }
    return jsonOk(c, { error: `No request for ${capability} — request it again` }, 404);
  });

  app.get("/sessions/:id/capability-requests", authMiddleware, async (c) => {
    const id = c.req.param("id");
    if (!/^[a-f0-9]+$/.test(id)) return jsonOk(c, { error: "Not found" }, 404);
    const live = await getSessionBackend().getLive(id);
    const signIns = await sessionSignIns(id);
    let awsGrants: ReturnType<typeof awsGrantHistoryView>[] = [];
    // Capabilities whose sign-in is still under way, including a `granting` row
    // whose link is gone while its credentials are written.
    let awsPending: string[] = [];
    let awsGranting: string[] = [];
    try {
      const rows = await listSessionAwsGrants(id);
      awsGrants = rows.filter((row) => row.status !== "awaiting-signin" && row.status !== "granting").map(awsGrantHistoryView);
      awsGranting = [...new Set(rows.filter((row) => row.status === "granting").map((row) => row.capability))];
      awsPending = [...new Set(rows.filter((row) => row.status === "awaiting-signin" || row.status === "granting").map((row) => row.capability))];
    } catch (err) {
      log.warn("Could not read the session's AWS grants", { component: "aws-access", session: id, error: String(err) });
    }
    const pendingRequests = await listPendingCapabilityRequests(id);
    return jsonOk(c, {
      requests: pendingRequests.map((entry) => {
        // While Claws' AWS sign-in for an approved request is under way, the request carries its link and code.
        const signIn = signIns.find((v) => v.capability === entry.capability);
        if (signIn) {
          return { ...describeCapabilityRequest(entry), status: "awaiting-signin", signIn: { verificationUrl: signIn.verificationUrl, userCode: signIn.userCode, expiresAt: signIn.expiresAt } };
        }
        // Signed in: the credentials are being written, so the request is neither awaiting nor open to a decision.
        return awsGranting.includes(entry.capability) ? { ...describeCapabilityRequest(entry), status: "granting" } : describeCapabilityRequest(entry);
      }),
      // A sign-in the operator started with the Grant control has no request.
      signIns: signIns
        .filter((v) => !pendingRequests.some((r) => r.capability === v.capability))
        .map((v) => ({ capability: v.capability, label: v.label, permissionSet: v.permissionSet, verificationUrl: v.verificationUrl, userCode: v.userCode, expiresAt: v.expiresAt })),
      awsGrants,
      awsPending,
      // The aws-* capability the session holds, so the page follows a grant landing after sign-in or ending at expiry.
      awsHeld: live.ok ? live.session.capabilities.filter(isAwsCapabilityId) : [],
      // Held capabilities Claws granted automatically, for the page's status line.
      autoGranted: (await listAutoGrantedCapabilities(id))
        .filter((r) => !live.ok || live.session.capabilities.includes(r.capability))
        // Only a browser grant relaunches the agent; the page follows the restart for a grant it sees land.
        .map((r) => ({ capability: r.capability, label: capabilityLabel(r.capability), reason: r.reason, decidedAt: r.decidedAt, restarted: r.capability === BROWSER_CAPABILITY_ID })),
      ...(live.ok ? { summary: live.session.summary, pageTitle: sessionPageTitle(live.session) } : {}),
    });
  });

  // `code` tells the dashboard a request that is already gone ("no-request",
  // drop its banner) from a grant that failed ("session-not-found", show it).
  const decideCapabilityRequestHandler = (approve: boolean) => async (c: Ctx) => {
    const id = c.req.param("id") ?? "";
    const capability = c.req.param("cap") ?? "";
    if (!/^[a-f0-9]+$/.test(id)) return jsonOk(c, { error: "Not found" }, 404);
    if (approve && isAwsCapabilityId(capability)) {
      // Approval starts Claws' AWS sign-in; the request stays pending until the grant lands (#clw_01M8426RTMG1TWE224NXW1V02S).
      const entry = await getCapabilityRequest(id, capability);
      if (!entry) return jsonOk(c, { error: "No such capability request", code: "no-request" }, 404);
      if (entry.status !== "pending") return jsonOk(c, { error: "This request has already been decided" }, 409);
      return signInResponse(c, capability, await startSignIn(id, capability, operatorName()));
    }
    // A deny also ends an AWS sign-in already under way for the request, so a stale approval cannot still grant.
    if (!approve && isAwsCapabilityId(capability)) await cancelAwsSignIns(id, capability, "declined");
    const result = await decideCapabilityRequest(id, capability, approve);
    if (result.ok) {
      return jsonOk(c, result.grant
        ? { ...describeGrantedCapability(capability, result.grant, result.request), ...agentNoticeFields(result) }
        : describeCapabilityRequest(result.request));
    }
    if (result.reason === "grant-failed") {
      const { grant } = result;
      if (grant.reason === "invalid") return jsonOk(c, { error: grant.detail }, 400);
      if (grant.reason === "unavailable") return runtimeUnavailable(c, grant.detail);
      return jsonOk(c, { error: "Session not found — it may have ended", code: "session-not-found" }, 404);
    }
    if (result.reason === "not-pending") return jsonOk(c, { error: "This request has already been decided" }, 409);
    return jsonOk(c, { error: "No such capability request", code: "no-request" }, 404);
  };

  // Operator-only: never `apiAuthMiddleware`, or an agent could approve its own request.
  app.post("/sessions/:id/capability-requests/:cap/approve", authMiddleware, decideCapabilityRequestHandler(true));
  app.post("/sessions/:id/capability-requests/:cap/deny", authMiddleware, decideCapabilityRequestHandler(false));

  // Read-only snapshot of a live session's visible screen for the Sessions list's
  // inline preview (#clw_01M6K7717TJFWCHGQC7MAC4SXS). Polled, never attached, so
  // the operator's own terminal is never resized. Operator only.
  app.get("/sessions/:id/screen", authMiddleware, async (c) => {
    const id = c.req.param("id");
    if (!/^[a-f0-9]+$/.test(id)) return jsonOk(c, { error: "Not found" }, 404);
    const screen = await getSessionBackend().fetchScreen(id);
    if (screen.ok) return jsonOk(c, { cols: screen.cols, rows: screen.rows, data: screen.data });
    if (screen.reason === "unsupported") {
      return jsonOk(c, { error: "This session's runtime predates the terminal preview", code: "unsupported" }, 404);
    }
    if (screen.reason === "unavailable") return runtimeUnavailable(c, screen.detail);
    return jsonOk(c, { error: "Session not found" }, 404);
  });

  // Chat view feed (#clw_01M7DYJ0WVGSM09PFTBS3HXDB3): the next increment of the
  // live Claude Code transcript, normalised into chat events here rather than in
  // the pod. `file`/`offset` echo the previous reply's `file`/`next`. Operator only.
  app.get("/sessions/:id/transcript", authMiddleware, async (c) => {
    const id = c.req.param("id");
    if (!/^[a-f0-9]+$/.test(id)) return jsonOk(c, { error: "Not found" }, 404);
    const fileParam = c.req.query("file");
    const offsetParam = c.req.query("offset");
    const file = fileParam && /^[A-Za-z0-9._-]{1,200}$/.test(fileParam) ? fileParam : null;
    const offset = offsetParam && /^\d{1,15}$/.test(offsetParam) ? Number(offsetParam) : null;
    const result = await getSessionBackend().fetchTranscript(id, { file, offset });
    if (result.ok) {
      if (!result.transcript) return c.body(null, 204);
      const { transcript } = result;
      return jsonOk(c, {
        file: transcript.file,
        next: transcript.next,
        truncatedBefore: transcript.truncatedBefore,
        events: normalizeTranscriptLines(transcript.lines),
      });
    }
    if (result.reason === "unsupported") {
      return jsonOk(c, { error: "This session's runtime predates the chat view", code: "unsupported" }, 404);
    }
    if (result.reason === "unavailable") return runtimeUnavailable(c, result.detail);
    return jsonOk(c, { error: "Session not found" }, 404);
  });

  // Chat view composer: paste `{ text }` (multi-line allowed) into the agent pane and submit it. Operator only.
  app.post(
    "/sessions/:id/input",
    authMiddleware,
    bodyLimit({
      // JSON escaping can grow the pod's 64 KiB text cap up to sixfold.
      maxSize: CHAT_INPUT_MAX_BYTES * 6 + 1024,
      onError: (c) => jsonOk(c, { error: "Input too large" }, 413),
    }),
    async (c) => {
      const id = c.req.param("id");
      if (!/^[a-f0-9]+$/.test(id)) return jsonOk(c, { error: "Not found" }, 404);
      let body: unknown;
      try { body = await c.req.json(); } catch { return jsonOk(c, { error: "Invalid JSON body" }, 400); }
      const text = (body as { text?: unknown } | null)?.text;
      if (typeof text !== "string" || text.trim() === "") return jsonOk(c, { error: "text must be a non-blank string" }, 400);
      const bytes = Buffer.byteLength(text, "utf8");
      if (bytes > CHAT_INPUT_MAX_BYTES) return jsonOk(c, { error: `text must be at most ${CHAT_INPUT_MAX_BYTES / 1024} KiB` }, 413);
      const result = await getSessionBackend().sendAgentInput(id, text);
      if (result.ok) {
        log.info("Chat input sent", { component: "sessions", session_id: id, bytes });
        return c.body(null, 204);
      }
      log.warn("Chat input failed", { component: "sessions", session_id: id, bytes, reason: result.reason, detail: "detail" in result ? result.detail : undefined });
      if (result.reason === "unsupported") {
        return jsonOk(c, { error: "This session's runtime predates the chat view", code: "unsupported" }, 404);
      }
      if (result.reason === "unavailable") return runtimeUnavailable(c, result.detail);
      return jsonOk(c, { error: "Session not found" }, 404);
    },
  );

  // Self-reported agent status (#3083), set by the session's `claws_set_session_status` MCP tool.
  const setAgentStatusHandler = async (c: Ctx) => {
    const id = c.req.param("id") ?? "";
    if (!/^[a-f0-9]+$/.test(id)) return jsonOk(c, { error: "Not found" }, 404);
    let body: unknown;
    try { body = await c.req.json(); } catch { return jsonOk(c, { error: "Invalid JSON body" }, 400); }
    const status = (body as { status?: unknown } | null)?.status;
    if (!isSessionAgentStatus(status)) {
      return jsonOk(c, { error: `status must be one of ${SESSION_AGENT_STATUSES.join(", ")}` }, 400);
    }
    const result = await getSessionBackend().setAgentStatus(id, status);
    if (!result.ok) return jsonOk(c, { error: "Session not found" }, 404);
    return jsonOk(c, { status: result.status, updatedAt: result.updatedAt });
  };

  app.post("/api/sessions/:id/status", apiAuthMiddleware, setAgentStatusHandler);

  app.post("/sessions/:id/resummarize", authMiddleware, async (c) => {
    const id = c.req.param("id");
    if (!/^[a-f0-9]+$/.test(id)) return jsonOk(c, { error: "Not found" }, 404);
    const result = await getSessionBackend().resummarize(id);
    if (!result.ok) return jsonOk(c, { error: "Session not found or not running" }, 404);
    return jsonOk(c, { description: result.description });
  });

  app.post(
    "/sessions/:id/upload",
    authMiddleware,
    // Enforce the cap while the body streams in — a chunked request has no
    // Content-Length to check, so without this the whole payload would be
    // buffered by parseBody() before the backend's saveUpload() could reject it.
    // Slack of 4096 bytes covers multipart boundary/header framing around an
    // exactly-MAX_UPLOAD_BYTES file; the true per-file cap is still enforced
    // where the session pod stores the file.
    bodyLimit({
      maxSize: MAX_UPLOAD_BYTES + 4096,
      onError: (c) => {
        c.header("Content-Type", "application/json");
        return c.body(JSON.stringify({ error: "File too large (max 10 MB)" }), 413);
      },
    }),
    async (c) => {
      const id = c.req.param("id");
      if (!/^[a-f0-9]+$/.test(id)) return jsonOk(c, { error: "Not found" }, 404);
      const live = await checkUploadTarget(c, id);
      if (live) return live;
      let file: unknown;
      try {
        file = (await c.req.parseBody())["file"];
      } catch (err) {
        return jsonOk(c, { error: `Malformed upload: ${String(err)}` }, 400);
      }
      if (!(file instanceof File)) return jsonOk(c, { error: "Missing file field" }, 400);
      const buf = Buffer.from(await file.arrayBuffer());
      const result = await getSessionBackend().saveUpload(id, file.name, buf);
      if (!result.ok) return uploadErrorResponse(c, result, "10 MB");
      log.info(`[server] Session ${id}: stored upload ${result.path} (${buf.byteLength} bytes)`);
      if (isAudioUpload(file.name, file.type)) {
        if (!transcribeAvailable()) {
          return jsonOk(c, { path: result.path, transcriptError: "Transcription is not configured (set CLAWS_WHISPER_LOCAL_URL, CLAWS_WHISPER_BASE_URL or OPENAI_API_KEY)" });
        }
        try {
          const text = (await transcribe(buf, file.name || "voice-note.ogg", voiceVocabularyPrompt(await listRepos()))).trim();
          if (!text) {
            return jsonOk(c, { path: result.path, transcriptError: "Transcription produced no text" });
          }
          log.info(`[server] Session ${id}: transcribed ${file.name} (${text.length} chars)`);
          return jsonOk(c, { path: result.path, transcript: text });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          log.warn(`[server] Session ${id}: transcription failed for ${file.name}: ${message}`);
          return jsonOk(c, { path: result.path, transcriptError: `Transcription failed: ${message}` });
        }
      }
      return jsonOk(c, { path: result.path });
    },
  );

  app.post("/sessions/:id/upload-stream", authMiddleware, async (c) => {
    const id = c.req.param("id");
    if (!/^[a-f0-9]+$/.test(id)) return jsonOk(c, { error: "Not found" }, 404);

    // Fast reject before reading a byte (or looking up the session) when the
    // client declares an over-cap size.
    const declared = Number(c.req.header("content-length") ?? "");
    if (Number.isFinite(declared) && declared > MAX_LARGE_UPLOAD_BYTES) {
      return jsonOk(c, { error: "File too large (max 1 GB)" }, 413);
    }

    const live = await checkUploadTarget(c, id);
    if (live) return live;

    const body = c.req.raw.body;
    if (!body) return jsonOk(c, { error: "Missing request body" }, 400);
    const name = c.req.query("name") ?? "upload";

    const result = await getSessionBackend().saveUploadStream(
      id,
      name,
      Readable.fromWeb(body as unknown as import("node:stream/web").ReadableStream<Uint8Array>),
    );
    if (!result.ok) return uploadErrorResponse(c, result, "1 GB");
    log.info(`[server] Session ${id}: stored streamed upload ${result.path}`);
    return jsonOk(c, { path: result.path });
  });

  // Files attached on a New Session form, staged before the session exists
  // (session-attachments.ts). Same limits and wording as the upload routes above.
  app.post(
    "/sessions/attachments",
    authMiddleware,
    bodyLimit({
      maxSize: MAX_UPLOAD_BYTES + 4096,
      onError: (c) => {
        c.header("Content-Type", "application/json");
        return c.body(JSON.stringify({ error: "File too large (max 10 MB)" }), 413);
      },
    }),
    async (c) => {
      await sweepPendingSessionAttachments();
      let file: unknown;
      try {
        file = (await c.req.parseBody())["file"];
      } catch (err) {
        return jsonOk(c, { error: `Malformed upload: ${String(err)}` }, 400);
      }
      if (!(file instanceof File)) return jsonOk(c, { error: "Missing file field" }, 400);
      if (file.size === 0) return jsonOk(c, { error: `${file.name}: empty file or folder — not uploaded` }, 400);
      const result = await stageSessionAttachment(file.name, Buffer.from(await file.arrayBuffer()), file.type);
      if (!result.ok) return jsonOk(c, { error: describeUploadError(result, "10 MB") }, result.reason === "too-large" ? 413 : 500);
      log.info(`[server] Staged session attachment ${result.row.id} (${result.row.size} bytes)`);
      return jsonOk(c, { attachment: { id: result.row.id, name: result.row.filename, size: result.row.size } });
    },
  );

  app.post("/sessions/attachments/stream", authMiddleware, async (c) => {
    const declared = Number(c.req.header("content-length") ?? "");
    if (Number.isFinite(declared) && declared > MAX_LARGE_UPLOAD_BYTES) {
      return jsonOk(c, { error: "File too large (max 1 GB)" }, 413);
    }
    await sweepPendingSessionAttachments();
    const body = c.req.raw.body;
    if (!body) return jsonOk(c, { error: "Missing request body" }, 400);
    const name = c.req.query("name") ?? "upload";
    const result = await stageSessionAttachmentStream(
      name,
      Readable.fromWeb(body as unknown as import("node:stream/web").ReadableStream<Uint8Array>),
      c.req.header("content-type"),
    );
    if (!result.ok) {
      if (result.detail === "empty file") return jsonOk(c, { error: `${name}: empty file or folder — not uploaded` }, 400);
      return jsonOk(c, { error: describeUploadError(result, "1 GB") }, result.reason === "too-large" ? 413 : 500);
    }
    log.info(`[server] Staged streamed session attachment ${result.row.id} (${result.row.size} bytes)`);
    return jsonOk(c, { attachment: { id: result.row.id, name: result.row.filename, size: result.row.size } });
  });

  // Removes a still-pending staged file; one a session has claimed is the session's.
  app.post("/sessions/attachments/:attachmentId/delete", authMiddleware, async (c) => {
    const id = c.req.param("attachmentId");
    const pending = isSessionAttachmentId(id) ? await findPendingSessionAttachments([id]) : null;
    if (!pending) return jsonOk(c, { error: "Attachment not found" }, 404);
    await deleteSessionAttachment(id);
    return jsonOk(c, { ok: true });
  });

  app.post("/logs/:runId/cancel", authMiddleware, async (c) => {
    const runId = c.req.param("runId");
    if (!await getJobRun(runId)) {
      return jsonOk(c, { error: "Run not found" }, 404);
    }
    const cancelled = await cancelJobRunIfRunning(runId);
    if (!cancelled) {
      return jsonOk(c, { result: "not-running" });
    }
    // The run is already marked cancelled; `queued` means its agent is killed once the controller answers.
    return jsonOk(c, { result: await controller.cancelRun(runId) });
  });
}
