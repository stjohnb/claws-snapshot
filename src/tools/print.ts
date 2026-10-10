#!/usr/bin/env node
/**
 * Print to the LAN printers through the fleet CUPS service
 * (#clw_01M498X85G9KCWHAX28RHG0F7Y). Run by a session granted the `print`
 * capability, which sets `CUPS_SERVER` and `CLAWS_PRINT` (this script's path):
 *
 *   node "$CLAWS_PRINT" --printer laserjet|envy [--copies N] [--fit] [--no-wait] FILE...
 *   node "$CLAWS_PRINT" --status
 *
 * Every job is sent as A4 with no scaling (`--fit` scales to the page), then
 * the script waits until CUPS reports the job finished and ends with
 * `completed QUEUE-NN` (exit 0) or `not completed QUEUE-NN: <reason>` (exit 1).
 * Usage and environment errors exit 2. The capability description cannot say
 * `lp -o media=A4` itself (no `=` there, #2138), which is why this exists.
 *
 * Uses console.*, not src/log.ts: this runs inside a session, not the service.
 */
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

/** Printer alias → CUPS queue name, as declared by fleet-infra `apps/cups`. */
export const PRINTER_QUEUES: Readonly<Record<string, string>> = {
  laserjet: "LaserJet4050",
  envy: "HP_Envy_6100e",
};

export const LASERJET_CAVEAT =
  "note: the LaserJet 4050 reports completion as soon as the bytes are delivered; a wrong paper size or an empty tray shows only on its own panel (TRAY 1 LOAD PLAIN LETTER means the job did not print)";

export const POLL_INTERVAL_MS = 3_000;
const MAX_LPSTAT_FAILURES = 5;
export const WAIT_CAP_MS = 10 * 60 * 1000;

const USAGE =
  "usage: node print.js --printer laserjet|envy [--copies N] [--fit] [--no-wait] FILE...\n       node print.js --status";

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface PrintDeps {
  /** Runs a command; never throws for a non-zero exit. */
  run: (cmd: string, args: string[]) => Promise<RunResult>;
  env: NodeJS.ProcessEnv;
  fileExists: (p: string) => boolean;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  out: (line: string) => void;
  err: (line: string) => void;
}

export type ParsedArgs =
  | { kind: "status" }
  | { kind: "print"; queue: string; alias: string; copies: number; fit: boolean; wait: boolean; files: string[] };

/** A usage error, reported with exit code 2. */
export class UsageError extends Error {}

/** The CUPS queue for a printer alias (case-insensitive), or null when unknown. */
export function queueForAlias(alias: string): string | null {
  return PRINTER_QUEUES[alias.trim().toLowerCase()] ?? null;
}

export function parsePrintArgs(argv: string[]): ParsedArgs {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      options: {
        printer: { type: "string" },
        copies: { type: "string" },
        fit: { type: "boolean" },
        "no-wait": { type: "boolean" },
        status: { type: "boolean" },
      },
      allowPositionals: true,
    });
  } catch (e) {
    throw new UsageError(`${e instanceof Error ? e.message : String(e)}\n${USAGE}`);
  }
  const { values, positionals } = parsed;
  if (values.status) {
    if (values.printer || positionals.length > 0) throw new UsageError(`--status takes no printer or files\n${USAGE}`);
    return { kind: "status" };
  }
  if (!values.printer) throw new UsageError(`--printer is required\n${USAGE}`);
  const queue = queueForAlias(values.printer);
  if (!queue) {
    throw new UsageError(`unknown printer ${JSON.stringify(values.printer)}: expected one of ${Object.keys(PRINTER_QUEUES).join(", ")}`);
  }
  if (positionals.length === 0) throw new UsageError(`no file to print\n${USAGE}`);
  let copies = 1;
  if (values.copies !== undefined) {
    if (!/^\d+$/.test(values.copies) || Number(values.copies) < 1 || Number(values.copies) > 99) {
      throw new UsageError(`invalid --copies ${JSON.stringify(values.copies)}: expected 1 to 99`);
    }
    copies = Number(values.copies);
  }
  return {
    kind: "print",
    queue,
    alias: values.printer.trim().toLowerCase(),
    copies,
    fit: values.fit === true,
    wait: values["no-wait"] !== true,
    files: positionals,
  };
}

