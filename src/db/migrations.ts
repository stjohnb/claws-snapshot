// Data migrations: idempotent `migrate*` passes run at controller boot (and,
// for the gate-label pass, by the issue dispatcher). Reached only through the
// src/db.ts façade.
import { CAPABILITY_RENAMES, RETIRED_CAPABILITIES, renameCapabilityIds } from "../capability-renames.js";
import * as log from "../log.js";
import * as logCore from "../log-core.js";
import { RETIRED_GATE_LABELS, STATE_LABELS, lifecycleForLabel } from "../issue-lifecycle.js";
import { atLeast, isApprovedThrough, maxApproval, type ApprovedThrough } from "../issue-approval.js";
import { getDb, nowSql, timedDb } from "./core.js";
import { nodeAliases, type NodeAliases } from "../node-names.js";
import { readControllerStatus } from "./usage.js";
import { skipQueuedWorkForItem } from "./work-queue.js";
import { getImportedIssueByNative } from "./imported-issues.js";
// Not yet split out of the façade (#clw_01M8A3RZ47A1W7E28W43TAFJ3G PR 3–4).
import { ENTRY_LIFECYCLE_SQL } from "../db.js";

/**
 * Retire the `manual-action` PR stage and the `Manual Action` label
 * (#clw_01M4TABN7ZFQ3MG5KK85GFGWNK). A PR hold is the row's
 * `manual_action_reason` alone, so a row at the old stage moves to
 * `ci-failing` when its CI fails and `awaiting-review` otherwise; the next
 * review pass corrects it from there. Native issues drop the label
 * (DMARC alert issues use `Blocked` instead). Idempotent, so it runs every
 * boot.
 */
export async function migrateRetiredManualAction(): Promise<void> {
  return timedDb("migrate-retired-manual-action", () => migrateRetiredManualActionUntimed());
}

async function migrateRetiredManualActionUntimed(): Promise<void> {
  await getDb().run(`UPDATE claws_prs SET stage = CASE WHEN ci_status = 'failing' THEN 'ci-failing' ELSE 'awaiting-review' END WHERE stage = 'manual-action'`);
  await getDb().run(`DELETE FROM claws_issue_labels WHERE label = 'Manual Action'`);
}

/**
 * Rewrite renamed capability ids (`CAPABILITY_RENAMES`, e.g. `ssh:k3s` and
 * `ssh:homeassistant` -> `ssh:thinkcentre`) in stored session grants,
 * remembered form defaults and capability-request rows. A request row for an
 * old id is dropped when the same session already has one for the new id, so
 * the new row's status (a revoke or denial included) wins
 * (#clw_01M7Q9T4AQAGSG48Z3P7B273HR). Idempotent and DDL-free, so it runs every
 * controller boot with no SCHEMA_VERSION bump. Unparseable rows are skipped.
 */
export async function migrateRenamedCapabilities(): Promise<void> {
  return timedDb("migrate-renamed-capabilities", () => migrateRenamedCapabilitiesUntimed());
}

async function migrateRenamedCapabilitiesUntimed(): Promise<void> {
  const where = Object.keys(CAPABILITY_RENAMES).map((old) => `capabilities LIKE '%"${old}"%'`).join(" OR ");
  for (const [table, key] of [["sessions", "id"], ["session_capability_defaults", "repo_key"]] as const) {
    const rows = await getDb().all(`SELECT ${key} AS k, capabilities FROM ${table} WHERE ${where}`) as Array<{ k: string; capabilities: string }>;
    for (const row of rows) {
      let ids: unknown;
      try { ids = JSON.parse(row.capabilities); } catch { continue; }
      if (!Array.isArray(ids) || !ids.every((i) => typeof i === "string")) continue;
      await getDb().run(`UPDATE ${table} SET capabilities = ? WHERE ${key} = ?`, [JSON.stringify(renameCapabilityIds(ids as string[])), row.k]);
    }
  }
  for (const [oldId, newId] of Object.entries(CAPABILITY_RENAMES)) {
    await getDb().run(
      `DELETE FROM session_capability_requests WHERE capability = ? AND session_id IN (SELECT session_id FROM session_capability_requests WHERE capability = ?)`,
      [oldId, newId],
    );
    await getDb().run(`UPDATE session_capability_requests SET capability = ? WHERE capability = ?`, [newId, oldId]);
  }
}

/**
 * Strip retired capability ids (`RETIRED_CAPABILITIES`, e.g. `infra-merge`)
 * from stored session grants and remembered form defaults, and mark their
 * pending capability requests denied. Idempotent and DDL-free, so it runs
 * every controller boot with no SCHEMA_VERSION bump. Unparseable rows are
 * skipped.
 */
