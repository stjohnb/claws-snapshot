import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { collectProcessTreePids, measureProcessTreeMemory, sampleProcessTreePssBytes, sampleProcessTreeRssBytes } from "./process-memory.js";

const MIB_KB = 1024; // kB per MiB
const GIB = 1024 ** 3;

let procRoot: string;
let restorePlatform: (() => void) | undefined;

function setPlatform(value: NodeJS.Platform): void {
  const original = process.platform;
  Object.defineProperty(process, "platform", { value, configurable: true });
  restorePlatform = () => Object.defineProperty(process, "platform", { value: original, configurable: true });
}

/** Write a fake `/proc/<pid>/` with the given files; omitted files do not exist. */
function proc(pid: number, opts: { comm?: string; ppid: number; rssKb?: number; rssAnonKb?: number; pssKb?: number }): void {
  const dir = path.join(procRoot, String(pid));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "stat"), `${pid} (${opts.comm ?? "node"}) S ${opts.ppid} 0 0 0 -1 0 0 0`);
  const status = [`Name:\t${opts.comm ?? "node"}`];
  if (opts.rssKb !== undefined) status.push(`VmRSS:\t${opts.rssKb} kB`);
  if (opts.rssAnonKb !== undefined) status.push(`RssAnon:\t${opts.rssAnonKb} kB`);
  fs.writeFileSync(path.join(dir, "status"), status.join("\n") + "\n");
  if (opts.pssKb !== undefined) {
    fs.writeFileSync(path.join(dir, "smaps_rollup"), `00400000-7fff0000 ---p 00000000 00:00 0 [rollup]\nRss:\t${opts.rssKb ?? 0} kB\nPss:\t${opts.pssKb} kB\nPss_Anon:\t0 kB\n`);
  }
}

beforeEach(() => {
  procRoot = fs.mkdtempSync(path.join(os.tmpdir(), "claws-proc-"));
  setPlatform("linux");
});

afterEach(() => {
  restorePlatform?.();
  restorePlatform = undefined;
  fs.rmSync(procRoot, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("collectProcessTreePids", () => {
  it("returns root plus descendants, leaf-first, ignoring unrelated processes", () => {
    proc(1, { ppid: 0 });
    proc(100, { ppid: 1 });
    proc(200, { ppid: 100 });
    proc(300, { ppid: 200 });
    proc(400, { ppid: 1 });
    fs.mkdirSync(path.join(procRoot, "self"));
    expect(collectProcessTreePids(100, procRoot)).toEqual([300, 200, 100]);
  });

  it("parses ppid when comm contains spaces and parens", () => {
    proc(500, { ppid: 1 });
    proc(600, { ppid: 500, comm: "weird) (name" });
    expect(collectProcessTreePids(500, procRoot)).toEqual([600, 500]);
  });

  it("no-ops off Linux", () => {
    setPlatform("darwin");
    expect(collectProcessTreePids(123, procRoot)).toEqual([123]);
    expect(sampleProcessTreeRssBytes(123, procRoot)).toBe(0);
    expect(sampleProcessTreePssBytes(123, procRoot)).toBe(0);
  });
});

describe("sampleProcessTreeRssBytes", () => {
  it("sums VmRSS across the tree and skips a process that exited mid-scan", () => {
    proc(100, { ppid: 1, rssKb: 10 });
    proc(200, { ppid: 100, rssKb: 20 });
    proc(300, { ppid: 200 }); // no VmRSS line (kernel thread / zombie)
    expect(sampleProcessTreeRssBytes(100, procRoot)).toBe(30 * 1024);
  });
});

describe("measureProcessTreeMemory", () => {
  /** Three workers, each 1 GiB VmRSS of which 900 MiB is one shared mapping. */
  function sharedMappingTree(): void {
    // Each worker's PSS is its private pages plus a third of the shared mapping.
    proc(100, { ppid: 1, rssKb: 1024 * MIB_KB, pssKb: 400 * MIB_KB });
    proc(101, { ppid: 100, comm: "rustc", rssKb: 1024 * MIB_KB, pssKb: 400 * MIB_KB });
    proc(102, { ppid: 100, comm: "rustc", rssKb: 1024 * MIB_KB, pssKb: 400 * MIB_KB });
  }

  it("does not multiply a mapping shared by several processes", () => {
    sharedMappingTree();
    const mem = measureProcessTreeMemory({ rootPid: 100, capBytes: 2 * GIB, procRoot });
    expect(mem.rssBytes).toBe(3 * GIB);
    expect(mem.pssBytes).toBe(1200 * 1024 * 1024);
    expect(mem.overCap).toBe(false);
  });

  it("is over the cap when summed PSS exceeds it", () => {
    sharedMappingTree();
    const mem = measureProcessTreeMemory({ rootPid: 100, capBytes: GIB, procRoot });
    expect(mem.pssBytes).toBe(1200 * 1024 * 1024);
    expect(mem.overCap).toBe(true);
  });

  it("falls back to RssAnon for a live process whose smaps_rollup is unreadable", () => {
    proc(100, { ppid: 1, rssKb: 2048 * MIB_KB, pssKb: 1500 * MIB_KB });
    proc(101, { ppid: 100, rssKb: 1024 * MIB_KB, rssAnonKb: 700 * MIB_KB }); // no smaps_rollup
    const mem = measureProcessTreeMemory({ rootPid: 100, capBytes: 2 * GIB, procRoot });
    expect(mem.pssBytes).toBe(2200 * 1024 * 1024);
    expect(mem.overCap).toBe(true);
  });

  it("counts a pid that vanishes between the tree scan and the PSS read as 0", () => {
    proc(100, { ppid: 1, rssKb: 3072 * MIB_KB, pssKb: 1000 * MIB_KB });
    proc(101, { ppid: 100, rssKb: 1024 * MIB_KB, pssKb: 1024 * MIB_KB });
    const realRead = fs.readFileSync;
    vi.spyOn(fs, "readFileSync").mockImplementation(((file: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
      if (String(file).startsWith(path.join(procRoot, "101") + "/") && !String(file).endsWith("/stat") && !String(file).endsWith("/status")) {
        // smaps_rollup gone: the process exited after RSS was sampled.
        fs.rmSync(path.join(procRoot, "101"), { recursive: true, force: true });
      }
      return (realRead as (...a: unknown[]) => unknown)(file, ...rest);
    }) as typeof fs.readFileSync);
    const mem = measureProcessTreeMemory({ rootPid: 100, capBytes: 2 * GIB, procRoot });
    expect(mem.rssBytes).toBe(4 * GIB);
    expect(mem.pssBytes).toBe(1000 * 1024 * 1024);
    expect(mem.overCap).toBe(false);
  });

  it("does not read PSS when summed RSS is already under the cap", () => {
    proc(100, { ppid: 1, rssKb: 512 * MIB_KB, pssKb: 512 * MIB_KB });
    const spy = vi.spyOn(fs, "readFileSync");
    const mem = measureProcessTreeMemory({ rootPid: 100, capBytes: GIB, procRoot });
    expect(mem).toEqual({ pssBytes: null, rssBytes: 512 * 1024 * 1024, overCap: false });
    expect(spy.mock.calls.some(([file]) => String(file).endsWith("smaps_rollup"))).toBe(false);
  });
});
