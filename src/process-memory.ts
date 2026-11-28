import fs from "node:fs";

/**
 * Process-tree memory sampling for the in-process agent memory watchdog.
 *
 * Summed per-process `VmRSS` counts a page mapped by N processes N times (16
 * `rustc` workers all mapping `librustc_driver` count it 16 times), so it is
 * kept only as a cheap pre-check and a diagnostic. The watchdog kills on summed
 * proportional set size (`Pss` from `/proc/<pid>/smaps_rollup`), which splits
 * every shared page between the processes mapping it and so counts it once.
 *
 * Every function takes a `procRoot` (default `/proc`) so tests can build a
 * fake proc tree in a temp dir instead of reading the host's.
 */

// rootPid plus all descendant PIDs, leaf-first (SIGKILL hits children before
// parents). Linux-only; elsewhere returns [rootPid].
export function collectProcessTreePids(rootPid: number, procRoot = "/proc"): number[] {
  if (process.platform !== "linux") return [rootPid];
  let entries: string[];
  try { entries = fs.readdirSync(procRoot); } catch { return [rootPid]; }
  if (!Array.isArray(entries)) return [rootPid];
  const childrenByPpid = new Map<number, number[]>();
  for (const name of entries) {
    if (!/^\d+$/.test(name)) continue;
    const pid = Number(name);
    let stat: string;
    try { stat = fs.readFileSync(`${procRoot}/${pid}/stat`, "utf8"); } catch { continue; }
    const rparen = stat.lastIndexOf(")"); // comm field may contain spaces/parens
    if (rparen < 0) continue;
    const fields = stat.slice(rparen + 2).split(" "); // [state, ppid, ...]
    const ppid = Number(fields[1]);
    if (!Number.isFinite(ppid)) continue;
    const arr = childrenByPpid.get(ppid);
    if (arr) arr.push(pid); else childrenByPpid.set(ppid, [pid]);
  }
  const ordered: number[] = [];
  const seen = new Set<number>([rootPid]);
  const queue = [rootPid];
  while (queue.length) {
    const pid = queue.shift()!;
    ordered.push(pid);
    for (const c of childrenByPpid.get(pid) ?? []) {
      if (!seen.has(c)) { seen.add(c); queue.push(c); }
    }
  }
  return ordered.reverse();
}

function readKbField(text: string, field: string): number | null {
  const m = new RegExp(`^${field}:\\s+(\\d+)\\s+kB`, "m").exec(text);
  if (!m) return null;
  const kb = Number(m[1]);
  return Number.isFinite(kb) ? kb : null;
}

/** Summed `VmRSS` over the tree. Counts shared pages once per process, so it
 *  overstates real memory — a pre-check and diagnostic, never a kill signal. */
export function sampleProcessTreeRssBytes(rootPid: number, procRoot = "/proc"): number {
  if (process.platform !== "linux") return 0;
  let totalKb = 0;
  for (const pid of collectProcessTreePids(rootPid, procRoot)) {
    try {
      const status = fs.readFileSync(`${procRoot}/${pid}/status`, "utf8");
      totalKb += readKbField(status, "VmRSS") ?? 0;
    } catch { /* process exited mid-scan */ }
  }
  return totalKb * 1024;
}

/**
 * Summed proportional set size over the tree: each shared page is split
 * between the processes mapping it, so the sum counts it once.
 *
 * A live process whose `smaps_rollup` cannot be read (an older kernel, or a
 * permission quirk) counts its `RssAnon` — its private anonymous memory, which
 * is never shared and so never double-counted. A pid that vanished mid-scan
 * counts 0.
 */
export function sampleProcessTreePssBytes(rootPid: number, procRoot = "/proc"): number {
  if (process.platform !== "linux") return 0;
  let totalKb = 0;
  for (const pid of collectProcessTreePids(rootPid, procRoot)) {
    let pss: number | null = null;
    try {
      pss = readKbField(fs.readFileSync(`${procRoot}/${pid}/smaps_rollup`, "utf8"), "Pss");
    } catch { /* fall back below */ }
    if (pss === null) {
      try {
        pss = readKbField(fs.readFileSync(`${procRoot}/${pid}/status`, "utf8"), "RssAnon");
      } catch { /* process exited mid-scan */ }
    }
    totalKb += pss ?? 0;
  }
  return totalKb * 1024;
}

export interface ProcessTreeMemory {
  /** Summed PSS — what the watchdog kills on. Null when RSS was already under
   *  the cap, so PSS (never larger than RSS) was not read. */
  pssBytes: number | null;
  /** Summed per-process RSS, for diagnostics. */
  rssBytes: number;
  /** Whether summed PSS exceeded the cap. */
  overCap: boolean;
}

/**
 * Measure a process tree against a memory cap. Summed RSS is sampled first,
 * because it is cheap (`status` rather than `smaps_rollup`, which walks every
 * mapping) and PSS never exceeds it: under the cap on RSS means under the cap.
 * Only when RSS is over the cap is PSS read, and only PSS decides `overCap`.
 */
export function measureProcessTreeMemory(opts: { rootPid: number; capBytes: number; procRoot?: string }): ProcessTreeMemory {
  const procRoot = opts.procRoot ?? "/proc";
  const rssBytes = sampleProcessTreeRssBytes(opts.rootPid, procRoot);
  if (rssBytes <= opts.capBytes) return { pssBytes: null, rssBytes, overCap: false };
  const pssBytes = sampleProcessTreePssBytes(opts.rootPid, procRoot);
  return { pssBytes, rssBytes, overCap: pssBytes > opts.capBytes };
}