/** The `lp` argv: A4 at 1:1 unless `fit`. */
export function buildLpArgs(queue: string, files: string[], opts: { copies: number; fit: boolean }): string[] {
  return [
    "-d", queue,
    "-o", "media=A4",
    "-o", `print-scaling=${opts.fit ? "fit" : "none"}`,
    "-n", String(opts.copies),
    ...files,
  ];
}

/** The job id from `lp`'s `request id is QUEUE-NN (1 file(s))`, or null. */
export function parseRequestId(lpOutput: string): string | null {
  const m = /request id is (\S+-\d+)/.exec(lpOutput);
  return m ? m[1]! : null;
}

/** Job ids listed by `lpstat -o` (the first token of each unindented line). */
export function parseJobIds(lpstatOutput: string): string[] {
  const ids: string[] = [];
  for (const line of lpstatOutput.split("\n")) {
    if (!line || /^\s/.test(line)) continue;
    const id = line.split(/\s+/)[0]!;
    if (/-\d+$/.test(id)) ids.push(id);
  }
  return ids;
}

/** The `Alerts:` job-state reasons for `jobId` from `lpstat -l -W completed -o`, or null when the job is absent. */
export function parseJobAlerts(lpstatLongOutput: string, jobId: string): string[] | null {
  const lines = lpstatLongOutput.split("\n");
  const start = lines.findIndex((l) => !/^\s/.test(l) && l.split(/\s+/)[0] === jobId);
  if (start < 0) return null;
  const alerts: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line && !/^\s/.test(line)) break;
    const m = /^\s+Alerts:\s*(.*)$/.exec(line);
    if (m) alerts.push(...m[1]!.split(/\s+/).filter(Boolean));
  }
  return alerts;
}

export type Completion = { completed: true } | { completed: false; reason: string };

/**
 * Whether a job that left the not-completed list finished successfully. CUPS
 * lists cancelled and aborted jobs as "completed" too, so the job-state
 * reasons decide.
 */
export function decideCompletion(completedLongOutput: string, jobId: string): Completion {
  const alerts = parseJobAlerts(completedLongOutput, jobId);
  if (alerts === null) return { completed: false, reason: "job is missing from the CUPS completed list" };
  const failed = alerts.filter((a) => /cancel|abort|stop|error/i.test(a));
  if (failed.length > 0) return { completed: false, reason: failed.join(" ") };
  return { completed: true };
}

function show(deps: PrintDeps, r: RunResult): void {
  for (const text of [r.stdout, r.stderr]) {
    const trimmed = text.trimEnd();
    if (trimmed) deps.out(trimmed);
  }
}

async function status(deps: PrintDeps): Promise<number> {
  let code = 0;
  for (const queue of Object.values(PRINTER_QUEUES)) {
    const printer = await deps.run("lpstat", ["-p", queue, "-l"]);
    show(deps, printer);
    const jobs = await deps.run("lpstat", ["-o", queue]);
    show(deps, jobs);
    if (printer.code !== 0 || jobs.code !== 0) code = 1;
  }
  return code;
}

