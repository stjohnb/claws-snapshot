/**
 * Forgejo webhook receiver (#clw_01M5TG58NKH7PZRANDSXQH601Q): turns signed
 * deliveries to `POST /webhooks/forgejo` into forge-originated events on the
 * `claws_wait_for_change` stream, so a session can wait for CI or a human
 * action instead of polling the Forgejo API.
 *
 * Deliveries are authenticated by `X-Forgejo-Signature`, the lowercase hex
 * HMAC-SHA256 of the raw body keyed with `forgejoWebhookSecret`. Human-kind
 * events (`forge-*`) from Claws' own logins are dropped, so a Claws comment
 * stays a single `issue-comment`. `ci-status` is the aggregate commit status
 * of an open PR's head, emitted once per transition through the
 * `claws_gate_state` compare-and-set. Forgejo has no run-started webhook, so
 * `forge-push` is the moment CI restarts.
 *
 * {@link mapForgejoDelivery} is pure apart from the reads its context does;
 * {@link handleForgejoDelivery} records what it returns.
 */

import crypto from "node:crypto";
import * as log from "./log.js";
import { safeCompare } from "./internal-mcp-token.js";
import { extractRelatedNumbers, recordGitHubEvent, type GitHubEvent } from "./github-events.js";
import { setGate } from "./gate-events.js";
import { canonicalIssueRef, type IssueRef } from "./issue-id.js";
import { listClawsPrs } from "./db.js";
import * as forgejo from "./forgejo.js";
import type { CheckStatus } from "./github.js";

export type ForgeEvent = Omit<GitHubEvent, "id" | "at">;

/** An event to record; `gate` marks a `ci-status` event set through {@link setGate}. */
export interface MappedForgeEvent {
  event: ForgeEvent;
  gate?: { item: number; name: string };
}

export interface MappedDelivery {
  /** False when the delivery's repo is not a discovered Forgejo repo; `events` is then empty. */
  managed: boolean;
  events: MappedForgeEvent[];
}

/** The open PR a CI run's head SHA belongs to. */
export interface HeadPr {
  number: number;
  /** The tracker issue the `claws_prs` row serves, when known. */
  issueId?: string | null;
  title?: string;
  body?: string;
}

export interface ForgejoDeliveryContext {
  /** Claws' own Forgejo logins (bot and read token), lowercased. */
  selfLogins: Set<string>;
  isManagedRepo: (fullName: string) => boolean | Promise<boolean>;
  /** The open PR whose head is `sha`, or null for a default-branch run. */
  findPrForHead: (repo: string, sha: string) => Promise<HeadPr | null>;
  readCombinedStatus: (repo: string, sha: string) => Promise<CheckStatus>;
}

/** The gate name `ci-status` events are compare-and-set under. */
export const CI_STATUS_GATE = "ci-status";

/** True when `header` is the HMAC-SHA256 of `rawBody` under `secret`, compared in constant time. */
export function verifyForgejoSignature(rawBody: string, header: string | undefined | null, secret: string): boolean {
  if (!header || !secret) return false;
  const expected = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  return safeCompare(header.trim().toLowerCase(), expected);
}

type Obj = Record<string, unknown>;

function obj(v: unknown): Obj | null {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : null;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isInteger(v) && v > 0 ? v : undefined;
}

function sha12(sha: string): string {
  return sha.slice(0, 12);
}

/** Issue-ref related list for an item: the refs in its text, minus the item itself. */
function relatedFrom(text: string, self: number): IssueRef[] {
  return extractRelatedNumbers(text).filter((r) => r !== self);
}

const REVIEW_DETAIL: Record<string, string> = {
  pull_request_approved: "approved",
  pull_request_rejected: "rejected",
  pull_request_comment: "comment",
};

const CI_EVENTS = new Set(["action_run_success", "action_run_failure", "action_run_recover"]);

/** The item's current label names, sorted and comma-joined; undefined when it has none. */
function labelsOf(item: Obj | null): string | undefined {
  const labels = item?.["labels"];
  if (!Array.isArray(labels)) return undefined;
  const names = labels.map((l) => str(obj(l)?.["name"])).filter((n): n is string => !!n).sort();
  return names.length ? names.join(",") : undefined;
}

