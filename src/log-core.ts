/**
 * The stdout half of Claws' logger: run context, field assembly, and the
 * one-line write in either JSON (containers) or human text (a TTY). See
 * docs/logging-conventions.md for the field contract.
 *
 * Deliberately a leaf module — it imports nothing from `src/`. `config.ts`,
 * `slack.ts`, `db.ts` and `db-driver-pg.ts` sit upstream of `log.ts` (which
 * adds the `job_logs` and Slack sinks), so they log through here to avoid
 * import cycles and sink recursion. The session pod uses it too, via
 * `session-pod/log.ts`, because it must not load `config.js`/`db.js`.
 */
import { AsyncLocalStorage } from "node:async_hooks";

export type LogLevel = "debug" | "info" | "warn" | "error";

/** Correlation fields a run adds to every line it logs. */
export interface RunContextFields {
  job?: string;
  repo?: string;
  issue?: number | string;
  pr?: number | string;
}

export interface RunContext extends RunContextFields {
  runId: string;
}

export const runContext = new AsyncLocalStorage<RunContext>();

export function withRunContext<T>(runId: string, fn: () => Promise<T>, fields?: RunContextFields): Promise<T> {
  return runContext.run({ ...fields, runId }, fn);
}

export interface BaseFields {
  service: string;
  /** Used when the message carries no `[component]` prefix. */
  component?: string;
  session_id?: string;
}

const DEFAULT_BASE_FIELDS: BaseFields = { service: "claws" };

export interface EmitOptions {
  reason?: string;
  context?: object;
  err?: unknown;
  /** Per-call base fields, layered over the `service: "claws"` default (see session-pod/log.ts). */
  base?: Partial<BaseFields>;
}

/** JSON when stdout is not a TTY; `CLAWS_LOG_FORMAT=json|text` overrides. */
export function useJsonFormat(): boolean {
  const format = process.env["CLAWS_LOG_FORMAT"]?.trim().toLowerCase();
  if (format === "json") return true;
  if (format === "text") return false;
  return !process.stdout.isTTY;
}

const COMPONENT_PREFIX = /^\[([A-Za-z0-9][A-Za-z0-9_.:/-]{0,63})\] ?/;

/** Splits a leading `[component]` tag off a message. */
export function splitComponent(msg: string): { component?: string; msg: string } {
  const match = COMPONENT_PREFIX.exec(msg);
  if (!match) return { msg };
  return { component: match[1], msg: msg.slice(match[0].length) };
}

function snakeCase(key: string): string {
  return key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
}

function snakeCaseKeys(obj: object): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value !== undefined) out[snakeCase(key)] = value;
  }
  return out;
}

export function serializeError(err: unknown): { type: string; message: string; stack?: string } {
  if (err instanceof Error) {
    return { type: err.name || err.constructor?.name || "Error", message: err.message, stack: err.stack };
  }
  return { type: typeof err, message: String(err) };
}

function isPresent(value: unknown): boolean {
  if (value === undefined || value === null || value === "") return false;
  if (typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 0) return false;
  return true;
}

/** Builds the ordered field object for one line. Exported for tests. */
export function buildRecord(level: LogLevel, rawMsg: string, opts: EmitOptions = {}, time = new Date()): Record<string, unknown> {
  const { component, msg } = splitComponent(rawMsg);
  const store = runContext.getStore();
  const base = opts.base ? { ...DEFAULT_BASE_FIELDS, ...opts.base } : DEFAULT_BASE_FIELDS;
  const record: Record<string, unknown> = {
    time: time.toISOString(),
    level,
    msg,
    service: base.service,
    component: component ?? base.component,
    session_id: base.session_id,
    run_id: store?.runId,
    job: store?.job,
    repo: store?.repo,
    issue: store?.issue,
    pr: store?.pr,
    reason: opts.reason,
    context: opts.context ? snakeCaseKeys(opts.context) : undefined,
    err: opts.err !== undefined ? serializeError(opts.err) : undefined,
  };
  for (const key of Object.keys(record)) {
    if (!isPresent(record[key])) delete record[key];
  }
  return record;
}

function formatText(record: Record<string, unknown>): string {
  const component = record["component"] ? `[${String(record["component"])}] ` : "";
  return `${String(record["time"])} [${String(record["level"]).toUpperCase()}] ${component}${String(record["msg"])}`;
}

/** Formats one line. Never throws: an unserialisable field falls back to text. */
export function formatLine(level: LogLevel, msg: string, opts: EmitOptions = {}): string {
  try {
    const record = buildRecord(level, msg, opts);
    if (!useJsonFormat()) return formatText(record);
    try {
      return JSON.stringify(record);
    } catch {
      return formatText(record);
    }
  } catch {
    return `${new Date().toISOString()} [${level.toUpperCase()}] ${msg}`;
  }
}

/** Writes one line to stdout (debug/info) or stderr (warn/error). */
export function emit(level: LogLevel, msg: string, opts: EmitOptions = {}): void {
  const line = formatLine(level, msg, opts);
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export function debug(msg: string): void {
  emit("debug", msg);
}

export function info(msg: string): void {
  emit("info", msg);
}

export function warn(msg: string, err?: unknown): void {
  emit("warn", msg, { err });
}

export function error(msg: string, err?: unknown): void {
  emit("error", msg, { err });
}
