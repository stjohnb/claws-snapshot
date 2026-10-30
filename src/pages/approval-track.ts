/**
 * The approval track (#clw_01M5VRB6Q607S256SQ8NDC5AHT): an issue's
 * Requirements → Plan → Merge gates as one control, shared by the board card,
 * the issue page and `POST /board/approve-through`, which answers with the
 * re-rendered control.
 *
 * The gates are a read-only strip of labelled dots; the operator acts through
 * one filled primary button naming the next gate's approval, with the further
 * approvals ("& plan", "& merge") attached to it as one button group and the
 * withdrawals in a ⋯ menu (#clw_01M61A4P3N7D76P1JR2HW5WNN5, replacing the
 * "More…" select of #clw_01M5X4HY4YC56Y6VEMK12P2QR7). Every action's label or
 * accessible name states the click's whole effect.
 *
 * Read from the one stored value (#clw_01M5VW14RKAAGS6VZ5PCKQXB9F):
 * Requirements reads the approval record and the lifecycle, Plan and Merge
 * read `approved_through` (`issue-approval.ts`) — Plan approved once the
 * issue is past plan review (the PR columns included), pre-approved before it — and Merge also reads
 * `merge_approved_at` on every open PR row. So an approval set by any other
 * path — an MCP tool, the issue page, a monitor — shows here with no extra
 * bookkeeping.
 *
 * The "Stops at" line names the next place Claws waits for a human. Unplanned
 * stops (Blocked, Claws Problematic, a reviewer escalation, Needs LGTM, an
 * operator step) are not gates; while one applies the line names it instead.
 */

import { isEscalationManualAction } from "../pr-escalation.js";
import { escapeHtml, repoShortName } from "./layout.js";
import { LABELS } from "../config.js";
import { atLeast, stopsAtFor, type ApprovedThrough } from "../issue-approval.js";
import { shortIssueRef, type IssueRef } from "../issue-id.js";
import type { BoardDestination } from "../issue-board.js";

export type ApprovalGate = "requirements" | "plan" | "merge";

/**
 * `approved` — passed, or pre-approved and reached; `preapproved` — filled
 * ahead of the issue's stage; `next` — the first unfilled gate, where Claws
 * will stop; `partial` — Merge with only some open PRs approved; `open` —
 * unfilled beyond the next stop.
 */
export type GateState = "open" | "next" | "approved" | "preapproved" | "partial";

/** What can be done at the gate: approve through it, withdraw the pre-approval from it onward, or nothing. */
export type GateAction = "approve" | "withdraw" | "none";

/** The part of an open PR row the track reads; a `BoardCardPr` or `ClawsPrRecord` satisfies it. */
export interface ApprovalTrackPr {
  repo: string;
  prNumber: number;
  mergeApprovedAt: string | null;
  stage: string;
  needsHumanReview: boolean;
  manualActionReason?: string | null;
}

export interface ApprovalTrackInput {
  /** The issue's primary repository; the track is not rendered without one. */
  repo: string;
  ref: IssueRef;
  /** The issue's board column, as `columnFor` derives it. */
  column: BoardDestination;
  labels: readonly string[];
  /** The stored lifecycle; absent reads as `ideas`. */
  lifecycle?: string;
  /** The stored approval (`approved_through`); absent reads as `none`. */
  approvedThrough?: ApprovedThrough;
  /** The issue has an approved requirements version (`requirements_approved_at`). */
  requirementsApproved?: boolean;
  hasPlan?: boolean;
  reapprovalPending?: boolean;
  awaitingOperator?: boolean;
  awaitingImport?: boolean;
  openPrs?: readonly ApprovalTrackPr[];
}

export interface GateView {
  gate: ApprovalGate;
  /** The visible word: Reqs, Plan or Merge. */
  label: string;
  state: GateState;
  action: GateAction;
  title: string;
}

/** One action control: the primary button, a further approval or a withdrawal. */
export interface ApprovalAction {
  gate: ApprovalGate;
  withdraw: boolean;
  /** The visible label, stating the action's whole effect. */
  label: string;
  /** Extra detail only; nothing an operator needs is here alone. */
  title: string;
}

