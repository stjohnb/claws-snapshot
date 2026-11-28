/** Kanban board routes: board pages and moves, approvals, infra and merge approval, start-session and the backlog. Moved out of `registerRoutes` (src/server.ts) unchanged. */
import type { ContentfulStatusCode } from "hono/utils/http-status";
import * as config from "../../config.js";
import { listRepos, listPRs, listPRStatuses, type PRRepoStatus, type StaleReadOptions, listOpenIssues, getPRState, getPRChangedFiles, getPRDiff, getTofuPlanEvidence, getPRHeadSHA, infraPathsIn, isNativeIssue, awaitingImportReason, isDependencyBotAuthor, type PR } from "../../github.js";
import { LABELS } from "../../config.js";
import { ciFixerGaveUpOnHead } from "../../github.js";
import * as planParser from "../../plan-parser.js";
import { issuesAwaitingOperator } from "../../awaiting-operator.js";
import { hasManualAction, isProblematic, type InfraMergeApprovedEvidence } from "../../pr-state.js";
import { infraApprovalNeed, infraWorkflowDiffDigest, isInfraWorkflowPath, noopMergeDiffVerdict, tofuPlanFingerprint } from "../../tofu-plan.js";
import { listExplicitIssueModelPlanRows, getClawsPr, listOpenClawsPrs, listActivePrWork, getIssueBlockedReasons, getIssueBacklogUntil, listPendingReapprovalIssueIds, listRequirementsApprovedIssueIds, listIssueInfraDeclarations, upsertClawsPr, listLiveBoardStartedSessions, listLivePrStartedSessions, type ClawsPrRecord, type IssueModelPlanRow } from "../../db.js";
import * as log from "../../log.js";
import { attemptMerge, isRenovateExempt, MERGE_BLOCKING_AGENT_KINDS } from "../../agents/auto-merger.js";
import * as issueImporter from "../../jobs/issue-importer.js";
import { resolvePRStatus, type PRRowStatus } from "../../pages/pr-status.js";
import { summarizeModelPlanCells } from "../../model-plan.js";
import { buildBoardPage, infraPrLine, renderBoardRefresh, type BoardCard, type BoardCardPr, type BoardPageView } from "../../pages/board.js";
import { loadPrAttention, prAttentionKey } from "../../pr-attention.js";
import { loadDependencyGraph } from "../../dependency-graph.js";
import { renderDependencyGraph } from "../../pages/dependency-graph.js";
import { buildBacklogPage, parseBacklogQuery, type BacklogRow } from "../../pages/backlog.js";
import { applyIssueApproval, readIssueApproval } from "../../issue-approval-write.js";
import { atLeast, maxApproval, withdrawMergeTarget, type ApprovedThrough } from "../../issue-approval.js";
import { deriveApprovalTrack, renderApprovalTrack } from "../../pages/approval-track.js";
import { BACKLOG_DESTINATION, columnFor, DONE_COLUMN_LIMIT, DONE_WINDOW_HOURS } from "../../issue-board.js";
import { flightKey, loadBoardFlights, loadIssueFlight } from "../../issue-flight.js";
import { type IssueLifecycle } from "../../issue-lifecycle.js";
import * as clawsIssues from "../../claws-issues.js";
import { issuesOverlapHeld, issuesQueued } from "../../queued-issues.js";
import { loadOperatorAttentionCounts } from "../../operator-attention.js";
import { canonicalIssueRef, isClawsIssueId } from "../../issue-id.js";
import { displayBlockedReason } from "../../blocked-reason.js";
import { renderMarkdown } from "../../markdown.js";
import { describeCreateSessionError, createSessionErrorStatus } from "../../sessions.js";
import { getSessionBackend } from "../../session-backend.js";
import { buildPrOpeningMessage, buildPrSessionBrief, prSessionRef, prSessionTitle, type PrSessionFocus } from "../../session-brief.js";
import { escapeHtml } from "../../pages/layout.js";
import { mapWithConcurrency, mapSettledWithConcurrency } from "../../util.js";
import type { ClawsIssueRecord, ClawsIssueRequirementsRow, IssueInfraDeclarations } from "../../db.js";
import { destroyConsentView } from "../../destroy-consent.js";
import { type BoardRefusalIds, boardRefusal, getTheme, htmlError, htmlOk, jsonOk, parseFormBody, parseFormBodyMulti, readTextBody } from "../http.js";
import { authMiddleware, sessionSubject } from "../auth.js";
import { ApproveThroughSchema, BULK_MOVE_LIMIT, BoardAutomergeSchema, BoardBulkMoveSchema, BoardInfraApproveSchema, BoardMergeApproveSchema, BoardMoveSchema, BoardStartSessionSchema, type GateWriteResult, INFRA_NEED_WORDS, RepoPrNumberSchema, boardCardPr, findConfiguredRepo, isConfiguredRepo, loadPRRowStatuses, manualWarningFor, writeMergeApproval } from "../shared.js";
import { promoteNative, applyBoardMove } from "../issue-actions.js";
import { loadApprovalTrackInput, checkedApproval, loadLatestPlans, planPreviewFor, ideaPreviewFor } from "../approval-actions.js";
import { sessionFormDefaultsFor, startIssueSession } from "../session-actions.js";
import { Hono } from "hono";
import type { Env } from "../http.js";
import type { RouteContext } from "./context.js";