/** Runs the CLI and returns its exit code: 0 completed, 1 not completed, 2 usage/env. */
export async function runPrint(argv: string[], deps: PrintDeps): Promise<number> {
  let args: ParsedArgs;
  try {
    args = parsePrintArgs(argv);
  } catch (e) {
    if (e instanceof UsageError) {
      deps.err(e.message);
      return 2;
    }
    throw e;
  }
  if (!(deps.env["CUPS_SERVER"] ?? "").trim()) {
    deps.err("CUPS_SERVER is not set; this session needs the print capability");
    return 2;
  }
  if (args.kind === "status") return status(deps);

  const missing = args.files.filter((f) => !deps.fileExists(f));
  if (missing.length > 0) {
    deps.err(`no such file: ${missing.join(", ")}`);
    return 2;
  }

  const caveat = (): void => {
    if (args.queue === PRINTER_QUEUES["laserjet"]) deps.out(LASERJET_CAVEAT);
  };

  // Absolute paths, so a file named like an option is never read as one.
  const files = args.files.map((f) => path.resolve(f));
  const lp = await deps.run("lp", buildLpArgs(args.queue, files, args));
  const jobId = parseRequestId(lp.stdout);
  if (lp.code !== 0 || !jobId) {
    // Surface lp's own error verbatim, e.g. an Envy queue not yet declared.
    show(deps, lp);
    deps.out(`not completed ${args.queue}: lp failed${lp.code !== 0 ? ` with exit ${lp.code}` : ""}`);
    return 1;
  }
  deps.out(`submitted ${jobId} to ${args.queue} (A4, ${args.fit ? "scaled to fit" : "1:1 no scaling"}, ${args.copies} ${args.copies === 1 ? "copy" : "copies"})`);
  if (!args.wait) {
    caveat();
    deps.out(`submitted ${jobId}`);
    return 0;
  }

  const deadline = deps.now() + WAIT_CAP_MS;
  let finished = false;
  let failures = 0;
  let lastFailed: RunResult | null = null;
  for (;;) {
    const pending = await deps.run("lpstat", ["-W", "not-completed", "-o", args.queue]);
    if (pending.code !== 0) {
      lastFailed = pending;
      failures++;
      if (failures >= MAX_LPSTAT_FAILURES) break;
    } else {
      lastFailed = null;
      failures = 0;
    }
    if (pending.code === 0 && !parseJobIds(pending.stdout).includes(jobId)) {
      finished = true;
      break;
    }
    if (deps.now() >= deadline) break;
    await deps.sleep(POLL_INTERVAL_MS);
  }

  const printer = await deps.run("lpstat", ["-p", args.queue, "-l"]);
  show(deps, printer);
  caveat();
  if (!finished && lastFailed) {
    show(deps, lastFailed);
    deps.out(`not completed ${jobId}: lpstat failed with exit ${lastFailed.code}; job state unknown, check --status before reprinting`);
    return 1;
  }
  if (!finished) {
    deps.out(`not completed ${jobId}: still queued after ${WAIT_CAP_MS / 60_000} minutes`);
    return 1;
  }
  const done = await deps.run("lpstat", ["-l", "-W", "completed", "-o", args.queue]);
  const result = decideCompletion(done.stdout, jobId);
  if (result.completed) {
    deps.out(`completed ${jobId}`);
    return 0;
  }
  deps.out(`not completed ${jobId}: ${result.reason}`);
  return 1;
}

function runCommand(cmd: string, args: string[]): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile(cmd, args, { encoding: "utf-8" }, (error, stdout, stderr) => {
      const code = error ? (typeof error.code === "number" ? error.code : 127) : 0;
      resolve({ code, stdout: stdout ?? "", stderr: stderr || (error ? error.message : "") });
    });
  });
}

function isEntryPoint(): boolean {
  const script = process.argv[1];
  if (!script) return false;
  try {
    return import.meta.url === pathToFileURL(fs.realpathSync(script)).href;
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  runPrint(process.argv.slice(2), {
    run: runCommand,
    env: process.env,
    fileExists: (p) => {
      try {
        return fs.statSync(path.resolve(p)).isFile();
      } catch {
        return false;
      }
    },
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    now: () => Date.now(),
    out: (line) => console.log(line),
    err: (line) => console.error(line),
  }).then(
    (code) => process.exit(code),
    (err: unknown) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    },
  );
}
