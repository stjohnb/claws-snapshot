/**
 * The Planner's declaration of the Tofu changes an infra PR is expected to make
 * (`claws_save_plan`'s `prs[].infra_changes`), and the comparison the
 * auto-merger runs between it and the verified plan for the PR's head
 * (#clw_01M7096B0VFCVYAA2ED0ZRHFC2). An operator acknowledges every
 * declaration on an issue once (`src/issue-infra-ack.ts`); a PR whose plan
 * stays inside its acknowledged declaration merges without the Approve infra
 * merge button.
 *
 * A leaf: `planner-runs.ts` (in the agent-pod graph) validates with it, so it
 * imports nothing of Claws' own but the leaf `tofu-plan.js`.
 */

import { createHash } from "node:crypto";
import { isInfraWorkflowPath, parseTofuPlanBody, parseTofuPlanRoot, tofuPlanImportCount } from "./tofu-plan.js";

/** The action kinds a plan's resource list uses (production-infra `summarize-plan.sh`, fleet-infra `tofu-plan-comment.sh`). */
export const INFRA_ACTIONS = ["add", "change", "replace", "destroy", "import"] as const;
export type InfraAction = typeof INFRA_ACTIONS[number];

export interface InfraDeclaredResource {
  /** The tofu root directory: `tofu` in production-infra, `tofu/tailscale` in fleet-infra. */
  root: string;
  /**
   * A resource address, matched literally; a trailing `*` matches any address
   * with that prefix — never on a resource whose actions include `destroy` or
   * `replace`, which must be exact.
   */
  address: string;
  actions: InfraAction[];
}

export interface InfraDeclaration {
  resources: InfraDeclaredResource[];
  /** The tofu/terraform workflow and action files the PR edits (`isInfraWorkflowPath`). */
  workflow_files: string[];
}

/**
 * Label the auto-merger puts on a PR it merges under an acknowledged
 * declaration; production-infra's `tofu-apply.yml` then refuses any resource
 * change its merged PR's plan comment did not list.
 */
export const CLAWS_ACK_MERGE_LABEL = "claws-ack-merge";

export const MAX_DECLARED_RESOURCES = 200;
const MAX_WORKFLOW_FILES = 50;
const MAX_FIELD_CHARS = 500;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Validate a raw `infra_changes` object. Returns the normalised declaration
 * (actions de-duplicated and ordered, workflow files de-duplicated) or an
 * error naming the field, without the caller's `prs[N].` prefix.
 */