export interface ApprovalTrack {
  gates: GateView[];
  /** The full "Stops at" sentence. */
  stopsAt: string;
  /** What `stopsAt` names: a gate, an unplanned stop, or the run to merge with no further stop. */
  stop: "gate" | "unplanned" | "run";
  /** Nothing can be approved or withdrawn in this column (Drafting, Blocked, Backlog, awaiting import). */
  readOnly: boolean;
  /** The next gate's approval, when the operator can give it here. */
  primary: ApprovalAction | null;
  /** Approving further ahead and withdrawing, never the primary's action. */
  secondary: ApprovalAction[];
}

/** Columns past requirements review: reaching any of them means the requirements were approved. */
const PAST_REQUIREMENTS = ["planning", "awaiting-plan-review", "approved", "in-progress", "awaiting-merge"];
/** Columns past plan review: with the stored approval through Plan, the plan was approved and reached. */
const PAST_PLAN = ["approved", "in-progress", "awaiting-merge"];
/** Columns the Merge gate can be approved from. */
const MERGE_APPROVABLE = ["requirements-review", "planning", "awaiting-plan-review", "approved", "in-progress", "awaiting-merge"];
/** Columns whose gates show but offer no action. */
const READ_ONLY = ["drafting", "queued", "blocked", "backlog", "done"];

const prName = (pr: ApprovalTrackPr): string => `${repoShortName(pr.repo)}#${pr.prNumber}`;

/**
 * Whether the issue's Plan gate is passed (approved and reached): approved
 * through Plan in a column past plan review. The PR columns read the stored
 * value too — an in-flight multi-PR issue converted below Plan shows Plan
 * unapproved, so the dispatcher and the track agree.
 */
function planPassed(input: ApprovalTrackInput): boolean {
  return atLeast(input.approvedThrough, "plan") && PAST_PLAN.includes(input.column);
}

/**
 * Whether the plan is pre-approved: approved through Plan in a column before
 * plan review. The planner lowers the value when its step-back withholds the
 * approval, so an Awaiting plan review card never carries a stale one.
 */
function planPreapproved(input: ApprovalTrackInput): boolean {
  return !planPassed(input) && atLeast(input.approvedThrough, "plan");
}

/** The issue's merge approval: the whole issue, some of its open PRs, or none. */
export function mergeApproval(input: Pick<ApprovalTrackInput, "approvedThrough" | "openPrs">): { approved: boolean; approvedPrs: ApprovalTrackPr[] } {
  const prs = input.openPrs ?? [];
  const approvedPrs = prs.filter((pr) => !!pr.mergeApprovedAt);
  // Every open PR, not any: a single-PR approval (`claws_approve_pr_merge`)
  // must not show the whole issue as approved.
  const approved = atLeast(input.approvedThrough, "merge") || (prs.length > 0 && approvedPrs.length === prs.length);
  return { approved, approvedPrs };
}

/** The unplanned stop that overrides the gates' "Stops at", or null when none applies. */
function unplannedStop(input: ApprovalTrackInput): string | null {
  if (input.awaitingImport) return "Stops at: import into the Claws tracker";
  if (input.column === "queued") return "Stops at: Queued — waits on other work";
  if (input.column === "blocked") return "Stops at: Blocked";
  const prs = input.openPrs ?? [];
  const problematic = prs.find((pr) => pr.stage === "problematic");
  if (problematic) return `Stops at: ${LABELS.problematic} on ${prName(problematic)}`;
  const escalated = prs.find((pr) => isEscalationManualAction(pr));
  if (escalated) return `Stops at: reviewer escalation on ${prName(escalated)}`;
  const lgtm = prs.find((pr) => pr.needsHumanReview);
  if (lgtm) return `Stops at: ${LABELS.needsLgtm} on ${prName(lgtm)}`;
  const held = prs.find((pr) => !!pr.manualActionReason?.trim());
  if (held) return `Stops at: operator step on ${prName(held)}`;
  if (input.awaitingOperator) return "Stops at: operator step";
  if (input.reapprovalPending) return "Stops at: plan review (design change)";
  return null;
}