export async function migrateRetiredCapabilities(): Promise<void> {
  return timedDb("migrate-retired-capabilities", () => migrateRetiredCapabilitiesUntimed());
}

async function migrateRetiredCapabilitiesUntimed(): Promise<void> {
  const retired = Object.keys(RETIRED_CAPABILITIES);
  if (retired.length === 0) return;
  const where = retired.map((id) => `capabilities LIKE '%"${id}"%'`).join(" OR ");
  for (const [table, key] of [["sessions", "id"], ["session_capability_defaults", "repo_key"]] as const) {
    const rows = await getDb().all(`SELECT ${key} AS k, capabilities FROM ${table} WHERE ${where}`) as Array<{ k: string; capabilities: string }>;
    for (const row of rows) {
      let ids: unknown;
      try { ids = JSON.parse(row.capabilities); } catch { continue; }
      if (!Array.isArray(ids) || !ids.every((i) => typeof i === "string")) continue;
      const kept = (ids as string[]).filter((i) => !retired.includes(i));
      if (kept.length === ids.length) continue;
      await getDb().run(`UPDATE ${table} SET capabilities = ? WHERE ${key} = ?`, [JSON.stringify(kept), row.k]);
    }
  }
  const placeholders = retired.map(() => "?").join(", ");
  await getDb().run(
    `UPDATE session_capability_requests SET status = 'denied', decided_at = ?, decided_by = 'auto' WHERE status = 'pending' AND capability IN (${placeholders})`,
    [Date.now(), ...retired],
  );
}

/** Rows `migrateRenamedNodes` rewrote, per table. */
export interface RenamedNodeCounts {
  sessions: number;
  sessionMoves: number;
  nodeEvacuations: number;
}

/**
 * Rewrite each old node name in `aliases` (default `CLAWS_NODE_ALIASES`) to its
 * new one in `sessions.node`, `session_moves.from_node`/`to_node` and
 * `node_evacuations.node` (#clw_01M7RBFFEM2C6DQD1C3Z3EAEZ8), so stored rows use
 * the names placement and readiness use. An evacuation row under the old name
 * is left alone when one under the new name already exists. Logs one `info`
 * line with the counts when any row changed. Idempotent and DDL-free, so it
 * runs every controller boot with no SCHEMA_VERSION bump.
 */
export async function migrateRenamedNodes(aliases: NodeAliases = nodeAliases()): Promise<RenamedNodeCounts> {
  return timedDb("migrate-renamed-nodes", () => migrateRenamedNodesUntimed(aliases));
}

async function migrateRenamedNodesUntimed(aliases: NodeAliases): Promise<RenamedNodeCounts> {
  const counts: RenamedNodeCounts = { sessions: 0, sessionMoves: 0, nodeEvacuations: 0 };
  for (const [from, to] of aliases) {
    counts.sessions += (await getDb().run(`UPDATE sessions SET node = ? WHERE node = ?`, [to, from])).changes;
    counts.sessionMoves += (await getDb().run(`UPDATE session_moves SET from_node = ? WHERE from_node = ?`, [to, from])).changes;
    counts.sessionMoves += (await getDb().run(`UPDATE session_moves SET to_node = ? WHERE to_node = ?`, [to, from])).changes;
    counts.nodeEvacuations += (await getDb().run(
      `UPDATE node_evacuations SET node = ? WHERE node = ? AND NOT EXISTS (SELECT 1 FROM node_evacuations WHERE node = ?)`,
      [to, from, to],
    )).changes;
  }
  if (counts.sessions + counts.sessionMoves + counts.nodeEvacuations > 0) {
    log.info("renamed nodes in stored rows", {
      component: "node-rename",
      sessions: counts.sessions,
      session_moves: counts.sessionMoves,
      node_evacuations: counts.nodeEvacuations,
    });
  }
  return counts;
}

/**
 * Fold sessions stored with the retired `multi-worktree-claude` mode into
 * `worktree-claude`: a worktree session with `extra_worktrees` set is the
 * multi-repo session now, so list, resume and worktree restore keep working.
 * Idempotent and DDL-free, so it runs every controller boot with no
 * SCHEMA_VERSION bump.
 */
export async function migrateLegacyMultiWorktreeSessions(): Promise<void> {
  return timedDb("migrate-legacy-multi-worktree-sessions", () => getDb().run(`UPDATE sessions SET mode = 'worktree-claude' WHERE mode = 'multi-worktree-claude'`).then(() => undefined));
}

