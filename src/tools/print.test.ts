import path from "node:path";
import { describe, it, expect } from "vitest";
import {
  buildLpArgs,
  decideCompletion,
  LASERJET_CAVEAT,
  parseJobIds,
  parsePrintArgs,
  parseRequestId,
  queueForAlias,
  runPrint,
  UsageError,
  WAIT_CAP_MS,
  type PrintDeps,
  type RunResult,
} from "./print.js";

const ok = (stdout = ""): RunResult => ({ code: 0, stdout, stderr: "" });

const COMPLETED_LONG = [
  "LaserJet4050-11         claws            2048   Mon 06 Oct 2026 09:00:00",
  "\tAlerts: job-canceled-by-user",
  "\tqueued for LaserJet4050",
  "LaserJet4050-12         claws            1024   Mon 06 Oct 2026 10:00:00",
  "\tAlerts: job-completed-successfully",
  "\tqueued for LaserJet4050",
  "",
].join("\n");

interface Harness {
  deps: PrintDeps;
  calls: Array<[string, string[]]>;
  out: string[];
  err: string[];
}

/** `pendingPolls` is how many not-completed polls still list the job. */
function harness(opts: {
  queue?: string;
  jobId?: string;
  pendingPolls?: number;
  completedLong?: string;
  lp?: RunResult;
  env?: NodeJS.ProcessEnv;
  files?: string[];
  pendingFails?: boolean;
} = {}): Harness {
  const queue = opts.queue ?? "LaserJet4050";
  const jobId = opts.jobId ?? `${queue}-12`;
  let pending = opts.pendingPolls ?? 0;
  let clock = 0;
  const calls: Array<[string, string[]]> = [];
  const out: string[] = [];
  const err: string[] = [];
  const deps: PrintDeps = {
    run: async (cmd, args) => {
      calls.push([cmd, args]);
      if (cmd === "lp") return opts.lp ?? ok(`request id is ${jobId} (1 file(s))\n`);
      if (args.includes("not-completed")) {
        if (opts.pendingFails) return { code: 1, stdout: "", stderr: "lpstat: Unable to connect to server\n" };
        if (pending > 0) {
          pending--;
          return ok(`${jobId}   claws   1024   Mon 06 Oct 2026 10:00:00\n`);
        }
        return ok("");
      }
      if (args.includes("completed")) return ok(opts.completedLong ?? COMPLETED_LONG.replaceAll("LaserJet4050", queue));
      if (args[0] === "-p") return ok(`printer ${queue} is idle.  enabled since Mon 06 Oct 2026\n`);
      return ok("");
    },
    env: opts.env ?? { CUPS_SERVER: "cups.default.svc.cluster.local:631" },
    fileExists: (p) => (opts.files ?? ["a4.pdf"]).includes(p),
    sleep: async (ms) => {
      clock += ms;
    },
    now: () => clock,
    out: (l) => out.push(l),
    err: (l) => err.push(l),
  };
  return { deps, calls, out, err };
}

