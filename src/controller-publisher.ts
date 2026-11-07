import { claimControllerCommands, completeControllerCommand, writeControllerStatus } from "./db.js";
import { executeControllerCommand, liveIntegrations, liveProviderStatus, liveSchedulerStatus, STATUS_KEYS, type PublishedHeartbeat } from "./controller-client.js";
import { getQueueSnapshot, ALL_QUEUE_CATEGORIES } from "./github.js";
import * as log from "./log.js";
import type { Scheduler } from "./scheduler.js";
import { VERSION } from "./version.js";
import * as worker from "./worker.js";

/**
 * The controller side of `controller-client.ts`'s `dbControllerClient`
 * (#clw_01M5APX7YF3AGWHV1S1WMHJDR6). Every {@link STATUS_INTERVAL_MS} it
 * publishes its heartbeat, scheduler, provider, worker, queue-snapshot and
 * integrations state to `controller_status`; every {@link COMMAND_INTERVAL_MS} it claims
 * unclaimed `controller_commands` rows in id order and runs them, recording
 * each result. Commands filed while the controller was down run on its first
 * poll after boot.
 */

export const STATUS_INTERVAL_MS = 5_000;
export const COMMAND_INTERVAL_MS = 1_000;

let statusTimer: NodeJS.Timeout | null = null;
let commandTimer: NodeJS.Timeout | null = null;
let publishing: Promise<void> | null = null;
let polling = false;
let activeScheduler: Scheduler | null = null;

async function writeHeartbeat(shuttingDown: boolean): Promise<void> {
  const heartbeat: PublishedHeartbeat = { at: Date.now(), version: VERSION, shuttingDown };
  await writeControllerStatus(STATUS_KEYS.heartbeat, heartbeat);
}

/** Writes every status topic once. */
export async function publishControllerStatus(scheduler: Scheduler): Promise<void> {
  await writeHeartbeat(false);
  await writeControllerStatus(STATUS_KEYS.scheduler, liveSchedulerStatus(scheduler));
  await writeControllerStatus(STATUS_KEYS.providers, await liveProviderStatus());
  await writeControllerStatus(STATUS_KEYS.worker, await worker.workerStatus());
  await writeControllerStatus(STATUS_KEYS.queueSnapshot, getQueueSnapshot(ALL_QUEUE_CATEGORIES));
  await writeControllerStatus(STATUS_KEYS.integrations, liveIntegrations());
}

/** Claims and runs every waiting command, oldest first. Returns how many ran. */
export async function runPendingControllerCommands(scheduler: Scheduler): Promise<number> {
  let ran = 0;
  for (;;) {
    const batch = await claimControllerCommands();
    if (batch.length === 0) return ran;
    for (const row of batch) {
      let result: unknown;
      try {
        result = await executeControllerCommand(scheduler, row.kind, JSON.parse(row.args_json));
      } catch (err) {
        result = { error: err instanceof Error ? err.message : String(err) };
      }
      log.info(`[controller] Ran ${row.kind} command #${row.id}: ${JSON.stringify(result)}`);
      await completeControllerCommand(row.id, result);
      ran++;
    }
  }
}

/** Starts both loops; publishes the status once straight away. */
export function startControllerPublisher(scheduler: Scheduler): void {
  if (statusTimer || commandTimer) return;
  activeScheduler = scheduler;
  const publish = () => {
    if (publishing) return;
    publishing = publishControllerStatus(scheduler)
      .catch((err) => log.warn(`[controller] Status publish failed: ${err}`))
      .finally(() => { publishing = null; });
  };
  const poll = () => {
    if (polling) return;
    polling = true;
    void runPendingControllerCommands(scheduler)
      .catch((err) => log.warn(`[controller] Command poll failed: ${err}`))
      .finally(() => { polling = false; });
  };
  publish();
  poll();
  statusTimer = setInterval(publish, STATUS_INTERVAL_MS);
  commandTimer = setInterval(poll, COMMAND_INTERVAL_MS);
  statusTimer.unref();
  commandTimer.unref();
}

/** Stops both loops. Commands filed from now on wait for the next boot. */
export function stopControllerPublisher(): void {
  if (statusTimer) clearInterval(statusTimer);
  if (commandTimer) clearInterval(commandTimer);
  statusTimer = null;
  commandTimer = null;
  activeScheduler = null;
}

/**
 * The first step of `shutdown()`: stops claiming commands and publishes a
 * `shuttingDown` heartbeat, so the dashboard says background processing is
 * restarting. Never throws.
 */
export async function publishControllerShuttingDown(): Promise<void> {
  const wasRunning = activeScheduler !== null;
  stopControllerPublisher();
  if (!wasRunning) return;
  // A publish still in flight would otherwise land after, and undo, this heartbeat.
  await publishing;
  try {
    await writeHeartbeat(true);
  } catch (err) {
    log.warn(`[controller] Failed to publish the shutting-down heartbeat: ${err}`);
  }
}
