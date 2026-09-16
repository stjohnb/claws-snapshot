import * as log from "./log.js";

/**
 * In-memory self-deploy drain state (#3055).
 *
 * `deploy/deploy.sh` calls `POST /api/deploy/drain` on every updater tick while
 * a new release is pending. While a drain is active the work-queue fibers stop
 * claiming new rows, so running agent tasks can finish before the restart. If
 * the updater stops refreshing the drain for {@link DRAIN_EXPIRY_MS} the drain
 * lapses on its own and claiming resumes.
 */
export interface DeployDrainState {
  /** Release tag waiting to deploy. */
  tag: string;
  /** Epoch ms when the deploy first deferred (from deploy.sh's stamp file). */
  startedAt: number;
  /** Epoch ms of the most recent drain request. */
  lastRequestAt: number;
}

export const DRAIN_EXPIRY_MS = 5 * 60_000;

let state: DeployDrainState | null = null;
let inFlightCounter: () => number = () => 0;

/** Start or refresh a drain for `tag`. `startedAtMs` is epoch milliseconds. */
export function requestDeployDrain(tag: string, startedAtMs: number, now: number = Date.now()): DeployDrainState {
  if (!state) {
    log.info(`[deploy-drain] Drain started for ${tag} — pausing work-queue claims`);
  }
  state = { tag, startedAt: startedAtMs, lastRequestAt: now };
  return state;
}

/** Drop any active drain so work-queue claims resume. */
export function clearDeployDrain(): void {
  if (state) {
    log.info(`[deploy-drain] Drain for ${state.tag} cleared — resuming work-queue claims`);
  }
  state = null;
}

/** The active drain, or null. Expires a drain that has not been refreshed recently. */
export function getDeployDrain(now: number = Date.now()): DeployDrainState | null {
  if (state && now - state.lastRequestAt > DRAIN_EXPIRY_MS) {
    log.info(`[deploy-drain] Drain for ${state.tag} expired (no refresh for ${Math.round(DRAIN_EXPIRY_MS / 1000)}s) — resuming work-queue claims`);
    state = null;
  }
  return state;
}

export function isDeployDraining(now: number = Date.now()): boolean {
  return getDeployDrain(now) !== null;
}

/**
 * Register the live in-flight work counter. `worker.ts` owns the count; it is
 * surfaced here so page rendering can show it without importing the worker
 * (and, transitively, the database layer).
 */
export function registerInFlightCounter(fn: () => number): void {
  inFlightCounter = fn;
}

/** Number of work-queue agent tasks currently claimed or running. */
export function inFlightCount(): number {
  return inFlightCounter();
}
