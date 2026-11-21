/**
 * Typed links between tracker issues (docs/issue-tracker.md#links): "A depends
 * on B", "A blocks B", "A relates to B".
 *
 * `db.ts` owns the rows; this module is the rules on top of them — how an
 * input kind is normalised onto the two stored ones, how a typed reference
 * resolves to a native id, when adding a dependency parks its issue, and the
 * dispatcher's sweep that unparks an issue once its last dependency closes.
 *
 * A `depends_on` link may name one step of its target (`target_step`, the
 * 1-based position in the target's stored PR list): it is satisfied once that
 * step is done — its PR merged or the step claimed — or the target closes
 * ({@link isDependencySatisfied}).
 *
 * The other end of a link reports its board stage, not its stored lifecycle.
 *
 * It sits above `github.ts` (it comments and reads plans through the façade),
 * so `claws-issues.ts` must never import it: that module is below the façade.
 */

import * as db from "./db.js";
import * as gh from "./github.js";
import * as log from "./log.js";
import * as clawsIssues from "./claws-issues.js";
import * as worker from "./worker.js";
import { AGENT_KINDS } from "./worker.js";
import * as planParser from "./plan-parser.js";
import { LABELS, isAgentDisabled } from "./config.js";
import { canonicalIssueRef, isClawsIssueId, type IssueRef } from "./issue-id.js";
import type { IssueLifecycle } from "./issue-lifecycle.js";
import { stagesForOpenIssues, titleFor, type IssueStage } from "./issue-stage.js";
import { destinationForLifecycle, type BoardDestination } from "./issue-board.js";
import { isAlertIssue } from "./alert-issue.js";
import { atLeast } from "./issue-approval.js";
import { dependencyParkReason } from "./blocked-reason.js";
import { loadIssuePhaseState } from "./planned-prs.js";

/** The kinds a caller may ask for. `blocks` is stored as the inverse `depends_on`. */
export const LINK_KINDS = ["depends_on", "blocks", "relates_to"] as const;

export type LinkKind = (typeof LINK_KINDS)[number];

/** Human wording per kind, as seen from the issue the link is read on. */
export const LINK_KIND_LABELS: Record<LinkKind, string> = {
  depends_on: "Depends on",
  blocks: "Blocks",
  relates_to: "Relates to",
};

const AGENT_NAME = "Issue links";

/** A rejected link request. `status` is the HTTP status a route should answer with. */
export class LinkError extends Error {
  constructor(message: string, readonly status: 400 | 404) {
    super(message);
    this.name = "LinkError";
  }
}

/** `depends_on`, `blocks` or `relates_to` (also accepting `depends on`, `relates-to` …), or null. */
export function parseLinkKind(raw: unknown): LinkKind | null {
  if (typeof raw !== "string") return null;
  const normalised = raw.trim().toLowerCase().replace(/[\s-]+/g, "_");
  return (LINK_KINDS as readonly string[]).includes(normalised) ? normalised as LinkKind : null;
}

/** One link as the issue it is read on sees it. */
export interface IssueLinkView {
  id: string;
  /** The relationship from this issue's side: "this issue <kind> the other". */
  kind: LinkKind;
  otherId: string;
  otherTitle: string;
  /** `open` or `closed`. */
  otherState: string;
  otherStateReason: string | null;
  /** The column the board shows the other issue in (`done` once it is closed). */
  otherStage: BoardDestination;
  /** {@link otherStage} as the board's column title; `Backlog` for backlog, `Closed` once closed. */
  otherStageTitle: string;
  /** When the dispatcher's sweep fired on this dependency, or null. */
  releasedAt: string | null;
  /**
   * The step (1-based) of the depended-on issue a step-scoped `depends_on`
   * link waits for — the other issue's on a `depends_on` view, this issue's
   * on a `blocks` view — or null for the whole issue.
   */
  targetStep: number | null;
}

/**
 * The native id behind a typed reference, and the plan step it names, or a
 * {@link LinkError}.
 *
 * Accepts a `clw_…` id, `owner/repo#N`, `#N` / `N` against `contextRepo`, or a
 * forge or dashboard issue or PR URL. A forge ref resolves through
 * `imported_issues`, which answers for imported issues and shadows alike, and
 * names no step. A forge ref that is not a tracked issue, or a `/pulls/N` URL,
 * is read as a PR: it resolves to the issue whose stored PR list links it and
 * that entry's step (`db.findIssuePlannedPRByNumber`). A ref that is neither
 * is refused.
 */