/** Derive the track's gates, its "Stops at" line and its action controls. Pure. */
export function deriveApprovalTrack(input: ApprovalTrackInput): ApprovalTrack {
  const column = input.column;
  const readOnly = !!input.awaitingImport || READ_ONLY.includes(column);
  const lifecycle = input.lifecycle ?? "ideas";
  const reqsPassed = !!input.requirementsApproved || PAST_REQUIREMENTS.includes(column)
    || ["planning", "awaiting-plan-review"].includes(lifecycle);
  const planDone = planPassed(input);
  const planPre = planPreapproved(input);
  const merge = mergeApproval(input);
  const mergeReached = column === "awaiting-merge";
  const partial = !merge.approved && merge.approvedPrs.length > 0;

  const filled = { requirements: reqsPassed, plan: planDone || planPre, merge: merge.approved };
  const firstOpen = (["requirements", "plan", "merge"] as const).find((g) => !filled[g]);
  const unfilled = (gate: ApprovalGate): GateState => (gate === firstOpen ? "next" : "open");
  const readOnlyNote = readOnly ? (input.awaitingImport ? " — waiting for import" : " — not settable in this column") : "";
  const ref = shortIssueRef(input.ref);

  // Requirements: never withdrawable — a filled Reqs gate is always reached.
  const reqs: GateView = reqsPassed
    ? { gate: "requirements", label: "Reqs", state: "approved", action: "none", title: "Requirements approved" }
    : {
      gate: "requirements", label: "Reqs", state: unfilled("requirements"),
      action: !readOnly && column === "requirements-review" ? "approve" : "none",
      title: `Requirements not yet approved${readOnlyNote}`,
    };

  let plan: GateView;
  if (planDone) {
    plan = { gate: "plan", label: "Plan", state: "approved", action: "none", title: "Plan approved" };
  } else if (planPre) {
    plan = {
      gate: "plan", label: "Plan", state: "preapproved", action: readOnly ? "none" : "withdraw",
      title: `Plan pre-approved — Claws approves the plan it writes${readOnlyNote}`,
    };
  } else {
    const approvable = !readOnly && (column === "requirements-review" || column === "planning"
      || ((column === "awaiting-plan-review" || column === "in-progress" || column === "awaiting-merge") && !!input.hasPlan));
    const inPrColumn = column === "in-progress" || column === "awaiting-merge";
    plan = {
      gate: "plan", label: "Plan", state: unfilled("plan"), action: approvable ? "approve" : "none",
      title: inPrColumn && approvable
        ? `Approve the plan of #${ref} — Claws continues its remaining steps once the open PR merges`
        : `Plan not yet approved${readOnlyNote}`,
    };
  }

  const escalationNote = (input.openPrs ?? []).some((pr) => isEscalationManualAction(pr))
    ? " — a reviewer escalation is recorded, so the PR won't merge until a clean review round clears it"
    : "";
  const scope = (input.openPrs ?? []).length === 0 ? " (applies to the PR Claws opens)" : "";
  let mergeGate: GateView;
  if (merge.approved) {
    mergeGate = {
      gate: "merge", label: "Merge", state: mergeReached ? "approved" : "preapproved", action: readOnly ? "none" : "withdraw",
      title: `Merge approved${scope} — Claws merges on green CI and a clean review${readOnlyNote}${escalationNote}`,
    };
  } else {
    const approvable = !readOnly && MERGE_APPROVABLE.includes(column)
      && (planDone || planPre || column !== "awaiting-plan-review" || !!input.hasPlan);
    const what = partial
      ? `Merge approved for ${merge.approvedPrs.map(prName).join(", ")} only`
      : "Merge not yet approved";
    mergeGate = {
      gate: "merge", label: "Merge", state: partial ? "partial" : unfilled("merge"), action: approvable ? "approve" : "none",
      title: `${what}${readOnlyNote}${escalationNote}`,
    };
  }

  const unplanned = unplannedStop(input);
  const stopsAt = unplanned ?? stopsAtFor(firstOpen);
  const stop = unplanned ? "unplanned" : firstOpen ? "gate" : "run";
  const gates = [reqs, plan, mergeGate];
  const { primary, secondary } = approvalActions(input, gates, { ref, scope, escalationNote, partialPrs: partial ? merge.approvedPrs : [] });
  return { gates, stopsAt, stop, readOnly, primary, secondary };
}