export function registerBoardRoutes(app: Hono<Env>, ctx: RouteContext): void {
  const { controller } = ctx;
  // ── Kanban board (docs/issue-tracker.md#board) ──
  //
  // A column is derived from the issue's labels on every render, never stored,
  // so the board and the pipeline cannot disagree. `/board/move` is the inverse
  // map: it applies the labels that put an issue in the column it was dropped
  // into, through the same façade the /issues row buttons use.
  //
  // `operator-attention.ts` repeats this route's column-input assembly for the
  // nav's Issues count; a change to how a card's column is derived here must
  // be mirrored there.

  // Everything the board renders, for `/board` and for its poller's
  // `/api/board`; `repoFilter` is `?repo=`, `""` for every repository. `/board`
  // passes `staleOk` so a reload renders from cached forge lists; the poller
  // stays strict like every `/api` path.
  async function loadBoardView(repoFilter: string, opts?: StaleReadOptions): Promise<BoardPageView> {
    const repos = await listRepos();
    const plans = await loadLatestPlans("board");
    // The requirements columns and Planning carry no label: a forge card's
    // stage comes off its shadow. A card in `ideas` sits in Requirements review
    // when its latest requirements version has no human feedback since, and in
    // Drafting otherwise — read here on every render, so a comment moves the
    // card back with no edit to the issue. All best-effort — a failed
    // requirements read costs the chip and puts every `ideas` card in Drafting,
    // a failed feedback read leaves cards with a version in Requirements
    // review, and a failed shadow read puts forge cards in Drafting.
    // A held stage-off issue (`clawsIssues.heldWithoutWriter`) with no version
    // also sits in Requirements review, on its own text: no writer run will
    // ever give it one (#clw_01M6P1JF7XH07J2VKCGSZ5NVVB). A failed read of
    // those ids leaves them in Drafting.
    const [shadowStages, requirements, heldWithoutWriter] = await Promise.all([
      clawsIssues.getOpenShadowStages().catch((err) => { log.warn(`[board] shadow stages: ${err}`); return new Map<string, { id: string; lifecycle: IssueLifecycle; approvedThrough: ApprovedThrough; hasPlannedPrs: boolean }>(); }),
      clawsIssues.getLatestRequirementsForOpenIssues().catch((err) => { log.warn(`[board] requirements: ${err}`); return null; }),
      clawsIssues.getHeldWithoutWriterOpenIssueIds().catch((err) => { log.warn(`[board] held issues: ${err}`); return new Set<string>(); }),
    ]);
    const feedbackPending = requirements === null
      ? new Set<string>()
      : await clawsIssues.getRequirementsFeedbackPending(requirements).catch((err) => { log.warn(`[board] requirements feedback: ${err}`); return new Set<string>(); });
    const requirementsReview = (trackerId: string | undefined): boolean => {
      if (!trackerId) return false;
      if (requirements?.has(trackerId)) return !feedbackPending.has(trackerId);
      return requirements !== null && heldWithoutWriter.has(trackerId);
    };
    const requirementsVersion = (trackerId: string | undefined): number | null | undefined =>
      requirements === null ? undefined : (trackerId ? requirements.get(trackerId)?.version ?? null : null);
    const requirementsRow = (trackerId: string | undefined): ClawsIssueRequirementsRow | undefined =>
      trackerId ? requirements?.get(trackerId) : undefined;
    // The board's cheap has-a-plan hint for the plan rule's pre-flight — no
    // per-card comment fetch. A native card has a stored plan version; a forge
    // card's shadow is in `awaiting-plan-review` (set when a plan is posted),
    // or has a stored PR list. `/board/move` re-checks against the real plan
    // either way.
    const hasPlanHint = (ref: config.IssueRef, shadow?: { lifecycle: IssueLifecycle; hasPlannedPrs: boolean }): boolean =>
      isNativeIssue(ref)
        ? plans.has(String(canonicalIssueRef(ref)))
        : shadow?.lifecycle === "awaiting-plan-review" || !!shadow?.hasPlannedPrs;
    const since = new Date(Date.now() - DONE_WINDOW_HOURS * 60 * 60 * 1000);
    // Each open forge card's tracker id, keyed by `flightKey`, for the
    // awaiting-operator read below; a native card's ref is its own.
    const cardTrackerIds = new Map<string, string>();
    // One repository's API failure must not empty the whole board — but a
    // silently short board reads as an empty backlog, so the count of sources
    // that came back incomplete is rendered with it. A fetch that failed and
    // one that hit the open-issue cap are the same thing to a reader: cards
    // that should be on the board are not.
    const incomplete = new Set<string>();
    const orNone = (source: string) => (err: unknown): never[] => {
      log.warn(`[board] ${source}: ${err}`);
      incomplete.add(source);
      return [];
    };
    const perRepo = await mapWithConcurrency(repos, 8, async (r) => {
      const [open, closed] = await Promise.all([
        listOpenIssues(r.fullName, opts).catch(orNone(r.fullName)),
        // Only native issues fill the Done column: a forge's closed issues
        // would cost an extra API round trip per repo on every page load, and
        // the forge already shows them.
        clawsIssues.listClosedIssuesSince(r.fullName, since, DONE_COLUMN_LIMIT).catch(orNone(r.fullName)),
      ]);
      // A dependency bot's tracking issue (Renovate's Dependency Dashboard) is
      // never imported, so it stays on the forge — but it is not work, and
      // must not sit in Drafting.
      const work = open.filter((issue) => isNativeIssue(issue.number) || !isDependencyBotAuthor(issue));
      const cards: BoardCard[] = work.map((issue) => {
        const shadow = issue.lifecycle ? undefined : shadowStages.get(`${r.fullName}\u0000${String(issue.number)}`);
        const trackerId = isNativeIssue(issue.number) ? String(canonicalIssueRef(issue.number)) : shadow?.id;
        if (trackerId) cardTrackerIds.set(flightKey(r.fullName, issue.number), trackerId);
        // A forge issue the importer has not moved yet has no plan anyone can
        // review: no agent acts on it until it is native, so whatever its
        // forge labels say, the card offers no plan gate.
        const awaitingImport = awaitingImportReason(r.fullName, issue) !== null;
        return {
        repo: r.fullName,
        ref: issue.number,
        title: issue.title,
        labels: issue.labels.map((l) => l.name),
        lifecycle: issue.lifecycle ?? shadow?.lifecycle,
        approvedThrough: issue.approvedThrough ?? shadow?.approvedThrough ?? "none",
        requirementsVersion: requirementsVersion(trackerId),
        requirementsReview: requirementsReview(trackerId),
        url: config.issueUrl(r.fullName, issue.number),
        plan: awaitingImport ? undefined : planPreviewFor(issue.number, plans),
        hasPlan: awaitingImport ? false : hasPlanHint(issue.number, shadow),
        ...(awaitingImport ? { awaitingImport, importHold: issueImporter.importHoldReason(r.fullName, String(issue.number)) } : {}),
        idea: ideaPreviewFor(requirementsRow(trackerId), issue.body, config.issueUrl(r.fullName, issue.number)),
        updatedAt: issue.updatedAt,
        // Native issues only; a forge card's age chip approximates from `updatedAt`.
        stageSince: issue.stageSince,
        ...(issue.boardColumn && issue.boardColumnAt ? { boardColumn: issue.boardColumn, boardColumnAt: issue.boardColumnAt } : {}),
        repos: issue.repos,
        };
      });
      // The closed cards are kept apart with the time they were closed: the
      // query's limit is per repository, so the column is bounded globally
      // below rather than at 50 × however many repositories Claws manages.
      const done = closed.map((record) => ({
        closedAt: record.closed_at ?? "",
        card: {
          repo: r.fullName,
          ref: record.id,
          title: record.title,
          labels: record.labels,
          closed: true,
          stateReason: record.state_reason ?? undefined,
          url: config.issueUrl(r.fullName, record.id),
          updatedAt: clawsIssues.toIso(record.updated_at),
          stageSince: record.closed_at ? clawsIssues.toIso(record.closed_at) : undefined,
          repos: [...record.repos].sort(),
        } satisfies BoardCard,
      }));
      return { cards, done };
    });
    // Newest first across every repository, then cut to the one bound the
    // 8-hour window is paired with — the same order `listClosedIssuesSince`
    // applies within a repository, so the column reads the same either way.
    //
    // `?repo=` is applied here rather than only in `buildBoardPage`, which
    // filters what it is handed: cutting the merged list first would hand a
    // filtered board whatever few of that repository's cards survived a global
    // top-50 spread across every other one — possibly none, with nothing on the
    // page to say cards were dropped. Filtering first makes the cap bound the
    // column that is actually rendered. Every other column is unfiltered here
    // because nothing cuts it.
    const done = perRepo
      .flatMap((r) => r.done)
      .filter((d) => !repoFilter || d.card.repo === repoFilter || d.card.repos?.includes(repoFilter))
      .sort((a, b) => (a.closedAt < b.closedAt ? 1 : a.closedAt > b.closedAt ? -1 : 0))
      .slice(0, DONE_COLUMN_LIMIT)
      .map((d) => d.card);
    // Native issues with no repo never come through listOpenIssues, which
    // lists an issue under its primary repo; they sit in Drafting until one
    // is assigned. A multi-repo issue is a normal card under its primary repo, and matches the `?repo=` filter for every repo it names.
    const unassigned: BoardCard[] = (await clawsIssues.listUnassignedOpenIssues().catch(orNone("unassigned issues"))).map((issue) => ({
      repo: "",
      ref: issue.id,
      title: issue.title,
      labels: issue.labels,
      lifecycle: issue.lifecycle,
      approvedThrough: issue.approved_through ?? "none",
      requirementsVersion: requirementsVersion(issue.id),
      requirementsReview: requirementsReview(issue.id),
      url: config.issueUrl("", issue.id),
      plan: planPreviewFor(issue.id, plans),
      hasPlan: hasPlanHint(issue.id),
      idea: ideaPreviewFor(requirementsRow(issue.id), issue.body, config.issueUrl("", issue.id)),
      updatedAt: clawsIssues.toIso(issue.updated_at),
      stageSince: clawsIssues.toIso(issue.stage_changed_at ?? issue.updated_at),
      ...(issue.board_column && issue.board_column_at ? { boardColumn: issue.board_column, boardColumnAt: clawsIssues.toIso(issue.board_column_at) } : {}),
    }));
    // Operator-set model-plan cells, summarised on the card. Best-effort: a
    // failed read costs the summary line, not the board. An unassigned card has
    // no repo to key on, so it matches its native id in any repo — a `clw_…`
    // id is unique fleet-wide.
    const explicitPlans = new Map<string, IssueModelPlanRow[]>();
    for (const row of await listExplicitIssueModelPlanRows().catch((err) => { log.warn(`[board] model plans: ${err}`); return []; })) {
      for (const key of [`${row.repo}\u0000${row.issue_ref}`, `\u0000${row.issue_ref}`]) {
        explicitPlans.set(key, [...(explicitPlans.get(key) ?? []), row]);
      }
    }
    const withModelPlan = (card: BoardCard): BoardCard => {
      const summary = summarizeModelPlanCells(explicitPlans.get(`${card.repo}\u0000${card.ref}`) ?? []);
      return summary ? { ...card, modelPlan: summary } : card;
    };
    const boardSessions = await listLiveBoardStartedSessions().catch((err) => { log.warn(`[board] active sessions: ${err}`); return new Map<string, string>(); });
    const prSessions = await listLivePrStartedSessions().catch((err) => { log.warn(`[board] active PR sessions: ${err}`); return new Map<string, string>(); });
    const withActiveSession = (card: BoardCard): BoardCard => {
      const id = boardSessions.get(String(card.ref));
      return id ? { ...card, activeSession: id } : card;
    };
    // Backlog cards are off the board (#3293): split out here so they never
    // render; `/backlog` lists them. Open cards only — Done is closed, and
    // `columnFor` reads `closed` first.
    // The collapsed Backlog tray shows how many there are under `?repo=`.
    const onBoard: BoardCard[] = [];
    let backlogCount = 0;
    const backlogNativeIds: string[] = [];
    for (const card of [...perRepo.flatMap((r) => r.cards), ...unassigned]) {
      if (columnFor({ labels: card.labels, unassigned: !card.repo }) !== BACKLOG_DESTINATION) onBoard.push(card);
      else if (!repoFilter || card.repo === repoFilter || card.repos?.includes(repoFilter)) {
        backlogCount++;
        if (isClawsIssueId(card.ref)) backlogNativeIds.push(String(card.ref));
      }
    }
    // The tray names the nearest day a parked issue comes back.
    const backlogNextReturn = [...(await getIssueBacklogUntil(backlogNativeIds)
      .catch((err) => { log.warn(`[board] backlog return dates: ${err}`); return new Map<string, string>(); })).values()]
      .sort()[0] ?? null;
    // The derived columns (In progress, Awaiting merge) read each
    // open card's running implementer and open `claws_prs` rows. Best-effort
    // inside `loadBoardFlights`: a failed read leaves cards out of flight
    // rather than failing the page. Backlog outranks flight in `columnFor`, so
    // the split above needs none of it.
    const flights = await loadBoardFlights(onBoard);
    // An issue whose every PR step has merged and whose plan's operator step
    // is open sits in Awaiting merge with an "Awaiting operator" chip.
    const trackerIdOf = (card: BoardCard): string | undefined =>
      card.repo ? cardTrackerIds.get(flightKey(card.repo, card.ref)) : String(card.ref);
    const onBoardIds = onBoard.map(trackerIdOf).filter((id): id is string => !!id);
    const awaitingOperator = await issuesAwaitingOperator(onBoardIds)
      .catch((err) => { log.warn(`[board] awaiting operator: ${err}`); return new Map<string, { position: number; title: string }>(); });
    // Why Claws parked a Blocked card for a human, shown on the card.
    const blockedReasons = await getIssueBlockedReasons(onBoardIds)
      .catch((err) => { log.warn(`[board] blocked reasons: ${err}`); return new Map<string, string>(); });
    // A Blocked card only waiting on other work in flight is in Queued, with
    // what it waits on. Best-effort inside `issuesQueued`.
    const queued = await issuesQueued(onBoardIds);
    // An approved card whose every ready step waits on overlapping work ahead
    // of it (overlap-gate.ts) is in Queued, or keeps its PR column, with what
    // it waits on and a Start anyway button. Only approved native cards can be
    // held, so only theirs are read. Best-effort inside `issuesOverlapHeld`.
    const overlapCandidates = onBoard.filter((card) => isClawsIssueId(card.ref) && card.lifecycle === "awaiting-plan-review"
      && atLeast(card.approvedThrough ?? "none", "plan") && !card.labels.includes(LABELS.blocked) && !card.labels.includes(LABELS.backlog));
    const overlapRecords = (await Promise.all(overlapCandidates.map((card) => clawsIssues.getIssue(String(card.ref)).catch(() => undefined))))
      .filter((r): r is ClawsIssueRecord => !!r);
    const overlapHeld = await issuesOverlapHeld(overlapRecords);
    // A design change waiting for re-approval puts its card in Awaiting plan
    // review with a "Needs decision" chip. Best-effort, like the flight.
    const reapprovalPending = await listPendingReapprovalIssueIds(onBoardIds)
      .catch((err) => { log.warn(`[board] pending re-approvals: ${err}`); return new Set<string>(); });
    // Approved requirements fill the approval track's Reqs gate.
    // Best-effort: a failed read leaves the gate to the column.
    const approvedRequirements = await listRequirementsApprovedIssueIds(onBoardIds)
      .catch((err) => { log.warn(`[board] approved requirements: ${err}`); return new Set<string>(); });
    // The planned PRs' declared infra changes, for the card's destroy consent
    // block. Best-effort, like the rest.
    const infraDeclarations = await listIssueInfraDeclarations(onBoardIds)
      .catch((err) => { log.warn(`[board] infra declarations: ${err}`); return new Map<string, IssueInfraDeclarations>(); });
    // Overlay each open PR row with the same cached bulk status the repo page
    // and All PRs read, so the card's chips agree with them. A repository
    // whose fetch fails gets no overlay and its chips read the stored stage.
    // Which open PRs need the operator (`pr-attention.ts`, the rule `/prs` and
    // the nav PRs count share): every flight PR plus every open row in a
    // configured repo, so a flagged PR on no open card gets a PR card.
    // Best-effort: a failed read costs the Needs-you lines and PR cards.
    const configuredRepos = new Set(repos.map((r) => r.fullName));
    const openRows = await listOpenClawsPrs().catch((err) => { log.warn(`[board] open PRs: ${err}`); return [] as ClawsPrRecord[]; });
    const attentionRows = new Map<string, ClawsPrRecord>();
    for (const row of [...openRows.filter((r) => configuredRepos.has(r.repo)), ...[...flights.values()].flatMap((f) => f.openPrs)]) {
      attentionRows.set(prAttentionKey(row.repo, row.prNumber), row);
    }
    const prAttention = await loadPrAttention([...attentionRows.values()])
      .catch((err) => { log.warn(`[board] PR attention: ${err}`); return new Map<string, string[]>(); });
    // The merge-blocking jobs queued or running per PR, so an infra line reads in progress rather than asking for approval.
    const activeWork = await listActivePrWork(MERGE_BLOCKING_AGENT_KINDS)
      .catch((err) => { log.warn(`[board] active PR work: ${err}`); return new Map<string, string>(); });
    // A flagged PR listed on an open card shows there; any other gets its own card.
    const onCardPrs = new Set([...flights.values()].flatMap((f) => f.openPrs.map((pr) => prAttentionKey(pr.repo, pr.prNumber))));
    const prCardRows = [...attentionRows.values()].filter((row) => prAttention.has(prAttentionKey(row.repo, row.prNumber))
      && !onCardPrs.has(prAttentionKey(row.repo, row.prNumber))
      && (!repoFilter || row.repo === repoFilter));
    const prRepos = [...new Set([...[...flights.values()].flatMap((f) => f.openPrs.map((pr) => pr.repo)), ...prCardRows.map((row) => row.repo)])];
    const liveStatuses = new Map<string, Map<number, PRRepoStatus>>();
    await mapSettledWithConcurrency(prRepos, 8, async (repo) => {
      liveStatuses.set(repo, await listPRStatuses(repo, opts));
    });
    const withAttention = (pr: BoardCardPr): BoardCardPr => {
      const reasons = prAttention.get(prAttentionKey(pr.repo, pr.prNumber));
      return reasons ? { ...pr, attention: reasons } : pr;
    };
    const withFlight = (card: BoardCard): BoardCard => {
      const trackerId = trackerIdOf(card);
      const step = trackerId ? awaitingOperator.get(trackerId) : undefined;
      if (step) {
        // Same sources as the `claws-awaiting-operator` comment: the step's title and the plan's manual-actions section.
        const planRow = isNativeIssue(card.ref) ? plans.get(String(canonicalIssueRef(card.ref))) : undefined;
        const section = planRow ? planParser.findManualActionsSection(planRow.body) : null;
        card = {
          ...card,
          awaitingOperator: true,
          operatorStep: {
            summary: `Operator step ${step.position} · ${step.title}`,
            html: renderMarkdown(section?.body || "_See the plan's manual-actions section._"),
            url: card.url,
            position: step.position,
            title: step.title,
            text: section?.body ?? "",
          },
        };
      }
      const blockedReason = trackerId ? blockedReasons.get(trackerId) : undefined;
      if (blockedReason) card = { ...card, blockedReason, blockedReasonHtml: renderMarkdown(displayBlockedReason(blockedReason)) };
      const queuedReason = trackerId ? queued.get(trackerId) : undefined;
      if (queuedReason) card = { ...card, queued: true, queuedReason, queuedReasonHtml: renderMarkdown(displayBlockedReason(queuedReason)) };
      const overlapNote = trackerId ? overlapHeld.get(trackerId) : undefined;
      if (overlapNote) card = { ...card, overlapHold: overlapNote, ...(queuedReason ? {} : { queuedReason: overlapNote, queuedReasonHtml: `<p>${escapeHtml(overlapNote)}</p>` }) };
      if (trackerId && reapprovalPending.has(trackerId)) card = { ...card, reapprovalPending: true };
      if (trackerId && approvedRequirements.has(trackerId)) card = { ...card, requirementsApproved: true };
      const declared = trackerId ? infraDeclarations.get(trackerId) : undefined;
      const destroyConsent = declared ? destroyConsentView(declared.entries, atLeast(card.approvedThrough ?? "none", "plan"), declared.destroyConsent) : undefined;
      if (destroyConsent) card = { ...card, destroyConsent };
      const flight = flights.get(flightKey(card.repo, card.ref));
      if (!flight) return card;
      const openPrs = flight.openPrs.map((row) => withAttention(boardCardPr(row, liveStatuses.get(row.repo)?.get(row.prNumber), activeWork)));
      return { ...card, flight: { ...flight, openPrs } };
    };
    return {
      cards: [...onBoard.map(withFlight), ...done].map(withModelPlan).map(withActiveSession),
      // What Claws manages, not what the cards happen to mention: the `?repo=`
      // cut above and the Done column's row cap both drop cards, and a
      // repository that lost all of its would otherwise drop out of the filter
      // that is hiding it, leaving "All repositories" the only way back to it.
      repoOptions: repos.map((r) => r.fullName),
      repoFilter,
      // The warning is about the board in front of the operator, so it counts
      // only the sources that board renders from. Under `?repo=` that is the
      // one repository: the others contribute no card either way, and counting
      // them would put the one incomplete source that matters inside a larger
      // number. The unassigned list is in the same position — its cards carry
      // `repo: ""`, so a `?repo=` filters every one of them away.
      incompleteSources: repoFilter ? (incomplete.has(repoFilter) ? 1 : 0) : incomplete.size,
      backlogCount,
      backlogNextReturn,
      prCards: prCardRows.map((row) => {
        const card = withAttention(boardCardPr(row, liveStatuses.get(row.repo)?.get(row.prNumber), activeWork));
        const activeSession = prSessions.get(prSessionRef(row.repo, row.prNumber));
        return activeSession ? { ...card, activeSession } : card;
      }),
    };
  }

  app.get("/board", authMiddleware, async (c) => {
    const theme = getTheme(c);
    const view = await loadBoardView(c.req.query("repo") ?? "", { staleOk: true });
    return htmlOk(c, buildBoardPage(view, theme, await loadOperatorAttentionCounts()));
  });

  // The Board page polls this to keep its cards, columns and nav counts current
  // while it stays open (#clw_01M59YYPDF6SQS5RR4JSFDZGJQ).
  app.get("/api/board", authMiddleware, async (c) => {
    const view = await loadBoardView(c.req.query("repo") ?? "");
    return c.json(renderBoardRefresh(view, await loadOperatorAttentionCounts()));
  });

  // The Board's Dependency graph modal fetches this on every open: the chains
  // of open native issues holding one another, across every repository
  // (chains cross repos, so `?repo=` is ignored).
  app.get("/api/board/dependency-graph", authMiddleware, async (c) => {
    const view = await loadBoardView("", { staleOk: true });
    const chains = await loadDependencyGraph(view.cards);
    return c.json({ html: renderDependencyGraph(chains), chains: chains.length });
  });

  app.post("/board/move", authMiddleware, async (c) => {
    // Read and parse outside the `try`: this route's `partial: true` means a
    // *half-applied* move, which the client answers by leaving the card where
    // it was dropped and telling the operator to reload. A truncated or
    // non-JSON body wrote nothing, so it must not borrow that meaning — it is a
    // 400 like any other malformed request, and the card snaps back.
    let raw: unknown;
    try {
      raw = JSON.parse(await readTextBody(c));
    } catch {
      return jsonOk(c, { error: "Malformed request body" }, 400);
    }
    const parsed = BoardMoveSchema.safeParse(raw);
    if (!parsed.success) return jsonOk(c, { error: "Missing repo, ref or column" }, 400);
    const { status, body } = await applyBoardMove(parsed.data.repo, parsed.data.ref, parsed.data.to, { approvedBy: sessionSubject(c), until: parsed.data.until, reason: parsed.data.reason });
    // The card's approval track was rendered for the old column, so a landed
    // move carries the re-rendered one, as `/board/approve-through` does; the
    // client then needs no poll to bring it up to date. Done and Backlog
    // cards show no track. A failed re-read answers without one, and the
    // client polls instead.
    if (status === 200 && body.column !== "done" && body.column !== "backlog") {
      try {
        const after = await loadApprovalTrackInput(parsed.data.repo, parsed.data.ref);
        if (after) return jsonOk(c, { ...body, track: renderApprovalTrack(after) }, status);
      } catch (err) {
        log.warn(`[board] approval state of ${parsed.data.repo}#${parsed.data.ref} after the move: ${err}`);
      }
    }
    return jsonOk(c, body, status);
  });

  // Bulk send-to-backlog from the board and bulk promote from the backlog
  // (#3293): each item is exactly one `applyBoardMove`, and the answer is 200
  // with one result per item, in order, carrying that move's own status.
  app.post("/board/bulk-move", authMiddleware, async (c) => {
    let raw: unknown;
    try {
      raw = JSON.parse(await readTextBody(c));
    } catch {
      return jsonOk(c, { error: "Malformed request body" }, 400);
    }
    const parsed = BoardBulkMoveSchema.safeParse(raw);
    if (!parsed.success) {
      return jsonOk(c, { error: `Expected { to: "backlog" | "ideas", items: [{ repo, ref }] } with 1–${BULK_MOVE_LIMIT} items` }, 400);
    }
    const { to, items } = parsed.data;
    const results = await mapWithConcurrency(items, 4, async (item) => {
      const { status, body } = await applyBoardMove(item.repo, item.ref, to === "ideas" ? "requirements-review" : to, { entry: to === "ideas", approvedBy: sessionSubject(c) });
      return { repo: item.repo, ref: item.ref, status, ...body };
    });
    return jsonOk(c, { results });
  });

  // A merge approval, not a lifecycle, so unlike `/board/move` it moves no
  // card. Nothing on the board posts here any more — the approval track's
  // Merge gate goes through `/board/approve-through` — but the route stays for
  // any client that still does. On: the issue is approved through Merge, where
  // the approval track offers it (`checkedApproval`), and
  // each of its open PR rows records who approved and when
  // (`merge_approved_by` / `merge_approved_at`, from the session's identity).
  // Off: a Merge approval drops to Plan and the row columns are cleared.
  // `setIssueAutomerge` is the write.
  app.post("/board/automerge", authMiddleware, async (c) => {
    let raw: unknown;
    try {
      raw = JSON.parse(await readTextBody(c));
    } catch {
      return jsonOk(c, { error: "Malformed request body" }, 400);
    }
    const parsed = BoardAutomergeSchema.safeParse(raw);
    if (!parsed.success) return jsonOk(c, { error: "Missing repo, ref or on" }, 400);
    const { repo, ref, on } = parsed.data;
    if (!(await isConfiguredRepo(repo))) {
      return jsonOk(c, { error: "Repository not configured" }, 403);
    }
    const result = await setIssueAutomerge(repo, ref, on, sessionSubject(c));
    if (!result.ok) return jsonOk(c, { error: result.error }, result.status);
    return jsonOk(c, { result: "ok", on });
  });

  // The approval track's one write (#clw_01M5VRB6Q607S256SQ8NDC5AHT), for the
  // board card and the issue page alike: approve the issue through `gate` and
  // every earlier one, or (`withdraw`) take a pre-approval back from `gate`
  // onward. One `applyIssueApproval` write of the stored approval
  // (#clw_01M5VW14RKAAGS6VZ5PCKQXB9F): Reqs raises it to Requirements, which
  // promotes the issue out of Requirements review; Plan raises it to Plan
  // (approving the plan in Awaiting plan review, pre-approving it before);
  // Merge to Merge. Withdrawing Plan lowers it to Requirements, withdrawing
  // Merge to Plan. Answers `{result, column, track}`, `track` being the
  // re-rendered control. The click is checked against the track derived from
  // the issue's live state, so a stale card cannot approve a gate that no
  // longer offers it. A failed write answers 500 with `partial: true`, like
  // `/board/move`.
  app.post("/board/approve-through", authMiddleware, async (c) => {
    const ids: BoardRefusalIds = {};
    const refuse = (body: { error: string } & Record<string, unknown>, status: number) => boardRefusal(c, "/board/approve-through", status, body, ids);
    let raw: unknown;
    try {
      raw = JSON.parse(await readTextBody(c));
    } catch {
      return refuse({ error: "Malformed request body" }, 400);
    }
    const parsed = ApproveThroughSchema.safeParse(raw);
    if (!parsed.success) return refuse({ error: "Missing repo, ref or gate" }, 400);
    const { repo, ref, gate } = parsed.data;
    ids.repo = repo;
    ids.issue = String(ref);
    const withdraw = !!parsed.data.withdraw;
    if (gate === "requirements" && withdraw) {
      return refuse({ error: "Approved requirements cannot be withdrawn — comment on the issue to revise them." }, 400);
    }
    if (!(await isConfiguredRepo(repo))) return refuse({ error: "Repository not configured" }, 403);
    let before: Awaited<ReturnType<typeof loadApprovalTrackInput>>;
    try {
      before = await loadApprovalTrackInput(repo, ref);
    } catch (err) {
      log.warn(`[board] approval state of ${repo}#${ref}: ${err}`);
      return refuse({ error: "Could not read the issue's current state — try again." }, 503);
    }
    if (!before) return refuse({ error: "No such issue" }, 404);
    // A native issue is written through its primary repo, which must be one of
    // its own and one Claws manages, as `applyBoardMove` checks.
    if (before.repos && !before.repos.includes(repo)) return refuse({ error: "Repository not configured" }, 403);
    if (before.repo !== repo && !(await isConfiguredRepo(before.repo))) return refuse({ error: "Repository not configured" }, 403);
    const track = deriveApprovalTrack(before);
    const view = track.gates.find((g) => g.gate === gate)!;
    // A click on an approval the issue already holds (a stale card) is a no-op
    // success: the card follows the live column.
    if (!withdraw && (view.state === "approved" || (gate === "plan" && view.state === "preapproved"))) {
      return jsonOk(c, { result: "ok", column: before.column, track: renderApprovalTrack(before) });
    }
    if (view.action !== (withdraw ? "withdraw" : "approve")) {
      // The live track and column go with the refusal, so the card stops offering it.
      return refuse({ error: `${view.label} cannot be ${withdraw ? "withdrawn" : "approved"} here: ${view.title}. Reload to see the issue's current state.`, track: renderApprovalTrack(before), column: before.column }, 409);
    }
    const owner = before.repo;
    const who = sessionSubject(c);
    const through: ApprovedThrough = withdraw
      ? (gate === "plan" ? "requirements" : withdrawMergeTarget(before.approvedThrough ?? "none"))
      : maxApproval(before.approvedThrough ?? "none", gate);
    // A native issue's promotion is the dashboard's own, which also re-plans
    // one that kept its plan; a forge issue's shadow takes the default.
    const record = isClawsIssueId(ref) ? await clawsIssues.getIssue(ref) : undefined;
    const result = await applyIssueApproval(owner, ref, through, who, record ? { promote: () => promoteNative(record, record.id, who) } : {});
    if (!result.ok) {
      // A 500 is a write that threw part-way; anything else refused before writing.
      return refuse({ error: result.error, ...(result.status === 500 ? { partial: true } : {}) }, result.status);
    }
    log.info(`[board] ${owner}#${ref}: ${withdraw ? "withdrew" : "approved through"} ${gate} for ${who}`);
    // Every write landed: a failed re-read is not a partial write, so it
    // answers without a track and the client reloads the card.
    let after: Awaited<ReturnType<typeof loadApprovalTrackInput>> = null;
    try {
      after = await loadApprovalTrackInput(owner, ref);
    } catch (err) {
      log.warn(`[board] approval state of ${owner}#${ref} after the write: ${err}`);
    }
    if (!after) return jsonOk(c, { result: "ok" });
    return jsonOk(c, { result: "ok", column: after.column, track: renderApprovalTrack(after) });
  });

  /**
   * The problem a PR-started session's first message points at, highest
   * priority first (see `PrSessionFocus`); null when the PR has none. The CI
   * fixer's gave-up record is in memory, so after a restart such a PR reads as
   * plain failing CI.
   */
  function prSessionFocus(repo: string, pr: PR, row: ClawsPrRecord | null, status: PRRowStatus | undefined): PrSessionFocus {
    if (hasManualAction(row)) return { kind: "manual-action", reason: row!.manualActionReason! };
    if (isProblematic(row)) return { kind: "problematic" };
    if (ciFixerGaveUpOnHead(repo, pr.number, pr.headRefOid ?? row?.headSha)) return { kind: "ci-fix-exhausted" };
    if (row?.ciBlockedReason) return { kind: "ci-blocked", reason: row.ciBlockedReason };
    if (status?.checkStatus === "failing") return { kind: "ci-failing" };
    if (status?.checkStatus === "held") return { kind: "ci-held" };
    return null;
  }

  // The board's Start session button: an interactive session for a native
  // issue with all its repos, primary first, and the agent, model and
  // capabilities the New session form would pre-select for that combination
  // (docs/product/dashboard-and-integrations.md). Nothing is remembered — the
  // form's defaults change only on a form submission — and no audit comment is
  // posted; the row's `spawned_for_issue` records the link.
  app.post("/board/start-session", authMiddleware, async (c) => {
    const ids: BoardRefusalIds = {};
    const refuse = (body: { error: string } & Record<string, unknown>, status: number) => boardRefusal(c, "/board/start-session", status, body, ids);
    let raw: unknown;
    try {
      raw = JSON.parse(await readTextBody(c));
    } catch {
      return refuse({ error: "Malformed request body" }, 400);
    }
    const parsed = BoardStartSessionSchema.safeParse(raw);
    if (!parsed.success) return refuse({ error: "Missing repo or ref" }, 400);
    const { ref } = parsed.data;
    ids.repo = parsed.data.repo;
    ids.issue = String(ref);
    if (!isNativeIssue(ref)) return refuse({ error: "Only a Claws-native issue can be started as a session" }, 400);
    const id = ref;
    const record = await clawsIssues.getIssue(id);
    if (!record || record.kind === "shadow") return refuse({ error: "Issue not found" }, 404);
    const started = await startIssueSession(ctx, record, id, "board");
    if (!started.ok) {
      const error = started.status === 403 ? started.error : `Cannot create session: ${started.error}`;
      return refuse({ error }, started.status);
    }
    return jsonOk(c, { ok: true, id: started.id, url: started.url });
  });

  // A board card's infra approval button (#clw_01M5WBG6JZ8P3PCYVCQ3PS9BBS):
  // the operator's deliberate approval of one infrastructure PR's merge, bound
  // to the head whose plan summary the card showed. Only a PR that needs it
  // (`infraApprovalNeed`: an unverifiable or destructive plan, or a tofu
  // workflow or plan-publishing script edit, #clw_01M7NKT2H402M07VGCAE1TBX8G,
  // #clw_01M7NR1KKSPCEZ5VKSWGD27V8E) takes one; any other is
  // refused 409. A PR that has moved since
  // is refused with a fresh line, so the operator reviews the new head first.
  // Records the ordinary merge approval too (an infra approval is a superset
  // of one), then tries the merge through every auto-merger gate. A refusal
  // keeps the approval so the sweep finishes it once the other gates pass;
  // new commits make it stale. Answers the re-rendered infra line for the card.
  app.post("/board/infra-approve", authMiddleware, async (c) => {
    const ids: BoardRefusalIds = {};
    const refuse = (body: { error: string } & Record<string, unknown>, status: number) => boardRefusal(c, "/board/infra-approve", status, body, ids);
    let raw: unknown;
    try {
      raw = JSON.parse(await readTextBody(c));
    } catch {
      return refuse({ error: "Malformed request body" }, 400);
    }
    const parsed = BoardInfraApproveSchema.safeParse(raw);
    if (!parsed.success) return refuse({ error: "Missing repo, ref, pull request or head" }, 400);
    const { repo, ref, prRepo, prNumber, headSha: seenSha, need: seenNeed } = parsed.data;
    Object.assign(ids, { prRepo, prNumber }, repo !== undefined ? { repo } : {}, ref !== undefined ? { issue: String(ref) } : {});
    if ((repo === undefined) !== (ref === undefined)) return refuse({ error: "Missing repo, ref, pull request or head" }, 400);
    if (repo !== undefined && !(await isConfiguredRepo(repo))) return refuse({ error: "Repository not configured" }, 403);
    const repoObj = await findConfiguredRepo(prRepo);
    if (!repoObj) return refuse({ error: "Repository not configured" }, 403);
    const name = `${prRepo}#${prNumber}`;
    // The line for `head`: `infraPrLine` shows Tofu counts only when the
    // cached `listPRStatuses` evidence was read for that head.
    // A refusal passes `override`, the need and plan it just read, so the
    // returned button names the live need rather than the 60 s cached one.
    const line = async (head: string, override?: Partial<PRRepoStatus>): Promise<string> => {
      const fresh = await getClawsPr(prRepo, prNumber).catch(() => null);
      if (!fresh) return "";
      const cached = (await listPRStatuses(prRepo).catch(() => new Map<number, PRRepoStatus>())).get(prNumber);
      const live = override ? { ...(cached ?? {}), ...override } as PRRepoStatus : cached;
      const activeWork = await listActivePrWork(MERGE_BLOCKING_AGENT_KINDS)
        .catch((err) => { log.warn(`[board] active PR work: ${err}`); return new Map<string, string>(); });
      return infraPrLine(boardCardPr({ ...fresh, headSha: head }, live, activeWork));
    };
    let headSha: string;
    try {
      const row = await getClawsPr(prRepo, prNumber);
      if (!row) return refuse({ error: `No Claws record for ${name}` }, 404);
      if (repo !== undefined && ref !== undefined) {
        const flight = await loadIssueFlight(repo, ref);
        if (!flight.openPrs.some((p) => p.repo === prRepo && p.prNumber === prNumber)) {
          return refuse({ error: `${name} is not an open PR of ${repo}#${String(ref)}` }, 409);
        }
      } else if (row.stage === "merged" || row.stage === "closed") {
        return refuse({ error: `${name} is not open` }, 409);
      }
      if ((await getPRState(prRepo, prNumber)) !== "OPEN") return refuse({ error: `${name} is not open` }, 409);
      const changedFiles = await getPRChangedFiles(prRepo, prNumber);
      if ((await infraPathsIn(changedFiles, prRepo)).length === 0) {
        return refuse({ error: `${name} is not an infrastructure PR` }, 409);
      }
      headSha = await getPRHeadSHA(prRepo, prNumber);
      if (headSha !== seenSha) {
        return refuse({
          error: `${name} moved to ${headSha.slice(0, 7)}; review the new plan and approve again`,
          line: await line(headSha),
        }, 409);
      }
      // What was approved, so a later plan-neutral head keeps the approval
      // (the auto-merger's carry-over): the verified plan's resource changes and
      // the PR's tofu workflow and plan-publishing edits.
      const [evidence, diff] = await Promise.all([getTofuPlanEvidence(prRepo, prNumber, headSha), getPRDiff(prRepo, prNumber)]);
      // Only an unverifiable or destructive plan, or a tofu workflow edit, needs
      // this approval (#clw_01M7NKT2H402M07VGCAE1TBX8G); a trusted Renovate
      // tool version bump with a zero-change plan does not.
      let toolBump = false;
      if (evidence.state === "noop" && changedFiles.some(isInfraWorkflowPath)) {
        const verdict = noopMergeDiffVerdict(changedFiles, diff);
        const listed = (await listPRs(repoObj.fullName).catch(() => [] as PR[])).find((p) => p.number === prNumber);
        toolBump = verdict.ok && verdict.kind === "tool-version-bump" && !!listed && await isRenovateExempt(prRepo, listed);
      }
      const need = infraApprovalNeed({ repo: prRepo, files: changedFiles, planState: evidence.state, plan: evidence.plan, trustedToolBump: toolBump });
      const liveNeed: Partial<PRRepoStatus> = {
        infraApprovalNeed: need,
        tofuPlanHeadSha: headSha,
        tofuPlanState: evidence.state,
        tofuPlanDetail: evidence.detail,
        ...(evidence.plan ? { tofuPlan: evidence.plan } : {}),
        ...(evidence.resources !== undefined ? { tofuPlanResources: evidence.resources } : {}),
      };
      if (need === null) {
        return refuse({ error: `${name} needs no infra approval: its verified plan for ${headSha.slice(0, 7)} destroys or replaces nothing`, line: await line(headSha, liveNeed) }, 409);
      }
      // The approval is bound to the need the button was labelled with: an
      // "approve without a verified plan" click never approves a destroy the
      // plan run reported after the card was rendered.
      if (seenNeed !== need) {
        return refuse({ error: `${name} now needs a different infra approval (${INFRA_NEED_WORDS[need]}); review it and approve again`, line: await line(headSha, liveNeed) }, 409);
      }
      const verified = (evidence.state === "noop" || evidence.state === "changes") && evidence.resources;
      const approvedEvidence: InfraMergeApprovedEvidence = {
        fingerprint: verified ? tofuPlanFingerprint(evidence.resources!) : null,
        counts: verified ? evidence.plan : null,
        workflowDiff: infraWorkflowDiffDigest(prRepo, changedFiles, diff),
        need,
      };
      const who = sessionSubject(c);
      await writeMergeApproval(prRepo, prNumber, who, { keepExisting: true });
      await upsertClawsPr(prRepo, prNumber, {
        infraMergeApprovedBy: who,
        infraMergeApprovedAt: new Date().toISOString(),
        infraMergeApprovedSha: headSha,
        infraMergeApprovedEvidence: JSON.stringify(approvedEvidence),
        infraMergeCarriedSha: null,
        infraMergeCarriedNote: null,
        infraBranchUpdates: 0,
        infraBranchUpdateSha: null,
        infraBranchUpdateFromSha: null,
      });
      log.info(`[board] Infra approval (${need}) of ${name} recorded by ${who} for head ${headSha.slice(0, 7)} ${repo !== undefined ? `(issue ${repo}#${String(ref)})` : "(board PR card)"}; ${approvedEvidence.fingerprint !== null ? "plan fingerprint recorded" : `no plan fingerprint recorded (${evidence.detail})`}`);
    } catch (err) {
      return refuse({ error: `Could not record the infra approval: ${err instanceof Error ? err.message : String(err)}` }, 500);
    }
    const pr = (await listPRs(repoObj.fullName).catch(() => [] as PR[])).find((p) => p.number === prNumber);
    if (!pr) {
      return jsonOk(c, { ok: true, merged: false, reason: "Claws merges it on its next sweep", line: await line(headSha) });
    }
    let result: Awaited<ReturnType<typeof attemptMerge>>;
    try {
      result = await attemptMerge(repoObj, pr, { mergedBy: "dashboard", notify: false });
    } catch (err) {
      return refuse({ error: `Approval recorded, but the merge failed: ${err instanceof Error ? err.message : String(err)}`, line: await line(headSha) }, 502);
    }
    if (result.merged) return jsonOk(c, { ok: true, merged: true, line: await line(headSha) });
    return jsonOk(c, { ok: true, merged: false, reason: result.message, code: result.code, line: await line(headSha) });
  });

  // A board Approve merge button (#clw_01M759BB4Q65KD6914P5Z1J9GN): the
  // operator's per-PR merge approval of a ready PR, as `/prs` and
  // `claws_approve_pr_merge` record it (the issue's `approved_through` is left
  // alone). An infra PR takes it too: one that also needs the board's infra
  // approval stays held for it. An unmet manual-action warning needs
  // `confirmManual`, as `/queue/merge` does. Then
  // tries the merge through every auto-merger gate; a refusal keeps the
  // approval so the sweep finishes it.
  app.post("/board/merge-approve", authMiddleware, async (c) => {
    const ids: BoardRefusalIds = {};
    const refuse = (body: { error: string } & Record<string, unknown>, status: number) => boardRefusal(c, "/board/merge-approve", status, body, ids);
    let raw: unknown;
    try {
      raw = JSON.parse(await readTextBody(c));
    } catch {
      return refuse({ error: "Malformed request body" }, 400);
    }
    const parsed = BoardMergeApproveSchema.safeParse(raw);
    if (!parsed.success) return refuse({ error: "Missing repo, ref or pull request" }, 400);
    const { repo, ref, prRepo, prNumber, confirmManual } = parsed.data;
    Object.assign(ids, { prRepo, prNumber }, repo !== undefined ? { repo } : {}, ref !== undefined ? { issue: String(ref) } : {});
    if ((repo === undefined) !== (ref === undefined)) return refuse({ error: "Missing repo, ref or pull request" }, 400);
    if (repo !== undefined && !(await isConfiguredRepo(repo))) return refuse({ error: "Repository not configured" }, 403);
    const repoObj = await findConfiguredRepo(prRepo);
    if (!repoObj) return refuse({ error: "Repository not configured" }, 403);
    const name = `${prRepo}#${prNumber}`;
    const source = repo !== undefined ? `(issue ${repo}#${String(ref)})` : "(board PR card)";
    try {
      const row = await getClawsPr(prRepo, prNumber);
      if (!row) return refuse({ error: `No Claws record for ${name}` }, 404);
      if (repo !== undefined && ref !== undefined) {
        const flight = await loadIssueFlight(repo, ref);
        if (!flight.openPrs.some((p) => p.repo === prRepo && p.prNumber === prNumber)) {
          return refuse({ error: `${name} is not an open PR of ${repo}#${String(ref)}` }, 409);
        }
      } else if (row.stage === "merged" || row.stage === "closed") {
        return refuse({ error: `${name} is not open` }, 409);
      }
      if ((await getPRState(prRepo, prNumber)) !== "OPEN") return refuse({ error: `${name} is not open` }, 409);
      const manualWarning = await manualWarningFor(prRepo, prNumber);
      if (manualWarning && !confirmManual) return refuse({ error: manualWarning, manualWarning }, 409);
      const who = sessionSubject(c);
      await writeMergeApproval(prRepo, prNumber, who, { keepExisting: true });
      log.info(`[board] Merge of ${name} approved by ${who} ${source}`);
    } catch (err) {
      return refuse({ error: `Could not record the merge approval: ${err instanceof Error ? err.message : String(err)}` }, 500);
    }
    const pr = (await listPRs(repoObj.fullName).catch(() => [] as PR[])).find((p) => p.number === prNumber);
    if (!pr) {
      log.info(`[board] Approved merge of ${name} queued: not in the open PR list; Claws merges it on its next sweep`);
      return jsonOk(c, { ok: true, merged: false, reason: "Claws merges it on its next sweep" });
    }
    let result: Awaited<ReturnType<typeof attemptMerge>>;
    try {
      result = await attemptMerge(repoObj, pr, { mergedBy: "dashboard", notify: false });
    } catch (err) {
      return refuse({ error: `Approval recorded, but the merge failed: ${err instanceof Error ? err.message : String(err)}` }, 502);
    }
    if (result.merged) {
      log.info(`[board] Approved merge of ${name} merged`);
      return jsonOk(c, { ok: true, merged: true });
    }
    log.info(`[board] Approved merge of ${name} queued for the auto-merger (${result.code ?? "refused"}): ${result.message}`);
    return jsonOk(c, { ok: true, merged: false, reason: result.message, code: result.code });
  });

  // The PRs page's Start session button: an interactive session for one open
  // PR's repository, set up like a board start (same form defaults, nothing
  // remembered, nothing posted on the forge). Its first message has the agent
  // gather context read-only, pointed at the PR's obvious problem when it has
  // one, and wait; the row's `spawned_for_pr` records the link
  // (docs/product/dashboard-and-integrations.md).
  app.post("/prs/start-session", authMiddleware, async (c) => {
    let raw: unknown;
    try {
      raw = JSON.parse(await readTextBody(c));
    } catch {
      return jsonOk(c, { error: "Malformed request body" }, 400);
    }
    const parsed = RepoPrNumberSchema.safeParse(raw);
    if (!parsed.success) return jsonOk(c, { error: "Missing repo or number" }, 400);
    const { repo, number } = parsed.data;
    if (!(await isConfiguredRepo(repo))) return jsonOk(c, { error: "Repository not configured" }, 403);
    let pr: PR | undefined;
    try {
      pr = (await listPRs(repo)).find((p) => p.number === number);
    } catch (err) {
      log.warn(`[sessions] PR start-session could not list ${repo}'s PRs: ${err instanceof Error ? err.message : String(err)}`);
      return jsonOk(c, { error: "Could not read the pull request" }, 502);
    }
    if (!pr) return jsonOk(c, { error: "Pull request not found or not open" }, 404);
    const [statuses, prRow] = await Promise.all([
      loadPRRowStatuses(repo, [pr]),
      getClawsPr(repo, number).catch((err) => {
        log.warn(`[sessions] PR start-session could not read ${repo}#${number}'s claws_prs row: ${err instanceof Error ? err.message : String(err)}`);
        return null;
      }),
    ]);
    const qi = (await controller.queueSnapshot()).items.find((i) => i.repo === repo && i.number === number);
    const status = resolvePRStatus({ repo, pr, status: statuses.get(number) }, qi);
    const issueId = prRow?.issueId ?? null;
    const input = {
      repo,
      number,
      title: pr.title,
      branch: pr.headRefName,
      url: config.prUrl(repo, number),
      issueId,
      issueUrl: issueId ? clawsIssues.dashboardIssueUrl(issueId) : null,
      focus: prSessionFocus(repo, pr, prRow, status),
    };
    const { provider, model, capabilities } = await sessionFormDefaultsFor(ctx, [repo]);
    const result = await getSessionBackend().create({
      repos: [repo],
      mode: "worktree-claude",
      capabilities,
      provider,
      model,
      brief: buildPrSessionBrief(input),
      spawnedBySession: null,
      spawnedForIssue: issueId,
      spawnedForPr: prSessionRef(repo, number),
      title: prSessionTitle(number, pr.title),
      initialPrompt: buildPrOpeningMessage(input),
    });
    if (!result.ok) {
      const status = createSessionErrorStatus(result);
      return jsonOk(c, { error: `Cannot create session: ${describeCreateSessionError(result)}` }, status);
    }
    log.info(`[sessions] PRs page started session ${result.id} for ${repo}#${number} (provider: ${provider}, model: ${model ?? "default"}, focus: ${input.focus?.kind ?? "none"}, issue: ${issueId ?? "none"}, capabilities: ${capabilities.join(", ") || "none"})`);
    return jsonOk(c, { ok: true, id: result.id, url: clawsIssues.dashboardSessionUrl(result.id) });
  });

  /**
   * Apply (`on`) or withdraw the merge approval for the issue `repo#ref`:
   * approve it through Merge, or lower a Merge approval to Plan
   * (`applyIssueApproval`, which writes or clears every open PR row's
   * approval, recording `approvedBy`). Withdrawing never raises: an issue
   * approved short of Merge restates its approval only to clear PR rows a
   * single-PR approval left, and with none left it writes nothing — a
   * restated Requirements approval would promote an issue still in Ideas.
   * Answers how many open PRs it touched; with none, the next PR Claws opens
   * for the issue inherits the approval.
   */
  async function setIssueAutomerge(repo: string, ref: config.IssueRef, on: boolean, approvedBy: string): Promise<GateWriteResult & { openPrs?: number }> {
    // Approving is checked against the track like any gate click.
    if (on) return await checkedApproval(repo, ref, () => "merge", approvedBy);
    let current: ApprovedThrough;
    let openPrs: ClawsPrRecord[];
    try {
      current = (await readIssueApproval(repo, ref)).approvedThrough;
      openPrs = atLeast(current, "merge") ? [] : (await loadIssueFlight(repo, ref)).openPrs;
    } catch (err) {
      log.warn(`[approval] approval state of ${repo}#${ref}: ${err}`);
      return { ok: false, status: 503, error: "Could not read the issue's current state — try again." };
    }
    if (!atLeast(current, "merge") && !openPrs.some((pr) => pr.mergeApprovedAt)) return { ok: true, openPrs: 0 };
    // Off clears every approved row, a partial Merge's single-PR approvals included.
    const result = await applyIssueApproval(repo, ref, withdrawMergeTarget(current), approvedBy, { clearMergeRows: true });
    return result.ok ? { ok: true, openPrs: result.openPrs } : { ok: false, status: result.status as ContentfulStatusCode, error: result.error };
  }

  // ── Backlog (docs/issue-tracker.md#backlog) ──
  //
  // Backlog issues are off the board; this is where they are listed, with the
  // day a parked one returns, and where a human promotes them back to
  // Drafting, Requirements review or Planning. The one automated exit is a
  // return date passing (`backlog-until.ts`'s sweep in the issue dispatcher).

  app.get("/backlog", authMiddleware, async (c) => {
    const theme = getTheme(c);
    const repos = await listRepos();
    const query = parseBacklogQuery((k) => c.req.query(k));
    const incomplete = new Set<string>();
    const orNone = (source: string) => (err: unknown): never[] => {
      log.warn(`[backlog] ${source}: ${err}`);
      incomplete.add(source);
      return [];
    };
    const perRepo = await mapWithConcurrency(repos, 8, async (r) => {
      const open = await listOpenIssues(r.fullName, { staleOk: true }).catch(orNone(r.fullName));
      return open.map((issue): BacklogRow => ({
        repo: r.fullName,
        ref: issue.number,
        title: issue.title,
        labels: issue.labels.map((l) => l.name),
        url: config.issueUrl(r.fullName, issue.number),
        updatedAt: issue.updatedAt ?? "",
        createdAt: issue.createdAt ?? "",
        author: issue.author.login,
        repos: issue.repos,
      }));
    });
    // An unassigned issue reads as Drafting whatever its lifecycle (see
    // `columnFor`), so the filter below drops these; they are fetched so the
    // page agrees with the board by construction rather than by assumption.
    const unassigned = (await clawsIssues.listUnassignedOpenIssues().catch(orNone("unassigned issues"))).map((issue): BacklogRow => ({
      repo: "",
      ref: issue.id,
      title: issue.title,
      labels: issue.labels,
      url: config.issueUrl("", issue.id),
      updatedAt: clawsIssues.toIso(issue.updated_at),
      createdAt: clawsIssues.toIso(issue.created_at),
      author: issue.author_login,
    }));
    const listed = [...perRepo.flat(), ...unassigned]
      .filter((r) => columnFor({ labels: r.labels, unassigned: !r.repo }) === BACKLOG_DESTINATION);
    const untilById = await getIssueBacklogUntil(listed.filter((r) => isClawsIssueId(r.ref)).map((r) => String(r.ref)))
      .catch((err) => { log.warn(`[backlog] return dates: ${err}`); return new Map<string, string>(); });
    const rows = listed.map((r) => ({ ...r, until: untilById.get(String(r.ref)) ?? null }));
    return htmlOk(c, buildBacklogPage({
      rows,
      repoOptions: repos.map((r) => r.fullName),
      query,
      incompleteSources: query.repo ? (incomplete.has(query.repo) ? 1 : 0) : incomplete.size,
    }, theme, await loadOperatorAttentionCounts()));
  });

  // The backlog page's form: a row's own Promote button sends `only`, the
  // bulk button every ticked `item`. Works without JavaScript.
  app.post("/backlog/promote", authMiddleware, async (c) => {
    const body = await readTextBody(c);
    const params = parseFormBody(body);
    const only = params["only"];
    const values = only ? [only] : parseFormBodyMulti(body, "item");
    const returnTo = params["return_to"] ?? "";
    const back = /^\/backlog(?:\?[^\s]*)?$/.test(returnTo) ? returnTo : "/backlog";
    const backAction = { actions: [{ href: back, label: "← Backlog" }] };
    if (values.length === 0) {
      return htmlError(c, 400, "Nothing to promote", "Tick at least one issue, or use a row's Promote button.", backAction);
    }
    if (values.length > BULK_MOVE_LIMIT) {
      return htmlError(c, 400, "Too many issues", `Promote at most ${BULK_MOVE_LIMIT} issues at a time.`, backAction);
    }
    // `<repo>#<ref>`, split on the last `#`: a repo name never holds one.
    const items = values.map((value) => {
      const at = value.lastIndexOf("#");
      const ref = at >= 0 ? canonicalIssueRef(value.slice(at + 1)) : null;
      return { value, repo: at >= 0 ? value.slice(0, at) : "", ref };
    });
    const results = await mapWithConcurrency(items, 4, async (item) => {
      if (item.ref === null) return { value: item.value, status: 400, error: "Not an issue reference" };
      const { status, body: res } = await applyBoardMove(item.repo, item.ref, "requirements-review", { entry: true, approvedBy: sessionSubject(c) });
      return { value: item.value, status, error: typeof res["error"] === "string" ? res["error"] : undefined };
    });
    const failed = results.filter((r) => r.status !== 200 || r.error);
    if (failed.length > 0) {
      const promoted = results.length - failed.length;
      return htmlError(
        c,
        409,
        "Some issues were not promoted",
        `${promoted} of ${results.length} promoted.`,
        { detail: failed.map((r) => `${r.value}: ${r.error ?? `HTTP ${r.status}`}`).join("\n"), ...backAction },
      );
    }
    return c.redirect(back, 303);
  });
}
