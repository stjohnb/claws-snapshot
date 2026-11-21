/**
 * Agent pod size classes (#clw_01M7N5GF0MSZGBME8RWA2C45G8). A headless run's
 * pod is `default` (the `CLAWS_AGENT_POD_MEMORY_*` sizing) or `large` (the
 * `CLAWS_AGENT_POD_LARGE_*` sizing, pinned to `CLAWS_AGENT_POD_LARGE_NODES`).
 * The class is resolved once, on the service, when the pod is launched, from
 * the item's live `Agent: Large` label, and stored on the work row.
 */

import { AGENT_POD_SETTINGS, LABELS, type AgentPodLargeClass } from "./config.js";
import * as db from "./db.js";
import * as gh from "./github.js";
import { isClawsIssueId, type IssueRef } from "./issue-id.js";
import * as log from "./log.js";
import { trackerIdFor } from "./pr-issue-relation.js";

export type AgentPodClass = "default" | "large";

/** Env var naming the class inside the agent pod, so the pod knows the size it runs at. */
export const AGENT_POD_CLASS_ENV = "CLAWS_AGENT_POD_CLASS";

/** A stored `work_queue.agent_pod_class` as a class; anything but `large` (NULL included) is `default`. */
export function agentPodClassOf(value: string | null | undefined): AgentPodClass {
  return value === "large" ? "large" : "default";
}

/**
 * The class `row`'s pod launches in: `large` only when the large class is
 * configured, the row names a real item, and that item carries
 * `Agent: Large` — or, for a pull request, the issue the PR's stored relation
 * names does. A label read failure logs a warning and runs `default`.
 */
export async function resolveAgentPodClass(
  row: Pick<db.WorkQueueRow, "id" | "kind" | "repo" | "item_number">,
  large: AgentPodLargeClass | null | undefined = AGENT_POD_SETTINGS.large,
): Promise<AgentPodClass> {
  if (!large) return "default";
  const item = row.item_number;
  if (!item || item === "0") return "default";
  const has = (labels: readonly string[]) => labels.includes(LABELS.agentLarge);
  try {
    if (has(await gh.getLiveLabels(row.repo, item))) return "large";
    // A native id is never a pull request; a forge number might be.
    if (isClawsIssueId(item)) return "default";
    const pr = await db.getClawsPr(row.repo, Number(item));
    // The tracker id is the issue's canonical label home; a bare body ref may
    // name a closed imported forge copy or another repo's number.
    const sourceRef = pr?.issueId
      ?? (pr?.issueRef ? (await trackerIdFor(row.repo, pr.issueRef)) ?? pr.issueRef : null);
    if (sourceRef && has(await gh.getLiveLabels(row.repo, sourceRef))) return "large";
    return "default";
  } catch (err) {
    log.warn("agent pod class label read failed — running default", { component: "agent-pod", row: row.id, kind: row.kind, repo: row.repo, item: String(item) }, err);
    return "default";
  }
}

/**
 * Escalate an item to the large class after a default-class memory kill: add
 * `Agent: Large` to it, so its next dispatch — and every later run, until the
 * operator removes the label — launches large. True when the label was added;
 * false when the large class is not configured, the ref names no item, or the
 * item already carries the label. A label read or write failure throws.
 */
export async function escalateItemToLarge(
  repo: string,
  itemNumber: IssueRef,
  large: AgentPodLargeClass | null | undefined = AGENT_POD_SETTINGS.large,
): Promise<boolean> {
  if (!large) return false;
  if (!itemNumber || itemNumber === "0" || (typeof itemNumber === "number" && itemNumber < 0)) return false;
  if ((await gh.getLiveLabels(repo, itemNumber)).includes(LABELS.agentLarge)) return false;
  await gh.addLabel(repo, itemNumber, LABELS.agentLarge);
  log.info("agent pod class escalated to large", { component: "agent-pod", repo, item: String(itemNumber), label: LABELS.agentLarge });
  return true;
}

/** Why Kubernetes ended a default-class pod in a way a larger pod avoids. An
 *  `OOMKilled` pod is not one: it is a memory-limit kill, handled by
 *  `handleMemoryLimitKill` like a watchdog kill. */
export type PodResourceKillCause = { kind: "storage"; detail: string };

/**
 * After a default-class pod was evicted for a storage limit: escalate its item
 * to the large class and say so on the item. True when the label was added.
 * Best effort — a failure logs a warning and returns false.
 */
export async function escalateAfterPodResourceKill(
  row: Pick<db.WorkQueueRow, "id" | "kind" | "repo" | "item_number">,
  cause: PodResourceKillCause,
  large: AgentPodLargeClass | null | undefined = AGENT_POD_SETTINGS.large,
): Promise<boolean> {
  try {
    if (!await escalateItemToLarge(row.repo, row.item_number, large)) return false;
  } catch (err) {
    log.warn("agent pod class escalation failed", { component: "agent-pod", row: row.id, kind: row.kind, repo: row.repo, item: String(row.item_number) }, err);
    return false;
  }
  const body = [
    `### Disk limit reached`,
    "",
    `This item's \`${row.kind}\` agent pod (default class) was evicted by Kubernetes: ${cause.detail}. ` +
      `The label **${LABELS.agentLarge}** has been added and the run is being retried in the large agent pod class. ` +
      `Remove the label to return the item to the default class.`,
  ];
  try {
    await gh.commentOnIssue(row.repo, row.item_number, body.join("\n"));
  } catch (err) {
    log.warn("agent pod escalation comment failed", { component: "agent-pod", row: row.id, repo: row.repo, item: String(row.item_number), cause: cause.kind }, err);
  }
  return true;
}
