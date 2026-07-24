import { AsyncLocalStorage } from "node:async_hooks";
import { notify } from "./slack.js";
import { insertJobLog } from "./db.js";

interface RunContext {
  runId: string;
}

export const runContext = new AsyncLocalStorage<RunContext>();

function ts(): string {
  return new Date().toISOString();
}

function captureLog(level: string, msg: string): void {
  const store = runContext.getStore();
  if (store) {
    try {
      insertJobLog(store.runId, level, msg);
    } catch {
      // Don't let DB errors interrupt the job
    }
  }
}

export function debug(msg: string): void {
  console.log(`${ts()} [DEBUG] ${msg}`);
  captureLog("debug", msg);
}

export function info(msg: string): void {
  console.log(`${ts()} [INFO] ${msg}`);
  captureLog("info", msg);
}

export function warn(msg: string): void {
  console.warn(`${ts()} [WARN] ${msg}`);
  captureLog("warn", msg);
}

export function error(msg: string): void {
  console.error(`${ts()} [ERROR] ${msg}`);
  notify(`[ERROR] ${msg}`);
  captureLog("error", msg);
}

export function withRunContext<T>(runId: string, fn: () => Promise<T>): Promise<T> {
  return runContext.run({ runId }, fn);
}
