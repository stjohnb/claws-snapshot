/**
 * Typed links between tracker issues (docs/issue-tracker.md#links): "A depends
 * on B", "A blocks B", "A relates to B".
 *
 * `db.ts` owns the rows; this module is the rules on top of them — how an
 * input kind is normalised onto the two stored ones, how a typed reference
 * resolves to a native id, when adding a dependency parks its issue, and the
 * dispatcher's sweep that unparks an issue once its last dependency closes.
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
  otherLifecycle: IssueLifecycle;
  /** When the dispatcher's sweep fired on this dependency, or null. */
  releasedAt: string | null;
}

/**
 * The native id behind a typed reference, or a {@link LinkError}.
 *
 * Accepts a `clw_…` id, `owner/repo#N`, `#N` / `N` against `contextRepo`, or a
 * forge or dashboard issue URL. A forge ref resolves through
 * `imported_issues`, which answers for imported issues and shadows alike; a
 * forge issue Claws has never seen has no native id and is refused.
 */
export async function resolveLinkTarget(raw: string, contextRepo: string): Promise<string> {
  const text = raw.trim();
  if (!text) throw new LinkError("An issue reference is required.", 400);
  const native = /(?:^|\/|#)(clw_[0-9a-z]{26})\/?$/i.exec(text);
  let id: string | undefined;
  if (native) {
    id = canonicalIssueRef(native[1]) as string;
  } else {
    const forge = /^([\w.-]+\/[\w.-]+)#(\d+)$/.exec(text)
      ?? /([\w.-]+\/[\w.-]+)\/issues\/(\d+)\/?$/.exec(text);
    const repo = forge ? forge[1] : contextRepo;
    const number = forge ? forge[2] : /^#?(\d+)$/.exec(text)?.[1];
    if (number === undefined) throw new LinkError(`Not an issue reference: ${text}`, 400);
    if (!repo) throw new LinkError(`${text} names no repository, and this issue has none to resolve it against — use owner/repo#N.`, 400);
    id = await db.getLinkedNativeId(repo, Number(number));
    if (!id) throw new LinkError(`${repo}#${number} is not tracked by Claws, so it cannot be linked.`, 400);
  }
  if (!(await db.getClawsIssue(id))) throw new LinkError(`No issue ${id}.`, 400);
  return id;
}

/** The native id `ref` names in `repo` — itself, or a forge issue's shadow — or undefined. */
async function trackerIdFor(repo: string, ref: IssueRef): Promise<string | undefined> {
  const canonical = canonicalIssueRef(ref);
  if (isClawsIssueId(canonical)) return canonical;
  if (canonical === null || !repo) return undefined;
  return await db.getLinkedNativeId(repo, canonical);
}

function toView(issueId: string, row: db.ClawsIssueLinkWithOther): IssueLinkView {
  const kind: LinkKind = row.kind === "relates_to" ? "relates_to" : row.source_id === issueId ? "depends_on" : "blocks";
  return {
    id: row.id,
    kind,
    otherId: row.other_id,
    otherTitle: row.other_title,
    otherState: row.other_state,
    otherStateReason: row.other_state_reason,
    otherLifecycle: row.other_lifecycle,
    releasedAt: row.released_at,
  };
}

/** Every link on `ref` (a native id, or a forge number resolved to its shadow), oldest first. */
export async function listLinks(repo: string, ref: IssueRef): Promise<IssueLinkView[]> {
  const id = await trackerIdFor(repo, ref);
  if (!id) return [];
  return (await db.listClawsIssueLinks(id)).map((row) => toView(id, row));
}

/** Lifecycles an added dependency parks from. Backlog stays parked where it is. */
const PARKABLE: ReadonlySet<IssueLifecycle> = new Set(["ideas", "planning", "awaiting-plan-review", "approved"]);

/**
 * Link `sourceRef` to `targetRaw` with `kind`, and park the dependent issue
 * when the new link is a dependency on an open issue.
 *
 * Parking moves the dependent to `Blocked` with a comment, but only when it is
 * an open native issue in Ideas, Planning, Awaiting plan review or Approved without an open
 * PR (a `claws_prs` row): a Backlog issue is already parked, and one with a PR in
 * flight is past the point where holding it back helps.
 *
 * A dependency on an issue that is already closed is stored as released, so
 * it can never trigger the sweep for an issue parked for some other reason.
 */
export async function addLink(
  repo: string,
  sourceRef: IssueRef,
  kind: LinkKind,
  targetRaw: string,
  actorLogin: string,
): Promise<{ link: IssueLinkView; created: boolean; parked: boolean }> {
  const actingId = await trackerIdFor(repo, sourceRef);
  const acting = actingId ? await db.getClawsIssue(actingId) : undefined;
  if (!acting || acting.kind === "shadow") throw new LinkError(`No native issue ${String(sourceRef)}.`, 404);
  const otherId = await resolveLinkTarget(targetRaw, repo || clawsIssues.primaryRepo(acting.repos));
  if (otherId === acting.id) throw new LinkError("An issue cannot be linked to itself.", 400);

  let sourceId = acting.id;
  let targetId = otherId;
  if (kind === "blocks" || (kind === "relates_to" && otherId < acting.id)) [sourceId, targetId] = [otherId, acting.id];
  const stored: db.ClawsIssueLinkKind = kind === "relates_to" ? "relates_to" : "depends_on";

  const dependent = sourceId === acting.id ? acting : await db.getClawsIssue(sourceId);
  const target = targetId === acting.id ? acting : await db.getClawsIssue(targetId);
  if (!dependent || !target) throw new LinkError(`No issue ${!dependent ? sourceId : targetId}.`, 400);
  const targetOpen = target.state === "open";

  const { link, created } = await db.createClawsIssueLink({
    sourceId,
    targetId,
    kind: stored,
    createdBy: actorLogin,
    actingId: acting.id,
    released: stored === "depends_on" && !targetOpen,
  });

  let parked = false;
  if (created && stored === "depends_on" && targetOpen
      && dependent.kind === "issue"
      && dependent.state === "open"
      && PARKABLE.has(dependent.lifecycle)
      && (await db.listOpenClawsPrsForIssue(dependent.id)).length === 0) {
    const dependentRepo = clawsIssues.primaryRepo(dependent.repos);
    await clawsIssues.setLifecycle(dependentRepo, dependent.id, "blocked");
    await gh.commentOnIssue(dependentRepo, dependent.id, [
      `Claws has parked this issue as \`${LABELS.blocked}\`: it depends on #${target.id} — ${target.title}, which is still open.`,
      ``,
      `It moves out of \`${LABELS.blocked}\` automatically once every issue it depends on has closed.`,
    ].join("\n"), { agentName: AGENT_NAME });
    parked = true;
    log.info(`[issue-links] Parked ${dependent.id} as Blocked: depends on open ${target.id}`);
  }

  const view = (await db.listClawsIssueLinks(acting.id)).find((row) => row.id === link.id);
  return { link: toView(acting.id, view!), created, parked };
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
 * The open issues `ref` depends on — the implementer gate. Covers forge issues
 * through their shadows as well as native ones.
 */
export async function listOpenDependencies(repo: string, ref: IssueRef): Promise<{ id: string; title: string }[]> {
  const id = await trackerIdFor(repo, ref);
  return id ? await db.listOpenDependencyTargets(id) : [];
}

function describeClosed(row: db.ClawsIssueLinkWithOther): string {
  const reason = row.other_state_reason ? ` as ${row.other_state_reason.replace("_", " ")}` : "";
  return `- #${row.other_id} — ${row.other_title} (closed${reason})`;
}

/**
 * The dispatcher's per-repo sweep: unpark every Blocked native issue whose
 * unreleased dependencies have all closed, and return the ids released.
 *
 * Where it lands depends on its last plan comment: a real plan goes to
 * Awaiting plan review (Ready) for the normal dispatcher path; the planner's
 * blocked verdict goes to Planning with a re-plan enqueued here — the verdict
 * counts as a plan, so the dispatcher would otherwise leave it waiting — and no
 * plan at all goes where `clawsIssues.entryLifecycle` says: Planning when its
 * requirements were approved, for the next cycle to plan, and Ideas otherwise.
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
    if (await db.hasPendingIssueRefinerWork(repo, issue.id)) {
      log.info(`[issue-links] Deferring unpark of ${issue.id}: planner work is still queued or running`);
      continue;
    }
    try {
      const cleared = (await db.listClawsIssueLinks(issue.id))
        .filter((row) => row.kind === "depends_on" && row.source_id === issue.id && row.released_at === null);
      const plan = planParser.findPlanComment(await gh.getIssueComments(repo, issue.id));
      const replan = plan !== null && planParser.isBlockedVerdictPlan(plan);
      const destination: IssueLifecycle = plan !== null && !replan ? "awaiting-plan-review" : clawsIssues.entryLifecycle(issue, plan !== null);
      await clawsIssues.setLifecycle(repo, issue.id, destination);
      const next = destination === "awaiting-plan-review"
        ? `It is back in \`${LABELS.ready}\` (awaiting plan review) with its existing plan.`
        : replan
          ? "Its last plan was the planner's blocked verdict, so it is back in Planning and queued for a re-plan."
          : destination === "planning"
            ? "It has no plan yet, so it is back in Planning for the planner."
            : "It has no plan yet, so it is back in Ideas, where its requirements wait to be promoted.";
      await gh.commentOnIssue(repo, issue.id, [
        `Every issue this one depends on has closed, so Claws has moved it out of \`${LABELS.blocked}\`.`,
        ``,
        ...cleared.map(describeClosed),
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
      log.info(`[issue-links] Unparked ${issue.id} to ${destination}: dependencies ${cleared.map((r) => r.other_id).join(", ")} closed`);
    } catch (err) {
      log.warn(`[issue-links] Failed to unpark ${issue.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return released;
}