/** Columns before plan review: approving the plan there is a pre-approval. */
const BEFORE_PLAN_REVIEW = ["requirements-review", "planning"];

/** Join phrases as "a", "a and b", "a, b and c". */
function joinPhrases(parts: string[]): string {
  return parts.length <= 1 ? parts.join("") : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

/**
 * The primary button and the secondary actions, from the gates' actions. The
 * primary approves only the next gate (Requirements in Requirements review,
 * the written plan in Awaiting plan review, Merge once Reqs and Plan are
 * filled); everything else that a gate offers is a secondary entry whose
 * label names every gate it fills or empties.
 */
function approvalActions(
  input: ApprovalTrackInput,
  [reqs, plan, merge]: GateView[],
  ctx: { ref: string; scope: string; escalationNote: string; partialPrs: ApprovalTrackPr[] },
): { primary: ApprovalAction | null; secondary: ApprovalAction[] } {
  const column = input.column;
  const filled = (g: GateView): boolean => g.state === "approved" || g.state === "preapproved";
  const planIsPre = BEFORE_PLAN_REVIEW.includes(column);
  const mergeDetail = `Claws merges on green CI and a clean review${ctx.scope}${ctx.partialPrs.length > 0 ? `; merge is approved for ${ctx.partialPrs.map(prName).join(", ")} only so far` : ""}${ctx.escalationNote}`;

  let primary: ApprovalAction | null = null;
  if (reqs.action === "approve") {
    primary = { gate: "requirements", withdraw: false, label: "Approve requirements", title: `Approve the requirements of #${ctx.ref}${filled(plan) ? "; the plan is already pre-approved" : " — the plan then stops for your review"}` };
  } else if (plan.action === "approve" && column === "awaiting-plan-review") {
    primary = { gate: "plan", withdraw: false, label: "Approve plan", title: `Approve the plan of #${ctx.ref}; implementation starts` };
  } else if (plan.action === "approve" && (column === "in-progress" || column === "awaiting-merge")) {
    primary = { gate: "plan", withdraw: false, label: "Approve plan", title: plan.title };
  } else if (merge.action === "approve" && filled(reqs) && filled(plan)) {
    primary = { gate: "merge", withdraw: false, label: "Approve merge", title: mergeDetail };
  }

  const secondary: ApprovalAction[] = [];
  const isPrimary = (gate: ApprovalGate): boolean => primary?.gate === gate && !primary.withdraw;
  if (plan.action === "approve" && !isPrimary("plan")) {
    const label = filled(reqs) ? "Pre-approve plan" : "Approve requirements and pre-approve plan";
    secondary.push({ gate: "plan", withdraw: false, label, title: "Implementation starts without plan review" });
  }
  if (merge.action === "approve" && !isPrimary("merge")) {
    const reqsTo = !filled(reqs);
    const planTo = !filled(plan);
    let label: string;
    if (planTo && planIsPre && !reqsTo) label = "Pre-approve plan and approve merge";
    else label = `Approve ${joinPhrases([...(reqsTo ? ["requirements"] : []), ...(planTo ? ["plan"] : []), "merge"])}`;
    secondary.push({ gate: "merge", withdraw: false, label: `${label} — no further stop`, title: mergeDetail });
  }
  if (plan.action === "withdraw") {
    const alsoMerge = filled(merge);
    secondary.push({
      gate: "plan", withdraw: true,
      label: alsoMerge ? "Withdraw plan pre-approval and merge approval" : "Withdraw plan pre-approval",
      title: "The plan then stops for your review",
    });
  }
  if (merge.action === "withdraw") {
    secondary.push({ gate: "merge", withdraw: true, label: "Withdraw merge approval", title: "The PR then waits for your merge approval" });
  }
  return { primary, secondary };
}

/** The ⋯ icon on the withdrawal menu's summary. */
const ICON_MORE = '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false"><circle cx="3" cy="8" r="1.5" fill="currentColor"/><circle cx="8" cy="8" r="1.5" fill="currentColor"/><circle cx="13" cy="8" r="1.5" fill="currentColor"/></svg>';

/** A further approval's visible text: cumulative from the button it is attached to. */
const FURTHER_TEXT: Record<Exclude<ApprovalGate, "requirements">, string> = { plan: "& plan", merge: "& merge" };

/**
 * The read-only strip: an `ol` of three dot-and-label steps with a
 * presentational `li.approval-line` between each pair (an `ol` may only hold
 * `li`s); the line after an approved step carries `data-done`.
 */
function stepsStrip(gates: GateView[]): string {
  return `<ol class="approval-steps">${gates.map((g, i) => {
    const step = `<li class="approval-step" data-gate="${g.gate}" data-state="${g.state}" aria-label="${escapeHtml(`${g.label}: ${g.title}`)}" title="${escapeHtml(g.title)}"${g.state === "next" ? ' aria-current="step"' : ""}><span class="approval-dot" aria-hidden="true"></span>${escapeHtml(g.label)}</li>`;
    const line = i < gates.length - 1
      ? `<li class="approval-line" role="presentation" aria-hidden="true"${g.state === "approved" ? " data-done" : ""}></li>`
      : "";
    return step + line;
  }).join("")}</ol>`;
}

/**
 * The "Stops at" line with the gate or stop name bold: "Stops at <b>X</b>",
 * bolding only the part before " — " ("Queued — waits on other work") or
 * " on " ("operator step on fleet-infra#409"),
 * and "<b>Runs to merge</b> — no further stop". `warn` marks an unplanned
 * stop, `go` the run to merge.
 */
function stopsLine(track: ApprovalTrack): string {
  const cls = track.stop === "unplanned" ? " warn" : track.stop === "run" ? " go" : "";
  const text = track.stopsAt;
  let html: string;
  const prefix = "Stops at: ";
  const runPrefix = "Runs to merge";
  if (text.startsWith(prefix)) {
    const what = text.slice(prefix.length);
    const dash = what.indexOf(" — ");
    const on = dash > 0 ? dash : what.indexOf(" on ");
    html = on > 0
      ? `Stops at <b>${escapeHtml(what.slice(0, on))}</b>${escapeHtml(what.slice(on))}`
      : `Stops at <b>${escapeHtml(what)}</b>`;
  } else if (text.startsWith(runPrefix)) {
    html = `<b>${runPrefix}</b>${escapeHtml(text.slice(runPrefix.length))}`;
  } else {
    html = escapeHtml(text);
  }
  return `<p class="approval-stops${cls}">${html}</p>`;
}

/** One clickable approval control's shared attributes. */
function actAttrs(a: ApprovalAction): string {
  return `type="button" draggable="false" data-gate="${a.gate}" data-action="${a.withdraw ? "withdraw" : "approve"}"`;
}

/** The ⋯ withdrawal menu: a `details` popover holding a `role="menu"` list. */
function withdrawMenu(withdrawals: ApprovalAction[], ref: string): string {
  const items = withdrawals.map((a) =>
    `<li role="none"><button ${actAttrs(a)} class="approval-act" role="menuitem">${escapeHtml(a.label)}<small>${escapeHtml(a.title)}</small></button></li>`).join("");
  return `<details class="approval-menu"><summary draggable="false" aria-label="More approval actions for #${escapeHtml(ref)}" aria-haspopup="menu" aria-expanded="false">${ICON_MORE}</summary><ul class="approval-menu-list" role="menu">${items}</ul></details>`;
}

/**
 * The action row: the primary (filled) with the further approvals attached as
 * one `.approval-group` — or, with no primary, the first further approval
 * leading the group outlined under its full label — then the ⋯ menu of
 * withdrawals. With nothing to approve, each withdrawal is its own
 * `.approval-plain` button filling the row. Empty when nothing applies.
 */
function actionRow(track: ApprovalTrack, ref: string): string {
  const further = track.secondary.filter((a) => !a.withdraw);
  const withdrawals = track.secondary.filter((a) => a.withdraw);
  if (!track.primary && further.length === 0) {
    if (withdrawals.length === 0) return "";
    return `<div class="approval-actions">${withdrawals.map((a) =>
      `<button ${actAttrs(a)} class="approval-plain approval-act" title="${escapeHtml(a.title)}">${escapeHtml(a.label)}</button>`).join("")}</div>`;
  }
  let lead: string;
  let attached: ApprovalAction[];
  if (track.primary) {
    lead = `<button ${actAttrs(track.primary)} class="approval-primary approval-act" title="${escapeHtml(track.primary.title)}">${escapeHtml(track.primary.label)}</button>`;
    attached = further;
  } else {
    const [first, ...rest] = further;
    lead = `<button ${actAttrs(first)} class="approval-further approval-act" title="${escapeHtml(first.title)}">${escapeHtml(first.label)}</button>`;
    attached = rest;
  }
  const group = lead + attached.map((a) =>
    `<button ${actAttrs(a)} class="approval-further approval-act" title="${escapeHtml(a.label)}" aria-label="${escapeHtml(a.label)}">${escapeHtml(a.gate === "requirements" ? a.label : FURTHER_TEXT[a.gate])}</button>`).join("");
  const menu = withdrawals.length > 0 ? withdrawMenu(withdrawals, ref) : "";
  return `<div class="approval-actions"><div class="approval-group">${group}</div>${menu}</div>`;
}

/**
 * The track as HTML: the read-only strip (`ol.approval-steps` of three
 * `li.approval-step` items), the `.approval-stops` line and, where the
 * operator can act, the `.approval-actions` row. Every clickable control is
 * an `.approval-act` button carrying `data-gate` and `data-action`
 * (`approve` | `withdraw`), posted as `{gate, withdraw}`.
 * `data-track-repo`/`data-track-ref` let the issue page's script post
 * without reading the page; the board's reads them off the card.
 */
export function renderApprovalTrack(input: ApprovalTrackInput): string {
  const track = deriveApprovalTrack(input);
  const ref = shortIssueRef(input.ref);
  return `<div class="approval-track" role="group" aria-label="Approval for #${escapeHtml(ref)}" data-track-repo="${escapeHtml(input.repo)}" data-track-ref="${escapeHtml(String(input.ref))}">${stepsStrip(track.gates)}${stopsLine(track)}${actionRow(track, ref)}</div>`;
}

/**
 * The track's styles, shared by the board and the issue page. Phone sizing
 * here; the board drops the strip and the actions to 30px in its own 768px
 * block, and the issue page raises them to 40px to match its buttons.
 */
export const APPROVAL_TRACK_CSS = `
  .approval-track { display: flex; flex-direction: column; gap: 0.25rem; min-width: 0; }
  .approval-steps { list-style: none; margin: 0; padding: 0; display: flex; align-items: center; gap: 0.3rem; min-width: 0; font-family: var(--font-display); font-size: 0.7rem; color: var(--text-subtle); }
  .approval-step { display: inline-flex; align-items: center; gap: 0.25rem; min-width: 0; }
  .approval-step[data-state="approved"] { color: var(--text-secondary); }
  .approval-step[data-state="preapproved"] { color: var(--accent); }
  .approval-step[data-state="next"] { color: var(--text); font-weight: 700; }
  .approval-line { flex: 1 1 0; min-width: 6px; height: 1px; background: var(--border-hover); }
  .approval-line[data-done] { background: var(--accent); }
  .approval-dot { width: 10px; height: 10px; border-radius: 50%; border: 1.5px solid var(--border-hover); flex: none; position: relative; box-sizing: border-box; }
  .approval-step[data-state="approved"] .approval-dot { background: var(--accent); border-color: var(--accent); }
  .approval-step[data-state="preapproved"] .approval-dot { border-color: var(--accent); }
  .approval-step[data-state="preapproved"] .approval-dot::after { content: ""; position: absolute; inset: 2px; border-radius: 50%; background: var(--accent); opacity: 0.55; }
  .approval-step[data-state="next"] .approval-dot { border-color: var(--success); border-style: dashed; }
  .approval-step[data-state="partial"] .approval-dot { border-color: var(--warning); background: linear-gradient(90deg, var(--warning) 50%, transparent 50%); }
  .approval-stops { margin: 0; font-family: var(--font-body); font-size: 0.7rem; color: var(--text-secondary); overflow-wrap: anywhere; line-height: 1.3; }
  .approval-stops b { color: var(--text); font-weight: 600; }
  .approval-stops.warn, .approval-stops.warn b { color: var(--warning); }
  .approval-stops.go, .approval-stops.go b { color: var(--success); }
  .approval-actions { display: flex; flex-wrap: wrap; gap: 0.35rem; min-width: 0; container-type: inline-size; }
  .approval-group { display: flex; flex: 1 1 auto; min-width: 0; }
  .approval-primary, .approval-further, .approval-plain { min-height: 36px; box-sizing: border-box; padding: 0.25rem 0.6rem; border-radius: 4px; font: inherit; font-size: 0.75rem; cursor: pointer; white-space: nowrap; }
  .approval-primary { flex: 1 1 auto; border: 1px solid var(--accent); background: var(--accent); color: var(--bg); font-weight: 600; border-radius: 4px 0 0 4px; }
  .approval-primary, .approval-group > .approval-further:first-child { white-space: normal; overflow-wrap: anywhere; line-height: 1.15; }
  .approval-further { flex: 0 1 auto; border: 1px solid var(--accent); background: var(--btn-bg); color: var(--accent); font-weight: 600; border-radius: 0; margin-left: -1px; }
  .approval-group > .approval-further:first-child { flex: 1 1 auto; margin-left: 0; border-radius: 4px 0 0 4px; }
  .approval-group > .approval-further:last-child { border-radius: 0 4px 4px 0; }
  .approval-group > .approval-act:only-child { border-radius: 4px; }
  .approval-further:hover { background: var(--accent); color: var(--bg); }
  @container (max-width: 18rem) {
    .approval-group { flex-wrap: wrap; }
    .approval-group > .approval-act:first-child:not(:only-child) { flex: 1 0 100%; border-radius: 4px 4px 0 0; }
    .approval-group > .approval-further:not(:first-child) { flex: 1 1 0; margin-top: -1px; border-radius: 0; }
    .approval-group > .approval-further:nth-child(2) { margin-left: 0; border-bottom-left-radius: 4px; }
    .approval-group > .approval-further:last-child:not(:first-child) { border-bottom-right-radius: 4px; }
  }
  .approval-plain { flex: 1 1 100%; border: 1px solid var(--border-hover); background: var(--btn-bg); color: var(--text); white-space: normal; }
  .approval-menu { position: relative; flex: none; }
  .approval-menu > summary { list-style: none; width: 36px; min-height: 36px; display: inline-flex; align-items: center; justify-content: center; background: var(--btn-bg); color: var(--text); border: 1px solid var(--border-hover); border-radius: 4px; cursor: pointer; box-sizing: border-box; }
  .approval-menu > summary::-webkit-details-marker { display: none; }
  .approval-menu[open] > summary { border-color: var(--accent); color: var(--accent); }
  .approval-menu-list { position: absolute; right: 0; top: calc(100% + 4px); z-index: 20; min-width: 15rem; max-width: min(18rem, calc(100vw - 16px)); box-sizing: border-box; overflow-y: auto; margin: 0; padding: 0.3rem; list-style: none; background: var(--bg); border: 1px solid var(--border-hover); border-radius: 6px; }
  .approval-menu-list button { display: block; width: 100%; min-height: 36px; text-align: left; font: inherit; font-size: 0.75rem; color: var(--danger); background: none; border: 0; border-radius: 4px; padding: 0.4rem 0.5rem; cursor: pointer; line-height: 1.3; }
  .approval-menu-list button:hover, .approval-menu-list button:focus-visible { background: var(--btn-hover); }
  .approval-menu-list button small { display: block; color: var(--text-subtle); font-size: 0.68rem; }
  .approval-act:focus-visible, .approval-menu > summary:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .approval-track[aria-busy="true"] .approval-actions { opacity: 0.6; cursor: progress; }
  .approval-error { margin: 0; font-size: 0.75rem; color: var(--danger); overflow-wrap: anywhere; }
`;
