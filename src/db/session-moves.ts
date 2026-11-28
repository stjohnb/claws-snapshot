// Node evacuations and session moves. Reached only through the src/db.ts façade.
import { getDb } from "./core.js";

// ── Node evacuations and session moves (#clw_01M7Q3P5PR480HYED9TNH6VTV9) ──

export interface NodeEvacuation {
  node: string;
  reason: string;
  requested_at: number;
  idle_deadline_seconds: number;
}

/** Start evacuating `node`; a second request keeps the first one's reason, time and deadline. Returns the stored row. */
export async function requestNodeEvacuation(evac: NodeEvacuation): Promise<NodeEvacuation> {
  await getDb().run(
    `INSERT INTO node_evacuations (node, reason, requested_at, idle_deadline_seconds) VALUES (?, ?, ?, ?) ON CONFLICT(node) DO NOTHING`,
    [evac.node, evac.reason, evac.requested_at, evac.idle_deadline_seconds],
  );
  return (await getNodeEvacuation(evac.node)) ?? evac;
}

export async function getNodeEvacuation(node: string): Promise<NodeEvacuation | undefined> {
  return await getDb().get(`SELECT * FROM node_evacuations WHERE node = ?`, [node]) as NodeEvacuation | undefined;
}

export async function listNodeEvacuations(): Promise<NodeEvacuation[]> {
  return await getDb().all(`SELECT * FROM node_evacuations ORDER BY requested_at`) as NodeEvacuation[];
}

/** Clear `node`'s evacuation; true when one was stored. */
export async function clearNodeEvacuation(node: string): Promise<boolean> {
  return (await getDb().run(`DELETE FROM node_evacuations WHERE node = ?`, [node])).changes > 0;
}

/** States of a move; `done` and `failed` are final. */
export const SESSION_MOVE_STATES = ["queued", "waiting-idle", "stopping", "copying", "resuming", "done", "failed"] as const;
export type SessionMoveState = typeof SESSION_MOVE_STATES[number];
/** States in which a move owns the session: other operations answer busy. */
export const SESSION_MOVE_BLOCKING_STATES: readonly SessionMoveState[] = ["stopping", "copying", "resuming"];

export interface SessionMove {
  id: string;
  session_id: string;
  /** `settle` is legacy: moves after a session ended, no longer written (#clw_01M7T8P6X0GTRKJXFDPX27H174). */
  kind: "evacuate" | "settle";
  from_node: string;
  to_node: string;
  reason: string;
  state: SessionMoveState;
  /** 1 when the session was running when the move was planned. */
  was_running: number;
  /** The PVC the session's HOME is copied from. */
  from_claim: string;
  /** The PVC the current or last copy attempt wrote. */
  new_claim: string | null;
  attempts: number;
  bytes: number | null;
  requested_at: number;
  started_at: number | null;
  finished_at: number | null;
  error: string | null;
}

export async function insertSessionMove(move: SessionMove): Promise<void> {
  await getDb().run(
    `INSERT INTO session_moves (id, session_id, kind, from_node, to_node, reason, state, was_running, from_claim, new_claim, attempts, bytes, requested_at, started_at, finished_at, error)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [move.id, move.session_id, move.kind, move.from_node, move.to_node, move.reason, move.state, move.was_running, move.from_claim,
      move.new_claim, move.attempts, move.bytes, move.requested_at, move.started_at, move.finished_at, move.error],
  );
}

type SessionMovePatch = Partial<Pick<SessionMove, "kind" | "state" | "was_running" | "new_claim" | "attempts" | "bytes" | "started_at" | "finished_at" | "error">>;

export async function updateSessionMove(id: string, patch: SessionMovePatch): Promise<void> {
  const keys = Object.keys(patch) as Array<keyof SessionMovePatch>;
  if (keys.length === 0) return;
  await getDb().run(
    `UPDATE session_moves SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`,
    [...keys.map((k) => patch[k] ?? null), id],
  );
}

export async function deleteSessionMove(id: string): Promise<void> {
  await getDb().run(`DELETE FROM session_moves WHERE id = ?`, [id]);
}

/** Unstarted move states: the controller has not claimed the move yet. */
const UNSTARTED_MOVE_CONDITION = `started_at IS NULL AND state IN ('queued', 'waiting-idle')`;

/**
 * Claim move `id` for the controller: stamp `started_at` only while it is
 * still unstarted. False when another writer (an evacuation being cleared)
 * changed or deleted it first.
 */
export async function claimSessionMove(id: string, startedAt: number, wasRunning: number): Promise<boolean> {
  const res = await getDb().run(
    `UPDATE session_moves SET started_at = ?, was_running = ? WHERE id = ? AND ${UNSTARTED_MOVE_CONDITION}`,
    [startedAt, wasRunning, id],
  );
  return res.changes > 0;
}

/** Delete move `id` only while the controller has not claimed it; true when it was deleted. */
export async function deleteUnstartedSessionMove(id: string): Promise<boolean> {
  return (await getDb().run(`DELETE FROM session_moves WHERE id = ? AND ${UNSTARTED_MOVE_CONDITION}`, [id])).changes > 0;
}

/**
 * Delete legacy settle moves that never started or failed
 * (#clw_01M7T8P6X0GTRKJXFDPX27H174: ended sessions no longer move); returns how many.
 */
export async function deleteRetiredSettleMoves(): Promise<number> {
  return (await getDb().run(`DELETE FROM session_moves WHERE kind = 'settle' AND state IN ('queued', 'failed')`)).changes;
}

/** Every move not yet `done` or `failed`, oldest first. */
export async function listActiveSessionMoves(): Promise<SessionMove[]> {
  return await getDb().all(
    `SELECT * FROM session_moves WHERE state NOT IN ('done', 'failed') ORDER BY requested_at, id`,
  ) as SessionMove[];
}

/** Moves off `node` requested at or after `since`, or still active. */
export async function listSessionMovesFromNode(node: string, since: number): Promise<SessionMove[]> {
  return await getDb().all(
    `SELECT * FROM session_moves WHERE from_node = ? AND (requested_at >= ? OR state NOT IN ('done', 'failed')) ORDER BY requested_at, id`,
    [node, since],
  ) as SessionMove[];
}

/** The session's most recently requested move, if any. */
export async function getLatestSessionMove(sessionId: string): Promise<SessionMove | undefined> {
  return await getDb().get(
    `SELECT * FROM session_moves WHERE session_id = ? ORDER BY requested_at DESC, id DESC LIMIT 1`,
    [sessionId],
  ) as SessionMove | undefined;
}

/** The session's move not yet `done` or `failed`, if any. */
export async function getActiveSessionMove(sessionId: string): Promise<SessionMove | undefined> {
  return await getDb().get(
    `SELECT * FROM session_moves WHERE session_id = ? AND state NOT IN ('done', 'failed') ORDER BY requested_at DESC, id DESC LIMIT 1`,
    [sessionId],
  ) as SessionMove | undefined;
}