/**
 * The issue-reference columns widened to TEXT so a Claws-native `clw_…` id can
 * be stored beside a forge number (#3215). `ci_fixer_breaker.item_number` is
 * deliberately absent: it is keyed by PR, and PRs are always forge-numbered.
 */
const ISSUE_REF_COLUMNS: ReadonlyArray<readonly [table: string, column: string]> = [
  ["tasks", "item_number"],
  ["work_queue", "item_number"],
  ["notified_untrusted_actors", "issue_number"],
  ["reminder_notifications", "issue_number"],
  ["upstream_watch_fires", "issue_number"],
  ["blog_draft_ports", "issue_number"],
];

/**
 * Backfill `claws_issues.lifecycle` from the `Blocked` / `Backlog` label
 * rows it replaced, then delete those rows. The retired `Ready` and
 * `Refined` rows are {@link migrateGateLabelsToApprovedThrough}'s.
 *
 * Runs every boot and is idempotent: once no state label rows remain, every
 * statement matches nothing. The UPDATEs run in ascending precedence
 * (Blocked, Backlog) so the highest one an issue carries is the one left
 * standing — the board's `columnFor` order. Shadows are covered too; they are
 * `claws_issues` rows like any other. Plain UPDATE-with-EXISTS then DELETE, so
 * the same SQL runs on SQLite and Postgres.
 *
 * @internal Exported for `db.test.ts`, which writes the old label rows back to
 * exercise a migration a freshly created schema never needs.
 */
export async function migrateStateLabelsToLifecycle(): Promise<void> {
  return timedDb("migrate-state-labels-to-lifecycle", () => migrateStateLabelsToLifecycleUntimed());
}

async function migrateStateLabelsToLifecycleUntimed(): Promise<void> {
  for (const label of [...STATE_LABELS].reverse()) {
    await getDb().run(
      `UPDATE claws_issues SET lifecycle = ?
        WHERE EXISTS (SELECT 1 FROM claws_issue_labels l WHERE l.issue_id = claws_issues.id AND l.label = ?)`,
      [lifecycleForLabel(label), label],
    );
  }
  await getDb().run(
    `DELETE FROM claws_issue_labels WHERE label IN (${STATE_LABELS.map(() => "?").join(", ")})`,
    [...STATE_LABELS],
  );
}

/**
 * Fill `claws_issues.approved_through` from the retired gate labels and the
 * retired `approved` lifecycle (#clw_01M5VW14RKAAGS6VZ5PCKQXB9F), then
 * delete those label rows. Per issue, the highest of:
 *
 * - `merge` — an `Automerge` label row on an issue the rules below already
 *   approve through Plan (a single PR's own merge approval stays on its
 *   `claws_prs` row, the partial Merge state). `Automerge` was only ever a
 *   merge pre-approval, and `merge` also approves the plan, so on an issue
 *   with no plan approval it is dropped and logged by issue id — the one
 *   value cannot hold "merge approved, plan not" — for an operator to
 *   re-approve through Merge once the plan is reviewed;
 * - `plan` — lifecycle `approved`, or a `Refined` or `Ship` row: a plan
 *   approval someone already gave;
 * - `plan` too for a `Claws Auto-Refine` row or a `[ci-unrelated]` title (the
 *   refiner used to approve those trackers by title), but only while no plan
 *   awaits review — lifecycle `ideas` or `planning` and no `Ready` row. Those
 *   approved only a plan not yet written, and the refiner held back one it
 *   had posted (a `reconsider` verdict, say), so such a plan stays for a human;
 * - `requirements` — approved requirements, or a lifecycle past Ideas.
 *
 * The first run, recorded under {@link APPROVED_THROUGH_MIGRATED_KEY} in
 * `controller_status` in the same transaction, applies every rule to the
 * rows never written since the column arrived (`approved_through_at IS
 * NULL`) and to every row holding a gate label or the `approved` lifecycle,
 * so an issue approved through Requirements since keeps its gate labels'
 * approval. Later runs, while leftover gate label rows or an `approved`
 * lifecycle remain (an old-build pod during a rollout — the issue dispatcher
 * runs this pass every tick, so it does not wait for the next controller
 * boot), consider only the issues that
 * hold one and raise them from those labels and that lifecycle alone, so a
 * later issue is never approved by its title. The value only
 * ever rises, so it is idempotent, and a withdrawal is undone only by a fresh
 * gate label. An issue with a plan and any open or merged phase PR rises to
 * `plan` too: the implementer removed `Refined` while a step's PR was open.
 * `approved_through_by` reads `migration`, and a raise through
 * Plan sets `plan_approved_at`. Then `approved`
 * becomes `awaiting-plan-review` and a `Ready` or `Refined` row moves an
 * issue still in Ideas or Planning there. One transaction, plain SQL on both
 * drivers.
 *
 * Run by `migrateSchema` at boot and by the issue dispatcher each tick.
 */