describe("print wrapper (#clw_01M498X85G9KCWHAX28RHG0F7Y)", () => {
  it("maps both aliases to their CUPS queues and rejects others", () => {
    expect(queueForAlias("laserjet")).toBe("LaserJet4050");
    expect(queueForAlias("Envy")).toBe("HP_Envy_6100e");
    expect(queueForAlias("ryzen")).toBeNull();
    expect(() => parsePrintArgs(["--printer", "ryzen", "a.pdf"])).toThrow(UsageError);
  });

  it("defaults to A4 at 1:1, one copy, waiting", () => {
    const args = parsePrintArgs(["--printer", "envy", "a.pdf"]);
    expect(args).toEqual({ kind: "print", queue: "HP_Envy_6100e", alias: "envy", copies: 1, fit: false, wait: true, files: ["a.pdf"] });
    expect(buildLpArgs("HP_Envy_6100e", ["/x/a.pdf"], { copies: 1, fit: false })).toEqual([
      "-d", "HP_Envy_6100e", "-o", "media=A4", "-o", "print-scaling=none", "-n", "1", "/x/a.pdf",
    ]);
  });

  it("--fit swaps in print-scaling=fit and keeps A4", () => {
    const args = parsePrintArgs(["--printer", "laserjet", "--fit", "--copies", "2", "a.pdf"]);
    expect(args).toMatchObject({ fit: true, copies: 2 });
    const lp = buildLpArgs("LaserJet4050", ["a.pdf"], { copies: 2, fit: true });
    expect(lp).toContain("print-scaling=fit");
    expect(lp).not.toContain("print-scaling=none");
    expect(lp).toContain("media=A4");
    expect(lp.slice(lp.indexOf("-n"), lp.indexOf("-n") + 2)).toEqual(["-n", "2"]);
  });

  it("rejects bad copies, a missing printer, and no files", () => {
    expect(() => parsePrintArgs(["--printer", "envy", "--copies", "0", "a.pdf"])).toThrow(UsageError);
    expect(() => parsePrintArgs(["--printer", "envy", "--copies", "x", "a.pdf"])).toThrow(UsageError);
    expect(() => parsePrintArgs(["a.pdf"])).toThrow(UsageError);
    expect(() => parsePrintArgs(["--printer", "envy"])).toThrow(UsageError);
    expect(parsePrintArgs(["--status"])).toEqual({ kind: "status" });
  });

  it("parses the lp request id and lpstat job lists", () => {
    expect(parseRequestId("request id is LaserJet4050-12 (1 file(s))\n")).toBe("LaserJet4050-12");
    expect(parseRequestId("lp: The printer or class does not exist.")).toBeNull();
    expect(parseJobIds(COMPLETED_LONG)).toEqual(["LaserJet4050-11", "LaserJet4050-12"]);
    expect(parseJobIds("")).toEqual([]);
  });

  it("decides completion from the job-state reasons", () => {
    expect(decideCompletion(COMPLETED_LONG, "LaserJet4050-12")).toEqual({ completed: true });
    expect(decideCompletion(COMPLETED_LONG, "LaserJet4050-11")).toEqual({ completed: false, reason: "job-canceled-by-user" });
    expect(decideCompletion(COMPLETED_LONG, "LaserJet4050-99")).toMatchObject({ completed: false });
  });

  it("prints A4 1:1 on the laserjet, waits, and ends with completed plus the panel caveat (exit 0)", async () => {
    const h = harness({ pendingPolls: 2, files: ["a4.pdf"] });
    expect(await runPrint(["--printer", "laserjet", "a4.pdf"], h.deps)).toBe(0);
    const lp = h.calls.find(([c]) => c === "lp")![1];
    expect(lp).toEqual(["-d", "LaserJet4050", "-o", "media=A4", "-o", "print-scaling=none", "-n", "1", path.resolve("a4.pdf")]);
    expect(h.calls.filter(([, a]) => a.includes("not-completed"))).toHaveLength(3);
    expect(h.out).toContain(LASERJET_CAVEAT);
    expect(h.out.at(-1)).toBe("completed LaserJet4050-12");
  });

  it("omits the 4050 caveat for the envy", async () => {
    const h = harness({ queue: "HP_Envy_6100e" });
    expect(await runPrint(["--printer", "envy", "a4.pdf"], h.deps)).toBe(0);
    expect(h.out).not.toContain(LASERJET_CAVEAT);
    expect(h.out.at(-1)).toBe("completed HP_Envy_6100e-12");
  });

  it("reports a cancelled job as not completed (exit 1)", async () => {
    const h = harness({ jobId: "LaserJet4050-11" });
    expect(await runPrint(["--printer", "laserjet", "a4.pdf"], h.deps)).toBe(1);
    expect(h.out.at(-1)).toBe("not completed LaserJet4050-11: job-canceled-by-user");
  });

  it("gives up after the wait cap (exit 1)", async () => {
    const h = harness({ pendingPolls: Number.MAX_SAFE_INTEGER });
    expect(await runPrint(["--printer", "laserjet", "a4.pdf"], h.deps)).toBe(1);
    expect(h.out.at(-1)).toBe(`not completed LaserJet4050-12: still queued after ${WAIT_CAP_MS / 60_000} minutes`);
  });

  it("reports unknown job state when lpstat keeps failing (exit 1)", async () => {
    const h = harness({ pendingFails: true });
    expect(await runPrint(["--printer", "laserjet", "a4.pdf"], h.deps)).toBe(1);
    expect(h.out).toContain("lpstat: Unable to connect to server");
    expect(h.out.at(-1)).toBe("not completed LaserJet4050-12: lpstat failed with exit 1; job state unknown, check --status before reprinting");
  });

  it("surfaces an lp failure verbatim (exit 1)", async () => {
    const h = harness({ queue: "HP_Envy_6100e", lp: { code: 1, stdout: "", stderr: "lp: The printer or class does not exist.\n" } });
    expect(await runPrint(["--printer", "envy", "a4.pdf"], h.deps)).toBe(1);
    expect(h.out).toContain("lp: The printer or class does not exist.");
    expect(h.out.at(-1)).toMatch(/^not completed HP_Envy_6100e: lp failed/);
  });

  it("--no-wait returns after submission", async () => {
    const h = harness();
    expect(await runPrint(["--printer", "laserjet", "--no-wait", "a4.pdf"], h.deps)).toBe(0);
    expect(h.calls.some(([, a]) => a.includes("not-completed"))).toBe(false);
    expect(h.out.at(-1)).toBe("submitted LaserJet4050-12");
  });

  it("exits 2 without CUPS_SERVER, for a missing file, or an unknown printer", async () => {
    const noServer = harness({ env: {} });
    expect(await runPrint(["--printer", "laserjet", "a4.pdf"], noServer.deps)).toBe(2);
    expect(noServer.err.join("\n")).toContain("print capability");
    expect(noServer.calls).toEqual([]);

    const missing = harness();
    expect(await runPrint(["--printer", "laserjet", "nope.pdf"], missing.deps)).toBe(2);
    expect(missing.calls).toEqual([]);

    const unknown = harness();
    expect(await runPrint(["--printer", "ryzen", "a4.pdf"], unknown.deps)).toBe(2);
    expect(unknown.calls).toEqual([]);
  });

  it("--status shows both queues' state and jobs", async () => {
    const h = harness();
    expect(await runPrint(["--status"], h.deps)).toBe(0);
    expect(h.calls).toEqual([
      ["lpstat", ["-p", "LaserJet4050", "-l"]],
      ["lpstat", ["-o", "LaserJet4050"]],
      ["lpstat", ["-p", "HP_Envy_6100e", "-l"]],
      ["lpstat", ["-o", "HP_Envy_6100e"]],
    ]);
  });
});