/** The human-kind event for a non-CI delivery, or null when it maps to nothing. */
function mapHumanDelivery(eventHeader: string, p: Obj, repo: string): ForgeEvent | null {
  const action = str(p["action"]);
  const actor = str(obj(p["sender"])?.["login"]);
  const ev = (kind: GitHubEvent["kind"], number: number, related: IssueRef[], detail?: string): ForgeEvent => ({
    kind, repo, number, related, ...(detail !== undefined ? { detail } : {}),
  });

  if (eventHeader === "issue_comment") {
    if (action !== "created") return null;
    const issue = obj(p["issue"]);
    const number = num(issue?.["number"]);
    if (!number) return null;
    return ev("forge-comment", number, relatedFrom(str(obj(p["comment"])?.["body"]) ?? "", number), actor);
  }

  if (eventHeader === "issues") {
    const issue = obj(p["issue"]);
    const number = num(p["number"]) ?? num(issue?.["number"]);
    if (!number) return null;
    const related = relatedFrom(`${str(issue?.["title"]) ?? ""}\n${str(issue?.["body"]) ?? ""}`, number);
    switch (action) {
      case "label_updated":
      case "label_cleared": return ev("forge-label-changed", number, related, labelsOf(issue));
      case "closed": return ev("forge-issue-closed", number, related, actor);
      case "reopened": return ev("forge-issue-reopened", number, related, actor);
      default: return null;
    }
  }

  const pr = obj(p["pull_request"]);
  const number = num(p["number"]) ?? num(pr?.["number"]);
  if (!number) return null;
  const related = relatedFrom(`${str(pr?.["title"]) ?? ""}\n${str(pr?.["body"]) ?? ""}`, number);

  if (eventHeader === "pull_request") {
    switch (action) {
      case "label_updated":
      case "label_cleared": return ev("forge-label-changed", number, related, labelsOf(pr));
      case "synchronized": {
        const head = str(obj(pr?.["head"])?.["sha"]);
        return ev("forge-push", number, related, head ? sha12(head) : undefined);
      }
      case "closed": return ev(pr?.["merged"] === true ? "forge-pr-merged" : "forge-pr-closed", number, related, actor);
      default: return null;
    }
  }

  const review = REVIEW_DETAIL[eventHeader];
  if (review) return ev("forge-review", number, related, review);
  return null;
}

/** The `ci-status` event for an `action_run_*` delivery, or null when the run's head is no open PR's. */
async function mapCiDelivery(p: Obj, repo: string, ctx: ForgejoDeliveryContext): Promise<MappedForgeEvent | null> {
  const sha = str(obj(p["run"])?.["commit_sha"]);
  if (!sha) return null;
  const pr = await ctx.findPrForHead(repo, sha);
  if (!pr) return null;
  const status = await ctx.readCombinedStatus(repo, sha);
  const related = relatedFrom(`${pr.title ?? ""}\n${pr.body ?? ""}`, pr.number);
  const issueRef = pr.issueId ? canonicalIssueRef(pr.issueId) : null;
  if (issueRef !== null && issueRef !== 0 && !related.includes(issueRef)) related.unshift(issueRef);
  return {
    event: { kind: "ci-status", repo, number: pr.number, related, detail: `${status}:${sha12(sha)}` },
    gate: { item: pr.number, name: CI_STATUS_GATE },
  };
}

/**
 * The open PR whose head is `sha`, confirmed against a fresh read of Forgejo's
 * open-PR list: `claws_prs.headSha` and the cached list both lag a push, so
 * a run on a superseded head must not match and a run on a new head must.
 * The `claws_prs` row only supplies the tracker issue id. Null for a
 * default-branch run.
 */
export async function findOpenPrForHead(repo: string, sha: string): Promise<HeadPr | null> {
  forgejo.invalidatePRList(repo);
  const pr = (await forgejo.listPRs(repo)).find((r) => r.headRefOid === sha);
  if (!pr) return null;
  const row = (await listClawsPrs(repo, { openOnly: true })).find((r) => r.prNumber === pr.number);
  return { number: pr.number, issueId: row?.issueId, title: pr.title, body: pr.body };
}

/** The repo a delivery is about: the payload's `repository`, or an action run's. */
function repoOf(p: Obj): string | undefined {
  return str(obj(p["repository"])?.["full_name"]) ?? str(obj(obj(p["run"])?.["repository"])?.["full_name"]);
}

/**
 * Map one delivery, keyed on the `X-Forgejo-Event` header and the payload's
 * `action`, to the events it should record. An unmanaged repo maps to
 * nothing with `managed: false`; an unknown event or action, or a human-kind
 * event sent by one of Claws' own logins, maps to no events.
 */
export async function mapForgejoDelivery(eventHeader: string, payload: unknown, ctx: ForgejoDeliveryContext): Promise<MappedDelivery> {
  const p = obj(payload);
  const repo = p ? repoOf(p) : undefined;
  if (!p || !repo || !(await ctx.isManagedRepo(repo))) return { managed: false, events: [] };

  if (CI_EVENTS.has(eventHeader)) {
    const ci = await mapCiDelivery(p, repo, ctx);
    return { managed: true, events: ci ? [ci] : [] };
  }

  const sender = str(obj(p["sender"])?.["login"])?.toLowerCase();
  if (sender && ctx.selfLogins.has(sender)) return { managed: true, events: [] };
  const event = mapHumanDelivery(eventHeader, p, repo);
  return { managed: true, events: event ? [{ event }] : [] };
}

/**
 * Map and record one delivery. Returns whether the repo is managed and how
 * many events were recorded — a `ci-status` whose aggregate has not changed
 * since the last delivery records none.
 */
export async function handleForgejoDelivery(
  eventHeader: string,
  payload: unknown,
  ctx: ForgejoDeliveryContext,
): Promise<{ managed: boolean; recorded: number }> {
  const mapped = await mapForgejoDelivery(eventHeader, payload, ctx);
  let recorded = 0;
  for (const { event, gate } of mapped.events) {
    if (gate) {
      if (await setGate(event.repo, gate.item, gate.name, true, event)) recorded++;
    } else {
      recordGitHubEvent(event);
      recorded++;
    }
  }
  if (recorded > 0) log.info(`[forgejo-webhook] ${eventHeader} on ${mapped.events[0]!.event.repo}: recorded ${recorded} event(s)`);
  return { managed: mapped.managed, recorded };
}