export async function migrateGateLabelsToApprovedThrough(): Promise<void> {
  return timedDb("migrate-gate-labels-to-approved-through", () => migrateGateLabelsToApprovedThroughUntimed());
}

async function migrateGateLabelsToApprovedThroughUntimed(): Promise<void> {
  const gateParams = RETIRED_GATE_LABELS.map(() => "?").join(", ");
  const holdsGateState = `(lifecycle = 'approved'
       OR EXISTS (SELECT 1 FROM claws_issue_labels l WHERE l.issue_id = claws_issues.id AND l.label IN (${gateParams})))`;
  const pending = await getDb().get(
    `SELECT 1 AS n FROM claws_issues WHERE ${holdsGateState} LIMIT 1`,
    [...RETIRED_GATE_LABELS],
  ) as { n: number } | undefined;
  const firstRun = (await readControllerStatus<unknown>(APPROVED_THROUGH_MIGRATED_KEY)) === null;
  if (!pending && !firstRun) return;
  await getDb().transaction(async (tx) => {
    const rows = await tx.all(
      `SELECT id, title, lifecycle, requirements_approved_at, approved_through FROM claws_issues
        WHERE ${firstRun ? `approved_through_at IS NULL OR ${holdsGateState}` : holdsGateState}`,
      [...RETIRED_GATE_LABELS],
    ) as Array<{ id: string; title: string; lifecycle: string; requirements_approved_at: string | null; approved_through: string }>;
    const labelRows = await tx.all(
      `SELECT issue_id, label FROM claws_issue_labels WHERE label IN (${gateParams})`,
      [...RETIRED_GATE_LABELS],
    ) as Array<{ issue_id: string; label: string }>;
    const labels = new Map<string, Set<string>>();
    for (const r of labelRows) labels.set(r.issue_id, (labels.get(r.issue_id) ?? new Set()).add(r.label));
    // The implementer removed `Refined` while a step's PR was open, so an issue
    // with a plan and any open or merged PR is mid-plan and stays approved through Plan.
    const inFlight = new Set((await tx.all(
      `SELECT DISTINCT p.issue_id FROM claws_prs p JOIN claws_issue_plans pl ON pl.issue_id = p.issue_id WHERE p.stage <> 'closed'`,
    ) as Array<{ issue_id: string }>).map((r) => r.issue_id));
    const now = nowSql();
    for (const row of rows) {
      const held = labels.get(row.id) ?? new Set<string>();
      let value: ApprovedThrough = isApprovedThrough(row.approved_through) ? row.approved_through : "none";
      // A Ready or Refined row moves the issue past Ideas below, so it counts as past Ideas here.
      const pastIdeas = ["planning", "awaiting-plan-review", "approved"].includes(row.lifecycle) || held.has("Ready") || held.has("Refined");
      if (row.requirements_approved_at !== null || pastIdeas) value = maxApproval(value, "requirements");
      if (row.lifecycle === "approved" || held.has("Refined") || held.has("Ship") || inFlight.has(row.id)) value = maxApproval(value, "plan");
      // A standing pre-approval covers only a plan still to come.
      const noPlanAwaitingReview = (row.lifecycle === "ideas" || row.lifecycle === "planning") && !held.has("Ready");
      if (noPlanAwaitingReview && (held.has("Claws Auto-Refine") || (firstRun && row.title.startsWith("[ci-unrelated]")))) {
        value = maxApproval(value, "plan");
      }
      if (held.has("Automerge")) {
        if (atLeast(value, "plan")) value = maxApproval(value, "merge");
        else logCore.warn(`[db] ${row.id}: dropped its Automerge merge pre-approval — its plan is not approved; approve it through Merge once the plan is reviewed`);
      }
      if (value === row.approved_through) continue;
      const risesThroughPlan = atLeast(value, "plan") && !atLeast(row.approved_through, "plan");
      await tx.run(
        `UPDATE claws_issues SET approved_through = ?, approved_through_by = 'migration', approved_through_at = ?${risesThroughPlan ? ", plan_approved_at = ?" : ""} WHERE id = ?`,
        [value, now, ...(risesThroughPlan ? [now] : []), row.id],
      );
    }
    // The derived Approved column keeps an `approved` card where it was, so its time-in-column stands.
    await tx.run(`UPDATE claws_issues SET lifecycle = 'awaiting-plan-review' WHERE lifecycle = 'approved'`);
    await tx.run(
      `UPDATE claws_issues SET lifecycle = 'awaiting-plan-review', stage_changed_at = ?
        WHERE lifecycle IN ('ideas', 'planning')
          AND EXISTS (SELECT 1 FROM claws_issue_labels l WHERE l.issue_id = claws_issues.id AND l.label IN ('Ready', 'Refined'))`,
      [now],
    );
    await tx.run(`DELETE FROM claws_issue_labels WHERE label IN (${gateParams})`, [...RETIRED_GATE_LABELS]);
    if (firstRun) {
      await tx.run(
        `INSERT INTO controller_status (key, value_json, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
        [APPROVED_THROUGH_MIGRATED_KEY, JSON.stringify(true), now],
      );
    }
  });
}

/** The `controller_status` key that records {@link migrateGateLabelsToApprovedThrough}'s first run. */
export const APPROVED_THROUGH_MIGRATED_KEY = "approved_through_migrated";

/** Title prefixes the alert paths filed under before `alert_kind` existed. */
const LEGACY_ALERT_TITLE_PREFIXES = [
  "[claws-error]", "[ci-unrelated]", "[runner-monitor]", "[host-disk-monitor]", "[dmarc]", "[snapshot]",
  "[upstream-watcher]", "[disallowed-actor]", "[main]", "Build failure: ",
];

/**
 * Copy every non-null `claws_issues.dedupe_key` into `claws_issue_dedupe_keys`,
 * dated by the issue's `created_at`. Runs on every controller boot, not once:
 * a previous-release pod still serving during a rollout writes the column, and
 * a later boot picks its key up. `INSERT OR IGNORE`, so a key already copied
 * is a no-op, and cheap — the partial index `idx_claws_issues_dedupe_key`
 * covers the non-null rows. The column is left in place so previous-release
 * pods keep finding the keys they wrote; every write in this build that drops
 * an issue's key clears the issue's column in the same transaction, so a stale
 * column value never brings a dropped key back.
 *
 * @internal Exported for `db.test.ts`.
 */
export async function migrateDedupeKeysToTable(): Promise<void> {
  return timedDb("migrate-dedupe-keys-to-table", () => migrateDedupeKeysToTableUntimed());
}

async function migrateDedupeKeysToTableUntimed(): Promise<void> {
  await getDb().run(
    `INSERT OR IGNORE INTO claws_issue_dedupe_keys (issue_id, dedupe_key, created_at)
     SELECT id, dedupe_key, created_at FROM claws_issues WHERE dedupe_key IS NOT NULL`,
  );
}

/** The `controller_status` key that records {@link migrateAlertKindBackfill}'s run. */
export const ALERT_KIND_BACKFILLED_KEY = "alert_kind_backfilled";

/**
 * Mark the open alert issues filed before `claws_issues.alert_kind` existed
 * as `legacy`, once: an open issue by `claws` whose title or filed title
 * starts with one of {@link LEGACY_ALERT_TITLE_PREFIXES}, whose dedupe key
 * starts `alert-`, or that carries an `alert` / `grafana-alert` label. A
 * recurring alert the prefixes miss marks itself on its next occurrence
 * (`ensureAlertIssue`'s update path). Recorded under
 * {@link ALERT_KIND_BACKFILLED_KEY} in the same transaction.
 *
 * @internal Exported for `db.test.ts`.
 */
export async function migrateAlertKindBackfill(): Promise<void> {
  return timedDb("migrate-alert-kind-backfill", () => migrateAlertKindBackfillUntimed());
}

async function migrateAlertKindBackfillUntimed(): Promise<void> {
  if ((await readControllerStatus<unknown>(ALERT_KIND_BACKFILLED_KEY)) !== null) return;
  const titleClauses = LEGACY_ALERT_TITLE_PREFIXES.map(() => `title LIKE ? OR filed_title LIKE ?`).join(" OR ");
  const titleParams = LEGACY_ALERT_TITLE_PREFIXES.flatMap((prefix) => [`${prefix}%`, `${prefix}%`]);
  await getDb().transaction(async (tx) => {
    await tx.run(
      `UPDATE claws_issues SET alert_kind = 'legacy'
        WHERE state = 'open' AND kind <> 'shadow' AND author_login = 'claws' AND alert_kind IS NULL
          AND (${titleClauses}
            OR EXISTS (SELECT 1 FROM claws_issue_dedupe_keys k WHERE k.issue_id = claws_issues.id AND k.dedupe_key LIKE 'alert-%')
            OR EXISTS (SELECT 1 FROM claws_issue_labels l WHERE l.issue_id = claws_issues.id AND l.label IN ('alert', 'grafana-alert')))`,
      titleParams,
    );
    await tx.run(
      `INSERT INTO controller_status (key, value_json, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
      [ALERT_KIND_BACKFILLED_KEY, JSON.stringify(true), nowSql()],
    );
  });
}

/**
 * Move issues off the lifecycle values the requirements stage retired
 * (#clw_01M39G3SREWPRP5AH0THJR0P24): `awaiting-review` becomes
 * `awaiting-plan-review`, and `inbox` becomes `planning` for an issue that
 * already has a plan or an approved requirements version — the same
 * predicate `clawsIssues.entryLifecycle` and `ENTRY_LIFECYCLE_SQL` use, so
 * every path that decides "has this issue's requirements been approved"
 * agrees, plus a shadow, which gets no `ENTRY_LIFECYCLE_SQL` exception: a
 * shadow's plan lives on the forge, not in `claws_issue_plans` (only a native
 * plan comment writes that table), so the general predicate alone would send
 * a planned forge issue sitting in `inbox` to Ideas. A forge issue that
 * reached the old Inbox had already been through the forge flow, and the
 * forge has no Ideas stage to send it back to, so every shadow goes straight
 * to Planning here — and `ideas` for whatever native issue is left.
 *
 * The same pass backfills `source` on every row that predates it, matched on
 * `source IS NULL` and re-run every boot rather than gated to the one that
 * adds the column: a shadow is `forge`, an issue Claws itself filed
 * (`author_login = 'claws'`) is `automation`, and everything else is
 * `dashboard`. A boot that fails partway through — after the column is added
 * but before this runs — still finds every unbackfilled row NULL on its next
 * attempt, rather than leaving them stuck under the column's old default
 * forever. `createShadowIssue` and `createClawsIssue` write a non-NULL source
 * outright, so a re-run touches nothing a prior run or a normal create
 * already set.
 *
 * The lifecycle rename itself still runs every boot but does nothing unless
 * some row still holds `inbox` or `awaiting-review`, and moves every such
 * row, so a second run changes nothing there either. The queued-planner skip
 * below it runs unconditionally instead, keyed on current state
 * (`lifecycle = 'ideas'`) rather than on which rows this run's rename just
 * touched: a boot that dies between the rename's commit and that skip would
 * otherwise leave a queued `issue-refiner:` row free to bypass the promotion
 * gate forever, since the next boot's `pending` check finds nothing left to
 * rename and never revisits it.
 *
 * @internal Exported for `db.test.ts`.
 */
export async function migrateInboxToIdeas(): Promise<void> {
  return timedDb("migrate-inbox-to-ideas", () => migrateInboxToIdeasUntimed());
}

async function migrateInboxToIdeasUntimed(): Promise<void> {
  await getDb().run(
    `UPDATE claws_issues SET source = CASE WHEN kind = 'shadow' THEN 'forge' WHEN author_login = 'claws' THEN 'automation' ELSE 'dashboard' END WHERE source IS NULL`,
  );
  const pending = await getDb().get(
    `SELECT 1 AS n FROM claws_issues WHERE lifecycle IN ('inbox', 'awaiting-review') LIMIT 1`,
  ) as { n: number } | undefined;
  if (pending) {
    await getDb().transaction(async (tx) => {
      await tx.run(`UPDATE claws_issues SET lifecycle = 'awaiting-plan-review' WHERE lifecycle = 'awaiting-review'`);
      await tx.run(
        `UPDATE claws_issues SET lifecycle = 'planning' WHERE lifecycle = 'inbox' AND kind = 'shadow'`,
      );
      await tx.run(`UPDATE claws_issues SET lifecycle = ${ENTRY_LIFECYCLE_SQL} WHERE lifecycle = 'inbox'`);
    });
  }
  // Keyed on current state, not on the rename above — see the docblock.
  const inIdeas = await getDb().all(`SELECT id FROM claws_issues WHERE lifecycle = 'ideas'`) as Array<{ id: string }>;
  for (const row of inIdeas) {
    await skipQueuedPlannerWork(row.id, "issue is in Ideas");
  }
}

/**
 * Retire the `Claws Ignore` label from the native tracker
 * (#clw_01M55F0ACDZP8ND1BNRZ8TNGPD): an open issue or shadow that carries it
 * moves to the Backlog, so it stays parked, and then every `Claws Ignore`
 * label row is deleted — a closed issue just loses the row.
 *
 * Runs every boot and is idempotent: once no label row remains, both
 * statements match nothing. `stage_changed_at` and `updated_at` move only
 * for a row whose lifecycle actually changes.
 *
 * @internal Exported for `db.test.ts`.
 */
export async function migrateClawsIgnoreLabel(): Promise<void> {
  return timedDb("migrate-claws-ignore-label", () => migrateClawsIgnoreLabelUntimed());
}

async function migrateClawsIgnoreLabelUntimed(): Promise<void> {
  const now = nowSql();
  await getDb().transaction(async (tx) => {
    await tx.run(
      `UPDATE claws_issues SET lifecycle = 'backlog', stage_changed_at = ?, updated_at = ?
        WHERE state = 'open' AND lifecycle <> 'backlog'
          AND EXISTS (SELECT 1 FROM claws_issue_labels l WHERE l.issue_id = claws_issues.id AND l.label = 'Claws Ignore')`,
      [now, now],
    );
    await tx.run(`DELETE FROM claws_issue_labels WHERE label = 'Claws Ignore'`);
  });
}

/**
 * Skip any `issue-refiner:` work still queued for an issue that just moved to
 * Ideas — a demotion, or {@link migrateInboxToIdeas} — so a queued planner run
 * cannot bypass the gate every issue reaching Ideas the normal way is subject
 * to. A shadow's queued row is keyed by the forge ref `getImportedIssueByNative`
 * names; a native issue's may be queued under any repo it is assigned to,
 * since the dispatcher enqueues `issue-refiner:` work per repo it dispatches
 * from. Shared by both callers so they agree on which repos' queued rows get
 * skipped.
 */
export async function skipQueuedPlannerWork(issueId: string, reason: string): Promise<void> {
  const imported = await getImportedIssueByNative(issueId);
  if (imported) {
    await skipQueuedWorkForItem("issue-refiner:", imported.repo, imported.forgeNumber, reason);
    return;
  }
  const repos = await getDb().all(`SELECT repo FROM claws_issue_repos WHERE issue_id = ?`, [issueId]) as Array<{ repo: string }>;
  for (const { repo } of repos) {
    await skipQueuedWorkForItem("issue-refiner:", repo, issueId, reason);
  }
}

/**
 * Widen the {@link ISSUE_REF_COLUMNS} from BIGINT to TEXT on an existing
 * Postgres database.
 *
 * SQLite needs nothing: `CREATE TABLE` above already declares TEXT, and its
 * column affinity is per-value anyway, so an old file keeps working. Postgres
 * is strict, so the live database has to be rewritten in place.
 *
 * All six ALTERs go out as **one** `exec()` string wrapped in an explicit
 * transaction, over the simple protocol: either every column changes or none
 * does, so a partial failure can never leave the schema half-widened while the
 * code assumes TEXT.
 *
 * Two timeouts, because they bound different things. `lock_timeout` caps the
 * wait to *acquire* each ACCESS EXCLUSIVE lock; `statement_timeout` caps the
 * table rewrite that follows, which is unbounded otherwise — `tasks` carries
 * 90 days of retention plus every row pinned by a `job_runs` row, and a slow
 * rewrite is exactly the hung migration this guards against. Either way boot
 * fails with a logged Postgres error instead of the startup probe killing the
 * pod mid-`ALTER` with nothing to say why.
 *
 * Rolling back to a pre-migration image needs the reverse ALTER run by hand —
 * see docs/database-schema.md.
 *
 * **The migration is forward-only, and the workload must not surge.** The
 * pre-change `getRecentWorkItems` ran `WHERE item_number > 0`; against a
 * `text` column Postgres rejects that with `operator does not exist: text >
 * integer`, so an old pod still serving after a new one commits this would
 * start failing. Claws is deployed as the single-replica StatefulSet
 * `claws` (`podManagementPolicy: OrderedReady`,
 * `updateStrategy: RollingUpdate`) — a StatefulSet rolls by terminating the
 * old pod *before* creating its replacement, so no such overlap exists. Do not
 * move this workload to a `Deployment` with a non-zero `maxSurge` without
 * re-examining that.
 *
 * @internal Exported for `db.test.ts`, which narrows the columns back to
 * BIGINT to exercise a migration a freshly created schema never needs.
 */
export async function migrateIssueRefColumnsToText(): Promise<void> {
  return timedDb("migrate-issue-ref-columns-to-text", () => migrateIssueRefColumnsToTextUntimed());
}

async function migrateIssueRefColumnsToTextUntimed(): Promise<void> {
  if (getDb().dialect !== "postgres") return;

  // Scoped to the six pairs rather than every non-text column in the schema:
  // the probe runs on every boot, and `information_schema.columns` is a join
  // over the whole catalogue.
  const tables = [...new Set(ISSUE_REF_COLUMNS.map(([table]) => table))];
  const columns = [...new Set(ISSUE_REF_COLUMNS.map(([, column]) => column))];
  const rows = await getDb().all(
    `SELECT table_name, column_name, data_type
       FROM information_schema.columns
      WHERE table_schema = current_schema() AND data_type <> 'text'
        AND table_name IN (${tables.map(() => "?").join(",")})
        AND column_name IN (${columns.map(() => "?").join(",")})`,
    [...tables, ...columns],
  ) as Array<{ table_name: string; column_name: string; data_type: string }>;
  const stale = ISSUE_REF_COLUMNS.filter(([table, column]) =>
    rows.some((r) => r.table_name === table && r.column_name === column));
  if (stale.length === 0) return;

  log.info(`Migrating ${stale.length} issue-reference column(s) to TEXT: ${stale.map(([t, c]) => `${t}.${c}`).join(", ")}`);
  const started = Date.now();
  // Only the stale columns: every ALTER takes an ACCESS EXCLUSIVE lock and
  // rewrites the table, so re-stating an already-TEXT column in a mixed state
  // would pay the full cost of a migration that has nothing to do.
  try {
    await getDb().exec([
      "BEGIN",
      "SET LOCAL lock_timeout = '30s'",
      "SET LOCAL statement_timeout = '120s'",
      ...stale.map(([table, column]) =>
        `ALTER TABLE ${table} ALTER COLUMN ${column} TYPE TEXT USING ${column}::text`),
      "COMMIT",
    ].join(";\n") + ";");
  } catch (err) {
    // The simple protocol discards the rest of the batch once a statement
    // fails — the trailing COMMIT included — so the connection is left sitting
    // inside an aborted transaction. The ALTERs are already rolled back at
    // that point; this only releases the connection, so the error that aborts
    // boot is the migration's own and not "current transaction is aborted"
    // from whatever ran next.
    await getDb().exec("ROLLBACK").catch(() => {});
    throw err;
  }
  log.info("Issue-reference columns migrated to TEXT", { duration_ms: Date.now() - started, columns: stale.length });
}

/** The tables the retired sealed SOPS age-key feature added (#clw_01M8BRCFTHQQPEGXN1X3W281NH). */
const RETIRED_SOPS_KEY_TABLES = ["sops_age_keys", "session_sops_key_grants"] as const;

/**
 * Drop the tables the retired sealed SOPS age-key feature added
 * (#clw_01M8BRCFTHQQPEGXN1X3W281NH), one release after nothing reads them.
 * Both go only when both are empty (their indexes go with them); a row in
 * either keeps both and logs one `error` instead of failing boot, so no
 * key ciphertext or audit row is lost unseen. Absent tables are a silent
 * no-op, so it runs every boot.
 */
export async function dropRetiredSopsKeyTables(): Promise<void> {
  return timedDb("drop-retired-sops-key-tables", () => dropRetiredSopsKeyTablesUntimed());
}

async function dropRetiredSopsKeyTablesUntimed(): Promise<void> {
  const db = getDb();
  const placeholders = RETIRED_SOPS_KEY_TABLES.map(() => "?").join(",");
  const present = await db.all(
    db.dialect === "postgres"
      ? `SELECT table_name AS name FROM information_schema.tables WHERE table_schema = current_schema() AND table_name IN (${placeholders})`
      : `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (${placeholders})`,
    [...RETIRED_SOPS_KEY_TABLES],
  ) as Array<{ name: string }>;
  const tables = RETIRED_SOPS_KEY_TABLES.filter((t) => present.some((r) => r.name === t));
  if (tables.length === 0) return;

  const counts: Record<string, number> = {};
  for (const table of tables) {
    const rows = await db.all(`SELECT COUNT(*) AS n FROM ${table}`) as Array<{ n: number | string }>;
    counts[table] = Number(rows[0]?.n ?? 0);
  }
  if (Object.values(counts).some((n) => n > 0)) {
    log.error("Retired SOPS key tables are not empty; not dropping them", {
      sops_age_keys: counts.sops_age_keys ?? 0,
      session_sops_key_grants: counts.session_sops_key_grants ?? 0,
    });
    return;
  }
  for (const table of RETIRED_SOPS_KEY_TABLES) await db.exec(`DROP TABLE IF EXISTS ${table}`);
  log.info("Dropped retired SOPS key tables", { tables: tables.join(",") });
}