export function validateInfraDeclaration(raw: unknown): InfraDeclaration | string {
  if (!isRecord(raw)) return "must be an object {resources: [...], workflow_files: [...]}";
  const rawResources = raw["resources"] ?? [];
  if (!Array.isArray(rawResources)) return "resources must be an array of {root, address, actions}";
  if (rawResources.length > MAX_DECLARED_RESOURCES) {
    return `resources has ${rawResources.length} entries — at most ${MAX_DECLARED_RESOURCES} are allowed; use a trailing * wildcard on the address`;
  }
  const resources: InfraDeclaredResource[] = [];
  for (const [i, r] of rawResources.entries()) {
    const at = `resources[${i + 1}]`;
    if (!isRecord(r)) return `${at} must be an object {root, address, actions}`;
    const root = typeof r["root"] === "string" ? r["root"].trim().replace(/\/+$/, "") : "";
    const address = typeof r["address"] === "string" ? r["address"].trim() : "";
    if (!root) return `${at}.root is empty`;
    if (!address) return `${at}.address is empty`;
    if (root.length > MAX_FIELD_CHARS || address.length > MAX_FIELD_CHARS) return `${at} is longer than ${MAX_FIELD_CHARS} characters`;
    if (address.slice(0, -1).includes("*")) return `${at}.address "${address}" has a * that is not its last character — * is only a trailing wildcard`;
    const actions = r["actions"];
    if (!Array.isArray(actions) || actions.length === 0) return `${at}.actions must be a non-empty array of ${INFRA_ACTIONS.join("|")}`;
    const bad = actions.find((a) => !(INFRA_ACTIONS as readonly unknown[]).includes(a));
    if (bad !== undefined) return `${at}.actions has "${String(bad)}" — use ${INFRA_ACTIONS.join("|")}`;
    // Destroy consent is exact (src/destroy-consent.ts): approving the plan approves destroying exactly the addresses it names.
    if (address.endsWith("*") && (actions.includes("destroy") || actions.includes("replace"))) {
      return `${at}.address "${address}" uses a * wildcard with destroy or replace — name every destroyed or replaced resource by its exact address`;
    }
    resources.push({ root, address, actions: INFRA_ACTIONS.filter((a) => actions.includes(a)) });
  }
  const rawFiles = raw["workflow_files"] ?? [];
  if (!Array.isArray(rawFiles)) return "workflow_files must be an array of paths";
  if (rawFiles.length > MAX_WORKFLOW_FILES) return `workflow_files has ${rawFiles.length} entries — at most ${MAX_WORKFLOW_FILES} are allowed`;
  const files: string[] = [];
  for (const [i, f] of rawFiles.entries()) {
    const path = typeof f === "string" ? f.trim().replace(/^\.\//, "") : "";
    if (!path) return `workflow_files[${i + 1}] is empty`;
    if (!isInfraWorkflowPath(path)) {
      return `workflow_files[${i + 1}] "${path}" is not a tofu/terraform workflow or action file under .forgejo/ or .github/ — list only those`;
    }
    if (!files.includes(path)) files.push(path);
  }
  if (resources.length === 0 && files.length === 0) return "declares nothing — list resources or workflow_files, or omit infra_changes";
  return { resources, workflow_files: files };
}

/** A declaration in canonical form: resources sorted by root, address; files sorted. */
function canonical(d: InfraDeclaration): InfraDeclaration {
  return {
    resources: [...d.resources]
      .map((r) => ({ root: r.root, address: r.address, actions: INFRA_ACTIONS.filter((a) => r.actions.includes(a)) }))
      .sort((a, b) => a.root.localeCompare(b.root) || a.address.localeCompare(b.address) || a.actions.join().localeCompare(b.actions.join())),
    workflow_files: [...d.workflow_files].sort(),
  };
}

/**
 * sha256 of every planned PR's declaration in canonical form, keyed by the
 * PR's repo, so a re-plan that keeps every declaration identical keeps the
 * hash and any change to one changes it. Entries without a declaration do not
 * contribute.
 */
export function declarationsHash(entries: readonly { repo: string; infraChanges?: InfraDeclaration | null }[]): string {
  const list = entries
    .filter((e): e is { repo: string; infraChanges: InfraDeclaration } => !!e.infraChanges)
    .map((e) => JSON.stringify({ repo: e.repo.toLowerCase(), declaration: canonical(e.infraChanges) }))
    .sort();
  return createHash("sha256").update(JSON.stringify(list)).digest("hex");
}

/**
 * One root's resource list from a plan comment. `kind` is one of
 * {@link INFRA_ACTIONS}, or the raw text of a kind the publishing scripts do
 * not emit, which no declaration can match.
 */
export interface TofuPlanResourceBlock {
  root: string;
  resources: { address: string; kind: InfraAction | (string & {}) }[];
}

const RESOURCE_BLOCK = /```tofu-plan-resources[ \t]*\r?\n([\s\S]*?)```/;

/**
 * The fenced `tofu-plan-resources` block of a plan comment: a `root: <dir>`
 * first line, then one `<address>\t<kind>` line per resource. Null when the
 * comment has no block or the block has no root line. An unknown kind (a
 * typo, a future action, a format change) is kept as written so the matcher
 * fails closed on it rather than reading it as `change`.
 */
export function parseTofuPlanResourceBlock(body: string): TofuPlanResourceBlock | null {
  const m = RESOURCE_BLOCK.exec(body);
  if (!m) return null;
  const lines = m[1]!.split(/\r?\n/).map((l) => l.trimEnd()).filter((l) => l.trim() !== "");
  const head = /^root:\s*(\S+)\s*$/.exec(lines[0] ?? "");
  if (!head) return null;
  const resources: TofuPlanResourceBlock["resources"] = [];
  for (const line of lines.slice(1)) {
    const tab = line.lastIndexOf("\t");
    if (tab <= 0) continue;
    const address = line.slice(0, tab).trim();
    const raw = line.slice(tab + 1).trim();
    if (address && raw) resources.push({ address, kind: raw });
  }
  return { root: head[1]!.replace(/\/+$/, ""), resources };
}

/**
 * The resource block of one plan comment, checked against the rest of the
 * comment, or why it cannot be trusted. A block cut short would otherwise
 * pass every resource it leaves out, so the comment must carry its counts
 * (`parseTofuPlanBody`), must not be `Output truncated` (production-infra caps
 * the comment at 60 000 characters), must name the same root as its
 * `### Tofu Plan: <dir>` heading when it has one, and the block's entries must
 * account for the counts under the publishing scripts' convention
 * (production-infra `summarize-plan.sh`, fleet-infra `tofu-plan-comment.sh`):
 * `add`, `replace` and `destroy` lines equal those counts, and `change` lines
 * are at least the `to change` count (fleet-infra's `**N to import**`, which
 * `parseTofuPlanBody` folds into `change`, taken back out). The block's
 * `change` also carries actions the counts leave out (a `read`), hence at least.
 */
export function readTofuPlanResourceBlock(body: string): TofuPlanResourceBlock | string {
  const block = parseTofuPlanResourceBlock(body);
  if (!block) return "plan comment has no resource list";
  const plan = parseTofuPlanBody(body);
  if (!plan) return "plan comment has no counts";
  if (/Output truncated/i.test(body)) return "plan comment is truncated";
  const headingRoot = parseTofuPlanRoot(body);
  if (headingRoot !== null && headingRoot.replace(/\/+$/, "") !== block.root) {
    return `plan comment resource list names root ${block.root}, not ${headingRoot}`;
  }
  const count = (kind: InfraAction) => block.resources.filter((r) => r.kind === kind).length;
  const changes = plan.change - tofuPlanImportCount(body);
  if (count("add") !== plan.add || count("replace") !== plan.replace || count("destroy") !== plan.destroy || count("change") < changes) {
    return "plan comment resource list does not match its counts";
  }
  return block;
}

export type InfraDeclarationMatch = { ok: true } | { ok: false; unexpected: string[] };

function addressMatches(declared: string, actual: string): boolean {
  return declared.endsWith("*") ? actual.startsWith(declared.slice(0, -1)) : declared === actual;
}

/**
 * Whether a verified plan and a PR's changed files stay inside `declaration`.
 * An actual change matches a declared resource with the same root, an equal
 * address (or one its trailing `*` covers) and an action list holding that
 * kind; an `import` never needs declaring. A plan doing less than declared
 * passes. Every changed tofu/terraform workflow or action file must be listed
 * in `workflow_files`. Returns every unexpected item, one line each.
 */
export function matchInfraDeclaration(
  declaration: InfraDeclaration,
  roots: readonly TofuPlanResourceBlock[],
  changedFiles: readonly string[],
): InfraDeclarationMatch {
  const unexpected: string[] = [];
  for (const block of roots) {
    const changes = block.resources.filter((r) => r.kind !== "import");
    if (changes.length === 0) continue;
    const inRoot = declaration.resources.filter((d) => d.root === block.root);
    if (inRoot.length === 0) unexpected.push(`root ${block.root} not declared`);
    for (const r of changes) {
      const byAddress = inRoot.filter((d) => addressMatches(d.address, r.address));
      if (byAddress.some((d) => (d.actions as readonly string[]).includes(r.kind))) continue;
      const declaredAs = [...new Set(byAddress.flatMap((d) => d.actions))];
      unexpected.push(`${block.root}: ${r.address} ${r.kind} not declared${declaredAs.length > 0 ? ` (declared as ${declaredAs.join(", ")})` : ""}`);
    }
  }
  for (const f of changedFiles) {
    if (isInfraWorkflowPath(f) && !declaration.workflow_files.includes(f)) unexpected.push(`workflow file ${f} not declared`);
  }
  return unexpected.length === 0 ? { ok: true } : { ok: false, unexpected };
}

/** Total declared resources and the roots they sit in, for the dashboard summary. */
export function declarationRoots(d: InfraDeclaration): string[] {
  return [...new Set(d.resources.map((r) => r.root))].sort();
}