export async function resolveLinkTarget(raw: string, contextRepo: string): Promise<{ id: string; step: number | null }> {
  const text = raw.trim();
  if (!text) throw new LinkError("An issue reference is required.", 400);
  const native = /(?:^|\/|#)(clw_[0-9a-z]{26})\/?$/i.exec(text);
  let id: string | undefined;
  let step: number | null = null;
  if (native) {
    id = canonicalIssueRef(native[1]) as string;
  } else {
    const pull = /([\w.-]+\/[\w.-]+)\/pulls\/(\d+)\/?$/.exec(text);
    const forge = pull
      ?? /^([\w.-]+\/[\w.-]+)#(\d+)$/.exec(text)
      ?? /([\w.-]+\/[\w.-]+)\/issues\/(\d+)\/?$/.exec(text);
    const repo = forge ? forge[1] : contextRepo;
    const number = forge ? forge[2] : /^#?(\d+)$/.exec(text)?.[1];
    if (number === undefined) throw new LinkError(`Not an issue reference: ${text}`, 400);
    if (!repo) throw new LinkError(`${text} names no repository, and this issue has none to resolve it against — use owner/repo#N.`, 400);
    if (!pull) id = await db.getLinkedNativeId(repo, Number(number));
    if (!id) {
      const planned = await db.findIssuePlannedPRByNumber(repo, Number(number));
      if (!planned) {
        throw new LinkError(pull
          ? `${repo}#${number} is not a PR any Claws plan links, so it cannot be linked.`
          : `${repo}#${number} is not tracked by Claws, nor a PR any Claws plan links, so it cannot be linked.`, 400);
      }
      id = planned.issueId;
      step = planned.position;
    }
  }
  if (!(await db.getClawsIssue(id))) throw new LinkError(`No issue ${id}.`, 400);
  return { id, step };
}

/**
 * Whether a `depends_on` link no longer holds its issue back: its target has
 * closed, or the link names a step and that step is in the target's
 * `coverage.done` — its PR merged, or the step was claimed done. A whole-issue
 * link to an open target is never satisfied, with no forge read. A failed
 * read is logged and answers false, so the dependent keeps waiting rather
 * than going ahead early.
 */
export async function isDependencySatisfied(link: { targetId: string; targetStep: number | null; targetOpen: boolean }): Promise<boolean> {
  if (!link.targetOpen) return true;
  if (link.targetStep === null) return false;
  try {
    const target = await db.getClawsIssue(link.targetId);
    if (!target) return false;
    const imported = target.kind === "shadow" ? await db.getImportedIssueByNative(target.id) : undefined;
    const repo = imported?.repo ?? clawsIssues.primaryRepo(target);
    const ref: IssueRef = imported?.forgeNumber ?? target.id;
    const state = await loadIssuePhaseState(repo, ref, await gh.getIssueComments(repo, ref));
    return state.coverage.done.has(link.targetStep);
  } catch (err) {
    log.warn(`[issue-links] Could not read whether step ${link.targetStep} of ${link.targetId} is done — treating it as not done: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

/** How a dependency reads in a comment: `#X — T`, or `step N of #X — T`. */
function dependencyLabel(target: { id: string; title: string }, step: number | null): string {
  return `${step !== null ? `step ${step} of ` : ""}#${target.id} — ${target.title}`;
}

/** The native id `ref` names in `repo` — itself, or a forge issue's shadow — or undefined. */
async function trackerIdFor(repo: string, ref: IssueRef): Promise<string | undefined> {
  const canonical = canonicalIssueRef(ref);
  if (isClawsIssueId(canonical)) return canonical;
  if (canonical === null || !repo) return undefined;
  return await db.getLinkedNativeId(repo, canonical);
}

/**
 * Views of `rows` as `issueId` sees them. An open other end's status is its
 * board stage (`columnFor`, with its PRs, labels and phases), not the stored
 * lifecycle, which can lag behind; a closed one is `done` / `Closed`.
 */
async function toViews(issueId: string, rows: db.ClawsIssueLinkWithOther[]): Promise<IssueLinkView[]> {
  const openIds = [...new Set(rows.filter((row) => row.other_state === "open").map((row) => row.other_id))];
  const records = (await Promise.all(openIds.map((id) => db.getClawsIssue(id)))).filter(
    (record): record is db.ClawsIssueRecord => !!record,
  );
  const stages = await stagesForOpenIssues(records).catch(() => new Map<string, IssueStage>());
  return rows.map((row) => {
    const kind: LinkKind = row.kind === "relates_to" ? "relates_to" : row.source_id === issueId ? "depends_on" : "blocks";
    let otherStage: BoardDestination;
    let otherStageTitle: string;
    if (row.other_state !== "open") {
      otherStage = "done";
      otherStageTitle = "Closed";
    } else {
      const found = stages.get(row.other_id);
      otherStage = found?.stage ?? destinationForLifecycle(row.other_lifecycle);
      otherStageTitle = found?.stage_title ?? titleFor(otherStage);
    }
    return {
      id: row.id,
      kind,
      otherId: row.other_id,
      otherTitle: row.other_title,
      otherState: row.other_state,
      otherStateReason: row.other_state_reason,
      otherStage,
      otherStageTitle,
      releasedAt: row.released_at,
      targetStep: row.kind === "depends_on" ? row.target_step : null,
    };
  });
}

/** Every link on `ref` (a native id, or a forge number resolved to its shadow), oldest first. */
export async function listLinks(repo: string, ref: IssueRef): Promise<IssueLinkView[]> {
  const id = await trackerIdFor(repo, ref);
  if (!id) return [];
  return await toViews(id, await db.listClawsIssueLinks(id));
}

/** Lifecycles an added dependency parks from. Backlog stays parked where it is. */
const PARKABLE: ReadonlySet<IssueLifecycle> = new Set(["ideas", "planning", "awaiting-plan-review"]);

/**
 * Link `sourceRef` to `targetRaw` with `kind`, and park the dependent issue
 * when the new link is a dependency on an open issue.
 *
 * Parking moves the dependent to `Blocked` with a {@link dependencyParkReason}
 * and a comment — the board shows it in Queued (`queued-issues.ts`) — but only when it is
 * an open native issue in Ideas, Planning, Awaiting plan review or Approved without an open
 * PR (a `claws_prs` row): a Backlog issue is already parked, and one with a PR in
 * flight is past the point where holding it back helps.
 *
 * A dependency that is already satisfied — on an issue that is closed, or on
 * a step that is already done — is stored as released and parks nothing, so
 * it can never trigger the sweep for an issue parked for some other reason.
 *
 * `step` scopes a `depends_on` link to one step of the target: it must be
 * 1..the length of the target's stored PR list, and a target with no stored
 * list is refused. A PR reference as the target supplies its step itself; a
 * `step` that disagrees with it is refused. A `blocks` or `relates_to` link
 * to a PR reference links its issue. Re-adding a dependency with a different
 * step is refused rather than rewritten — unlink it first.
 */
export async function addLink(
  repo: string,
  sourceRef: IssueRef,
  kind: LinkKind,
  targetRaw: string,
  actorLogin: string,
  step: number | null = null,
): Promise<{ link: IssueLinkView; created: boolean; parked: boolean }> {
  const actingId = await trackerIdFor(repo, sourceRef);
  const acting = actingId ? await db.getClawsIssue(actingId) : undefined;
  if (!acting || acting.kind === "shadow") throw new LinkError(`No native issue ${String(sourceRef)}.`, 404);
  if (step !== null && kind !== "depends_on") throw new LinkError("A step applies only to a depends_on link.", 400);
  if (step !== null && (!Number.isInteger(step) || step < 1)) throw new LinkError("step must be a positive integer.", 400);
  const resolved = await resolveLinkTarget(targetRaw, repo || clawsIssues.primaryRepo(acting));
  const otherId = resolved.id;
  if (otherId === acting.id) throw new LinkError("An issue cannot be linked to itself.", 400);
  if (step !== null && resolved.step !== null && step !== resolved.step) {
    throw new LinkError(`${targetRaw.trim()} is step ${resolved.step} of #${otherId}, not step ${step}.`, 400);
  }
  const targetStep = kind === "depends_on" ? step ?? resolved.step : null;

  let sourceId = acting.id;
  let targetId = otherId;
  if (kind === "blocks" || (kind === "relates_to" && otherId < acting.id)) [sourceId, targetId] = [otherId, acting.id];
  const stored: db.ClawsIssueLinkKind = kind === "relates_to" ? "relates_to" : "depends_on";

  const dependent = sourceId === acting.id ? acting : await db.getClawsIssue(sourceId);
  const target = targetId === acting.id ? acting : await db.getClawsIssue(targetId);
  if (!dependent || !target) throw new LinkError(`No issue ${!dependent ? sourceId : targetId}.`, 400);
  const targetOpen = target.state === "open";

  if (targetStep !== null) {
    const steps = (await db.getIssuePlannedPRs(target.id)).length;
    if (steps === 0) throw new LinkError(`#${target.id} has no stored PR list, so it has no step to depend on.`, 400);
    if (targetStep > steps) throw new LinkError(`#${target.id} has ${steps} step${steps === 1 ? "" : "s"}; step must be 1..${steps}.`, 400);
  }
  let existing: db.ClawsIssueLinkWithOther | undefined;
  if (stored === "depends_on") {
    existing = (await db.listClawsIssueLinks(sourceId))
      .find((row) => row.kind === "depends_on" && row.source_id === sourceId && row.target_id === targetId);
    if (existing && existing.target_step !== targetStep) {
      const was = existing.target_step === null ? "the whole issue" : `step ${existing.target_step}`;
      throw new LinkError(`#${sourceId} already depends on ${was} of #${targetId}; unlink it first to change the step.`, 400);
    }
  }
  const satisfied = stored === "depends_on" && !existing
    && await isDependencySatisfied({ targetId, targetStep, targetOpen });

  const { link, created } = await db.createClawsIssueLink({
    sourceId,
    targetId,
    kind: stored,
    createdBy: actorLogin,
    actingId: acting.id,
    released: satisfied,
    targetStep,
  });

  let parked = false;
  if (created && stored === "depends_on" && !satisfied
      && dependent.kind === "issue"
      && dependent.state === "open"
      && PARKABLE.has(dependent.lifecycle)
      && (await db.listOpenClawsPrsForIssue(dependent.id)).length === 0) {
    const dependentRepo = clawsIssues.primaryRepo(dependent);
    await clawsIssues.blockIssue(dependentRepo, dependent.id, dependencyParkReason([{ ...target, target_step: targetStep }]));
    await gh.commentOnIssue(dependentRepo, dependent.id, [
      targetStep === null
        ? `Claws has parked this issue as \`${LABELS.blocked}\`: it depends on #${target.id} — ${target.title}, which is still open.`
        : `Claws has parked this issue as \`${LABELS.blocked}\`: it depends on ${dependencyLabel(target, targetStep)}, which is not done yet.`,
      ``,
      `The board shows it in Queued until everything it depends on has closed or landed; then it moves on automatically.`,
    ].join("\n"), { agentName: AGENT_NAME });
    parked = true;
    if (targetStep === null) log.info(`[issue-links] Parked ${dependent.id} as Blocked: depends on open ${target.id}`);
    else log.info(`[issue-links] Parked ${dependent.id} as Blocked: depends on a step of open ${target.id}`, { step: targetStep });
  }

  const view = (await db.listClawsIssueLinks(acting.id)).find((row) => row.id === link.id);
  return { link: (await toViews(acting.id, [view!]))[0], created, parked };
}

/** Remove link `linkId` from `ref`. Throws a 404 {@link LinkError} when the link is not on that issue. */
export async function removeLink(repo: string, ref: IssueRef, linkId: string): Promise<void> {
  const id = await trackerIdFor(repo, ref);
  const link = await db.getClawsIssueLink(linkId.trim());
  if (!id || !link || (link.source_id !== id && link.target_id !== id)) {
    throw new LinkError(`No link ${linkId} on ${String(ref)}.`, 404);
  }
  await db.deleteClawsIssueLink(link.id);
}

/**
 * The unsatisfied dependencies of `ref` — the implementer gate: every open
 * issue it depends on, less step links whose step is already done
 * ({@link isDependencySatisfied}). Covers forge issues through their shadows
 * as well as native ones.
 */
export async function listOpenDependencies(repo: string, ref: IssueRef): Promise<{ id: string; title: string; step: number | null }[]> {
  const id = await trackerIdFor(repo, ref);
  if (!id) return [];
  const out: { id: string; title: string; step: number | null }[] = [];
  for (const target of await db.listOpenDependencyTargets(id)) {
    if (target.target_step !== null
        && await isDependencySatisfied({ targetId: target.id, targetStep: target.target_step, targetOpen: true })) continue;
    out.push({ id: target.id, title: target.title, step: target.target_step });
  }
  return out;
}

function describeCleared(row: db.ClawsIssueLinkWithOther): string {
  const label = dependencyLabel({ id: row.other_id, title: row.other_title }, row.target_step);
  if (row.other_state === "open") return `- ${label} (done)`;
  const reason = row.other_state_reason ? ` as ${row.other_state_reason.replace("_", " ")}` : "";
  return `- ${label} (closed${reason})`;
}

/**
 * The dispatcher's per-repo sweep: unpark every Blocked native issue whose
 * unreleased dependencies are all satisfied — each target closed, or for a
 * step link that step done — and return the ids released. An issue with a
 * step link still unsatisfied is skipped until the next cycle.
 *
 * Where it lands is `clawsIssues.releaseLifecycle`'s call, computed from its
 * last plan comment: a real plan goes to Awaiting plan review for the normal
 * dispatcher path — Approved, when its plan approval stands; the planner's blocked verdict goes to Planning with
 * a re-plan enqueued here — the verdict counts as a plan, so the dispatcher
 * would otherwise leave it waiting — and no plan at all goes where
 * `clawsIssues.entryLifecycle` says: Planning when its requirements were
 * approved, for the next cycle to plan, and Ideas otherwise.
 *
 * The links are stamped released last, as the upstream watcher records its
 * fire last: a failure part-way leaves the issue to retry next cycle. One
 * issue's failure is logged and does not stop the rest.
 *
 * An issue with planner work still queued or running is skipped entirely:
 * unparking it now and having that run finish with a blocked verdict would
 * re-park it with its links already released, past the point any later sweep
 * would look at it again. It is picked up once the run completes and the
 * links are still unreleased.
 */
export async function releaseDependencyParkedIssues(repo: string): Promise<string[]> {
  const released: string[] = [];
  for (const issue of await db.listDependencyReleasableIssues(repo)) {
    // A legacy alert inbox depended on the issues tracking its alerts —
    // those issues closing must not unpark it.
    if (isAlertIssue(issue)) continue;
    if (await db.hasPendingIssueRefinerWork(repo, issue.id)) {
      log.info(`[issue-links] Deferring unpark of ${issue.id}: planner work is still queued or running`);
      continue;
    }
    try {
      const cleared = (await db.listClawsIssueLinks(issue.id))
        .filter((row) => row.kind === "depends_on" && row.source_id === issue.id && row.released_at === null);
      let waiting = false;
      for (const row of cleared) {
        if (row.other_state !== "open") continue;
        if (!await isDependencySatisfied({ targetId: row.other_id, targetStep: row.target_step, targetOpen: true })) {
          waiting = true;
          break;
        }
      }
      if (waiting) continue;
      const steps = cleared.some((row) => row.target_step !== null);
      const plan = planParser.findPlanComment(await gh.getIssueComments(repo, issue.id));
      const { lifecycle: destination, replan } = clawsIssues.releaseLifecycle(issue, plan !== null, plan !== null && planParser.isBlockedVerdictPlan(plan));
      await clawsIssues.setLifecycle(repo, issue.id, destination);
      const next = destination === "awaiting-plan-review"
        ? atLeast(issue.approved_through, "plan")
          ? "It is back in Approved with its existing plan, which stays approved."
          : "It is back in Awaiting plan review with its existing plan."
        : replan
          ? "Its last plan was the planner's blocked verdict, so it is back in Planning and queued for a re-plan."
          : destination === "planning"
            ? "It has no plan yet, so it is back in Planning for the planner."
            : "It has no plan yet, so it is back in Drafting or Requirements review, where its requirements wait to be promoted.";
      await gh.commentOnIssue(repo, issue.id, [
        steps
          ? `Everything this issue depends on has closed or landed, so Claws has moved it out of \`${LABELS.blocked}\`.`
          : `Every issue this one depends on has closed, so Claws has moved it out of \`${LABELS.blocked}\`.`,
        ``,
        ...cleared.map(describeCleared),
        ``,
        next,
      ].join("\n"), { agentName: AGENT_NAME });
      if (replan && !isAgentDisabled("planner")) {
        await worker.enqueue(AGENT_KINDS.ISSUE_REFINER_REPLAN, repo, issue.id, {
          priority: gh.hasPriorityLabel(issue.labels.map((name) => ({ name }))),
        });
      }
      await db.markClawsIssueLinksReleased(issue.id);
      released.push(issue.id);
      const stepLinks = cleared.filter((r) => r.target_step !== null);
      const unparked = `[issue-links] Unparked ${issue.id} to ${destination}: dependencies ${cleared.map((r) => r.other_id).join(", ")} closed`;
      if (stepLinks.length === 0) log.info(unparked);
      else log.info(unparked, { step: stepLinks.map((r) => `${r.target_step} of ${r.other_id}`).join(", ") });
    } catch (err) {
      log.warn(`[issue-links] Failed to unpark ${issue.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return released;
}
