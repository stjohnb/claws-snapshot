import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const WORK_DIR = "/home/testuser/.claws";

vi.mock("../config.js", () => ({
  WORK_DIR: "/home/testuser/.claws",
  SELF_REPO: "St-John-Software/claws",
}));

vi.mock("../log.js", () => ({
  info: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
}));

const { mockFs, mockExecFile, mockSlack, mockTracking, mockWorktreeCleaner } = vi.hoisted(() => ({
  mockFs: {
    statfsSync: vi.fn(),
    existsSync: vi.fn(),
    rmSync: vi.fn(),
    readdirSync: vi.fn(),
  },
  mockExecFile: vi.fn(),
  mockSlack: { notify: vi.fn() },
  mockTracking: {
    ensureAlertIssue: vi.fn(),
    closeAlertIssueIfResolved: vi.fn(),
  },
  mockWorktreeCleaner: { run: vi.fn() },
}));

vi.mock("node:fs", () => ({ default: mockFs }));
vi.mock("node:child_process", () => ({
  execFile: (_cmd: string, _args: string[], _opts: unknown, cb: (...args: unknown[]) => void) => {
    mockExecFile(_cmd, _args, _opts, cb);
  },
}));
vi.mock("node:util", () => ({
  promisify: (fn: (...args: unknown[]) => unknown) => {
    return (...args: unknown[]) =>
      new Promise((resolve, reject) => {
        fn(...args, (err: unknown, result: unknown) => {
          if (err) reject(err);
          else resolve(result);
        });
      });
  },
}));
vi.mock("../slack.js", () => mockSlack);
vi.mock("../occurrence-tracking.js", () => mockTracking);
vi.mock("../cli-path.js", () => ({ enrichedPath: (p: string | undefined) => p ?? "" }));
vi.mock("./worktree-cleaner.js", () => mockWorktreeCleaner);

import os from "node:os";
import path from "node:path";
import * as log from "../log.js";
import { run, sweepTmp, __resetTier2CooldownForTests } from "./host-disk-monitor.js";

const HOSTNAME = os.hostname();
const DISK_TITLE = `[host-disk-monitor] Persistent high disk on ${HOSTNAME}`;
const RUNTIME_TITLE = `[host-disk-monitor] Container runtime present on plan-only host ${HOSTNAME}`;

/**
 * statfs for a filesystem at the given usage percentage. `df` computes
 * used/(used+avail), so blocks must exceed used+avail to model root reserve.
 */
function statfsAt(percent: number) {
  const total = 1000;
  const used = percent * 10;
  return { blocks: total, bfree: total - used, bavail: total - used };
}

/** Queue up statfs results, one per usagePercent() call. */
function setUsage(...percents: number[]) {
  mockFs.statfsSync.mockReset();
  for (const p of percents) {
    mockFs.statfsSync.mockReturnValueOnce(statfsAt(p));
  }
  mockFs.statfsSync.mockReturnValue(statfsAt(percents[percents.length - 1]!));
}

function execCalls(): { cmd: string; args: string[] }[] {
  return mockExecFile.mock.calls.map((c) => ({ cmd: c[0] as string, args: (c[1] ?? []) as string[] }));
}

function dirent(name: string, isDirectory = true) {
  return { name, isDirectory: () => isDirectory };
}

function findCalls() {
  return execCalls().filter(c => c.cmd === "find");
}

beforeEach(() => {
  vi.clearAllMocks();
  __resetTier2CooldownForTests();
  mockFs.existsSync.mockReturnValue(false);
  mockFs.rmSync.mockReturnValue(undefined);
  mockFs.readdirSync.mockReturnValue([]);
  mockWorktreeCleaner.run.mockResolvedValue({ removed: 0, freedBytes: 0 });
  mockTracking.ensureAlertIssue.mockResolvedValue({ outcome: "created", issueNumber: 1 });
  mockTracking.closeAlertIssueIfResolved.mockResolvedValue(null);
  // Every subprocess succeeds by default
  mockExecFile.mockImplementation(
    (_cmd: string, _args: string[], _opts: unknown, cb: (err: null, r: { stdout: string }) => void) => {
      cb(null, { stdout: "ok\n" });
    },
  );
});

describe("host-disk-monitor", () => {
  it("does nothing but clear the alert when usage is below the warn threshold", async () => {
    setUsage(70);

    await run();

    expect(mockExecFile).not.toHaveBeenCalled();
    expect(mockWorktreeCleaner.run).not.toHaveBeenCalled();
    expect(mockTracking.ensureAlertIssue).not.toHaveBeenCalled();
    expect(mockTracking.closeAlertIssueIfResolved).toHaveBeenCalledWith(
      expect.objectContaining({ title: DISK_TITLE }),
    );
  });

  it("runs tier 1 only when tier 1 clears the warn band", async () => {
    setUsage(82, 79);

    await run();

    const calls = execCalls();
    expect(calls).toContainEqual({ cmd: "npm", args: ["cache", "clean", "--force"] });
    expect(calls).toContainEqual({ cmd: "sudo", args: ["-n", "journalctl", "--vacuum-size=200M"] });
    expect(calls).toContainEqual({ cmd: "sudo", args: ["-n", "apt-get", "clean"] });
    expect(mockWorktreeCleaner.run).toHaveBeenCalledWith({ staleMs: 86_400_000 });

    // Tier 2 must not run
    expect(calls.some(c => c.cmd.includes("nix-collect-garbage"))).toBe(false);
  });

  it("escalates into tier 2 in the warn band when tier 1 does not recover", async () => {
    setUsage(83, 83, 70);

    await run();

    expect(execCalls().some(c => c.cmd.includes("nix-collect-garbage"))).toBe(true);
    expect(mockFs.rmSync).toHaveBeenCalledWith(
      expect.stringContaining(".cache/puppeteer"),
      { recursive: true, force: true },
    );
    expect(mockFs.rmSync).toHaveBeenCalledWith(
      expect.stringContaining(".cache/uv"),
      { recursive: true, force: true },
    );
    expect(mockTracking.closeAlertIssueIfResolved).toHaveBeenCalledWith(
      expect.objectContaining({ title: DISK_TITLE }),
    );
    expect(mockTracking.ensureAlertIssue).not.toHaveBeenCalledWith(
      expect.objectContaining({ title: DISK_TITLE }),
    );
  });

  it("does not file an issue when the warn band persists and tier 2 is on cooldown", async () => {
    setUsage(83, 83, 83);
    await run(); // consumes the cooldown, files the issue

    mockExecFile.mockClear();
    mockTracking.ensureAlertIssue.mockClear();

    setUsage(83, 83, 83);
    await run(); // second tick, 6 h has not elapsed

    expect(execCalls().some(c => c.cmd.includes("nix-collect-garbage"))).toBe(false);
    expect(mockTracking.ensureAlertIssue).not.toHaveBeenCalledWith(
      expect.objectContaining({ title: DISK_TITLE }),
    );
  });

  it("still files the issue when tier 2 runs and space is not recovered", async () => {
    setUsage(83, 83, 83);

    await run();

    expect(mockTracking.ensureAlertIssue).toHaveBeenCalledWith(
      expect.objectContaining({ title: DISK_TITLE, refreshBody: true }),
    );
    expect(mockSlack.notify).toHaveBeenCalled();
  });

  it("runs tier 2 above the critical threshold, without sudo for the nix GC", async () => {
    setUsage(92, 70);

    await run();

    const nixCalls = execCalls().filter(c => c.cmd.includes("nix-collect-garbage"));
    expect(nixCalls).toHaveLength(1);
    expect(nixCalls[0]!.args).toEqual(["-d"]);
    expect(nixCalls[0]!.cmd).not.toContain("sudo");

    for (const cache of ["puppeteer", "Cypress", "ms-playwright"]) {
      expect(mockFs.rmSync).toHaveBeenCalledWith(
        expect.stringContaining(`.cache/${cache}`),
        { recursive: true, force: true },
      );
    }
  });

  it("never invokes docker or podman, even at tier 2", async () => {
    setUsage(92, 92);

    await run();

    for (const { cmd, args } of execCalls()) {
      expect(cmd).not.toMatch(/\b(docker|podman)\b/);
      for (const arg of args) {
        // /var/lib/{docker,containerd} path probes are fine; a bare command is not
        if (arg.startsWith("/var/lib/")) continue;
        expect(arg).not.toMatch(/\b(docker|podman)\b/);
      }
    }
  });

  it("escalates to a deduped issue when cleanup does not recover space", async () => {
    setUsage(92, 92);

    await run();

    expect(mockTracking.ensureAlertIssue).toHaveBeenCalledWith(
      expect.objectContaining({
        repo: "St-John-Software/claws",
        title: DISK_TITLE,
        refreshBody: true,
        logPrefix: "host-disk-monitor",
      }),
    );
    expect(mockSlack.notify).toHaveBeenCalled();
  });

  it("closes the alert instead of escalating when cleanup recovers space", async () => {
    setUsage(92, 70);

    await run();

    expect(mockTracking.ensureAlertIssue).not.toHaveBeenCalled();
    expect(mockTracking.closeAlertIssueIfResolved).toHaveBeenCalledWith(
      expect.objectContaining({ title: DISK_TITLE }),
    );
  });

  it("trips the container-runtime alert when /var/lib/containerd exists", async () => {
    setUsage(70);
    mockFs.existsSync.mockImplementation((p: string) => p === "/var/lib/containerd");

    await run();

    expect(mockTracking.ensureAlertIssue).toHaveBeenCalledWith(
      expect.objectContaining({ title: RUNTIME_TITLE, refreshBody: true }),
    );
  });

  it("clears the container-runtime alert when no evidence is present", async () => {
    setUsage(70);

    await run();

    expect(mockTracking.closeAlertIssueIfResolved).toHaveBeenCalledWith(
      expect.objectContaining({ title: RUNTIME_TITLE }),
    );
  });

  it("still runs the tripwire when the disk check throws", async () => {
    mockFs.statfsSync.mockImplementation(() => {
      throw new Error("statfs blew up");
    });
    mockFs.existsSync.mockImplementation((p: string) => p === "/var/lib/docker");

    await run();

    expect(mockTracking.ensureAlertIssue).toHaveBeenCalledWith(
      expect.objectContaining({ title: RUNTIME_TITLE }),
    );
  });

  it("does not reject when the tripwire's alert call fails", async () => {
    setUsage(70);
    mockFs.existsSync.mockImplementation((p: string) => p === "/var/lib/docker");
    mockTracking.ensureAlertIssue.mockRejectedValue(new Error("GitHub down"));

    await expect(run()).resolves.toBeUndefined();
  });
});

describe("sweepTmp", () => {
  const tmp = os.tmpdir();

  it("selects only the four root shapes", async () => {
    mockFs.readdirSync.mockReturnValue([
      dirent("claude-1000"),
      dirent("nix-shell.ABC"),
      dirent("node-compile-cache"),
      dirent("jest_rs"),
      dirent("avitest"),
      dirent("venv_astro"),
    ]);

    await sweepTmp();

    const calls = findCalls();
    expect(calls).toHaveLength(7);
    for (const expected of ["claude-1000", "nix-shell.ABC", "node-compile-cache", "jest_rs"]) {
      const expectedPath = path.join(tmp, expected);
      for (const call of [calls[0]!, calls[1]!, calls[2]!]) {
        expect(call.args).toContain(expectedPath);
      }
    }
    for (const call of [calls[0]!, calls[1]!, calls[2]!]) {
      expect(call.args.join(" ")).not.toContain("avitest");
      expect(call.args.join(" ")).not.toContain("venv_astro");
    }
    expect(calls[3]!.args[0]).toBe(tmp);
    expect(calls[4]!.args[0]).toBe(tmp);
    expect(calls[5]!.args[0]).toBe(tmp);
    expect(calls[6]!.args[0]).toBe(tmp);
  });

  it("never sweeps claude-shell-snapshot-*", async () => {
    mockFs.readdirSync.mockReturnValue([
      dirent("claude-shell-snapshot-1234", false),
      dirent("claude-1000"),
    ]);

    await sweepTmp();

    for (const call of findCalls()) {
      expect(call.args.join(" ")).not.toContain("claude-shell-snapshot");
    }
    for (const call of findCalls().slice(4)) {
      expect(call.args).toEqual(expect.arrayContaining(["!", "-path", `${tmp}/claude-*`]));
    }
  });

  it("chmods stale read-only directories before each file-age pass", async () => {
    mockFs.readdirSync.mockReturnValue([dirent("claude-1000")]);

    await sweepTmp();

    const calls = findCalls();
    expect(calls).toHaveLength(7);
    const uid = String(process.getuid?.() ?? 0);

    expect(calls[0]!.args).toEqual(expect.arrayContaining([
      "-uid", uid, "-type", "d", "-mmin", "+1440", "!", "-perm", "-u=rwx",
      "-exec", "chmod", "u+rwx", "{}", "+",
    ]));
    expect(calls[1]!.args).toEqual(expect.arrayContaining(["-type", "f", "-mmin", "+1440", "-delete"]));
    expect(calls[2]!.args).toEqual(expect.arrayContaining(["-mindepth", "1", "-type", "d", "-empty", "-delete"]));

    expect(calls[4]!.args).toEqual(expect.arrayContaining([
      "-uid", uid, "-type", "d", "-mmin", "+4320", "!", "-perm", "-u=rwx",
      "-exec", "chmod", "u+rwx", "{}", "+",
    ]));
    expect(calls[5]!.args).toEqual(expect.arrayContaining(["-type", "f", "-mmin", "+4320", "-delete"]));
  });

  it("ages files in pass 2 and prunes empty dirs (never a start point) in pass 3", async () => {
    mockFs.readdirSync.mockReturnValue([dirent("claude-1000")]);

    await sweepTmp();

    const calls = findCalls();
    expect(calls).toHaveLength(7);
    expect(calls[1]!.args).toEqual(expect.arrayContaining(["-type", "f", "-mmin", "+1440", "-delete"]));
    expect(calls[2]!.args).toEqual(expect.arrayContaining(["-mindepth", "1", "-type", "d", "-empty", "-delete"]));
    expect(calls[2]!.args).not.toContain("-mindepth 0");
    expect(calls[2]!.args).toContain("-mindepth");
  });

  it("deletes only stale top-level hidden shared objects owned by this uid", async () => {
    mockFs.readdirSync.mockReturnValue([]);

    await sweepTmp();

    expect(findCalls()[0]!.args).toEqual([
      tmp,
      "-xdev",
      "-mindepth",
      "1",
      "-maxdepth",
      "1",
      "-uid",
      String(process.getuid?.() ?? 0),
      "-type",
      "f",
      "-name",
      ".*.so",
      "-mmin",
      "+1440",
      "-delete",
    ]);
  });

  it("never uses sudo or a shell", async () => {
    mockFs.readdirSync.mockReturnValue([dirent("claude-1000")]);

    await sweepTmp();

    expect(execCalls().some(c => c.cmd === "sudo" && c.args.includes("find"))).toBe(false);
    expect(execCalls().some(c => c.cmd === "bash")).toBe(false);
  });

  it("swallows a pass-1 failure and still runs pass 2", async () => {
    mockFs.readdirSync.mockReturnValue([dirent("claude-1000")]);
    let findCallCount = 0;
    mockExecFile.mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown, cb: (...args: unknown[]) => void) => {
        if (_cmd === "find") {
          findCallCount++;
          if (findCallCount === 1) {
            cb(new Error("find failed"), null);
            return;
          }
        }
        cb(null, { stdout: "ok\n" });
      },
    );

    await expect(sweepTmp()).resolves.toBe(true);
    expect(findCallCount).toBe(7);
  });

  it("logs a bounded summary instead of dumping a huge stderr", async () => {
    mockFs.readdirSync.mockReturnValue([dirent("claude-1000")]);
    const bigStderr = Array.from(
      { length: 25_000 },
      (_, i) => `find: cannot delete '/tmp/claude-1000/x/${i}': Permission denied`,
    ).join("\n");
    let findCallCount = 0;
    mockExecFile.mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown, cb: (...args: unknown[]) => void) => {
        if (_cmd === "find") {
          findCallCount++;
          if (findCallCount === 1) {
            cb(Object.assign(new Error(`Command failed: find …\n${bigStderr}`), { code: 1, stderr: bigStderr }), null);
            return;
          }
        }
        cb(null, { stdout: "ok\n" });
      },
    );

    await expect(sweepTmp()).resolves.toBe(true);

    for (const call of (log.debug as ReturnType<typeof vi.fn>).mock.calls) {
      const message = String(call[0]);
      expect((message.match(/\n/g) ?? []).length).toBeLessThanOrEqual(1);
      expect(message.length).toBeLessThan(2000);
    }
    expect(
      (log.debug as ReturnType<typeof vi.fn>).mock.calls.some(call => String(call[0]).includes("25000")),
    ).toBe(true);
  });

  it("still sweeps generic /tmp when no named roots exist", async () => {
    mockFs.readdirSync.mockReturnValue([]);

    const result = await sweepTmp();

    expect(result).toBe(true);
    expect(findCalls()).toHaveLength(4);
  });

  it("resolves false when readdirSync throws", async () => {
    mockFs.readdirSync.mockImplementation(() => {
      throw new Error("ENOENT");
    });

    const result = await sweepTmp();

    expect(result).toBe(false);
    expect(findCalls()).toHaveLength(0);
  });

  it("generic chmod pass is uid- and age-gated", async () => {
    mockFs.readdirSync.mockReturnValue([]);

    await sweepTmp();

    const calls = findCalls();
    expect(calls[1]!.args).toEqual(expect.arrayContaining(["-uid", String(process.getuid?.() ?? 0)]));
    expect(calls[1]!.args).toEqual(expect.arrayContaining(["-type", "d", "-mmin", "+4320"]));
    expect(calls[1]!.args).toEqual(expect.arrayContaining(["!", "-perm", "-u=rwx", "-exec", "chmod", "u+rwx", "{}", "+"]));
  });

  it("generic file pass ages uid-owned files at 72 h and deletes", async () => {
    mockFs.readdirSync.mockReturnValue([]);

    await sweepTmp();

    const calls = findCalls();
    expect(calls[2]!.args).toEqual(expect.arrayContaining(["-uid", String(process.getuid?.() ?? 0)]));
    expect(calls[2]!.args).toEqual(expect.arrayContaining(["-type", "f"]));
    expect(calls[2]!.args).toEqual(expect.arrayContaining(["-mmin", "+4320"]));
    expect(calls[2]!.args).toContain("-delete");
  });

  it("generic empty-dir pass is uid- and age-gated", async () => {
    mockFs.readdirSync.mockReturnValue([]);

    await sweepTmp();

    const calls = findCalls();
    expect(calls[3]!.args).toEqual(expect.arrayContaining(["-type", "d"]));
    expect(calls[3]!.args).toContain("-empty");
    expect(calls[3]!.args).toEqual(expect.arrayContaining(["-mmin", "+4320"]));
  });

  it("generic passes never use -prune and exclude the protected roots", async () => {
    mockFs.readdirSync.mockReturnValue([]);

    await sweepTmp();

    for (const call of findCalls().slice(1)) {
      expect(call.args).not.toContain("-prune");
    }
    for (const call of findCalls().slice(1).filter(c => c.args.includes("+4320"))) {
      expect(call.args).toEqual(expect.arrayContaining(["!", "-path", `${tmp}/nix-shell.*`]));
      expect(call.args).toEqual(expect.arrayContaining(["!", "-path", `${tmp}/.*`]));
      expect(call.args).toEqual(expect.arrayContaining(["!", "-path", `${tmp}/systemd-private-*`]));
      expect(call.args).toEqual(expect.arrayContaining(["!", "-path", `${tmp}/snap*`]));
    }
  });

  it("is wired into tier 1 and reported in the alert body", async () => {
    mockFs.readdirSync.mockReturnValue([dirent("claude-1000")]);
    setUsage(83, 83, 83);

    await run();

    expect(mockTracking.ensureAlertIssue).toHaveBeenCalledWith(
      expect.objectContaining({ body: expect.stringContaining("/tmp scratch") }),
    );
  });

  it("includes hidden top-level /tmp entries in the escalation breakdown", async () => {
    setUsage(92, 92);
    mockExecFile.mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown, cb: (err: null, r: { stdout: string }) => void) => {
        if (_cmd === "bash" && String((_args as string[])[1]).includes("find /tmp")) {
          cb(null, { stdout: "573M\t/tmp/.5fd737b6725f33bd-00000000.so\n" });
          return;
        }
        cb(null, { stdout: "ok\n" });
      },
    );

    await run();

    expect(execCalls().some(c => c.cmd === "bash" && c.args[1]!.includes("find /tmp -xdev -mindepth 1 -maxdepth 1 -printf"))).toBe(true);
    expect(execCalls().some(c => c.cmd === "bash" && c.args[1]!.includes("du -sh /tmp/*"))).toBe(false);
    expect(mockTracking.ensureAlertIssue).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.stringContaining("Top /tmp entries:\n573M\t/tmp/.5fd737b6725f33bd-00000000.so"),
      }),
    );
  });

  it("surfaces the largest /var/log files in the escalation breakdown", async () => {
    setUsage(92, 92);
    mockExecFile.mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown, cb: (err: null, r: { stdout: string }) => void) => {
        if (_cmd === "bash" && String((_args as string[])[1]).includes("/var/log")) {
          cb(null, { stdout: "1.8G\t/var/log/syslog\n" });
          return;
        }
        cb(null, { stdout: "ok\n" });
      },
    );

    await run();

    expect(mockTracking.ensureAlertIssue).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.stringContaining("Largest /var/log files:\n1.8G\t/var/log/syslog"),
      }),
    );
  });
});

describe("sweepTmp real filesystem", () => {
  let realFs: typeof import("node:fs");
  let realChildProcess: typeof import("node:child_process");
  let realExecFile: typeof import("node:child_process")["execFile"];
  let tmpRoot: string;
  let origTmpdir: string | undefined;

  beforeEach(async () => {
    realFs = await vi.importActual<typeof import("node:fs")>("node:fs");
    realChildProcess = await vi.importActual<typeof import("node:child_process")>("node:child_process");
    realExecFile = realChildProcess.execFile;

    origTmpdir = process.env["TMPDIR"];
    tmpRoot = realFs.mkdtempSync(path.join(os.tmpdir(), "host-disk-monitor-test-"));
    process.env["TMPDIR"] = tmpRoot;

    mockFs.readdirSync.mockImplementation(
      (...args: unknown[]) => (realFs.readdirSync as (...a: unknown[]) => unknown)(...args),
    );

    mockExecFile.mockImplementation(
      (cmd: string, args: string[], opts: unknown, cb: (err: unknown, r?: { stdout: string; stderr: string }) => void) => {
        (realExecFile as (...a: unknown[]) => unknown)(cmd, args, opts, (err: unknown, stdout: unknown, stderr: unknown) => {
          const out = { stdout: String(stdout ?? ""), stderr: String(stderr ?? "") };
          if (err) cb(Object.assign(err as object, out));
          else cb(null, out);
        });
      },
    );
  });

  afterEach(() => {
    try {
      realChildProcess.execFileSync("chmod", ["-R", "u+rwx", tmpRoot]);
    } catch { /* best-effort */ }
    realFs.rmSync(tmpRoot, { recursive: true, force: true });
    if (origTmpdir === undefined) delete process.env["TMPDIR"];
    else process.env["TMPDIR"] = origTmpdir;
  });

  it.runIf(process.platform === "linux")(
    "removes a stale read-only tree under a swept root and leaves a fresh one alone",
    async () => {
      const uid = process.getuid?.() ?? 0;
      const rootDir = path.join(tmpRoot, `claude-${uid}`);
      const staleRoot = path.join(rootDir, "sess");
      const scratchpad = path.join(staleRoot, "scratchpad");
      const gopath = path.join(scratchpad, "gopath");
      const pkg = path.join(gopath, "pkg");
      const mod = path.join(pkg, "mod");
      const pkgDir = path.join(mod, "ex@v1");
      realFs.mkdirSync(pkgDir, { recursive: true });

      const fileA = path.join(pkgDir, "a.go");
      const fileB = path.join(pkgDir, "b.go");
      realFs.writeFileSync(fileA, "package ex\n");
      realFs.writeFileSync(fileB, "package ex\n");

      const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
      for (const f of [fileA, fileB]) realFs.utimesSync(f, twoDaysAgo, twoDaysAgo);

      const dirsBottomUp = [pkgDir, mod, pkg, gopath, scratchpad, staleRoot];
      for (const d of dirsBottomUp) realFs.utimesSync(d, twoDaysAgo, twoDaysAgo);

      for (const f of [fileA, fileB]) realFs.chmodSync(f, 0o444);
      for (const d of dirsBottomUp) realFs.chmodSync(d, 0o555);

      const freshDir = path.join(rootDir, "fresh");
      realFs.mkdirSync(freshDir, { recursive: true });
      const freshFile = path.join(freshDir, "keep.txt");
      realFs.writeFileSync(freshFile, "keep\n");
      realFs.chmodSync(freshFile, 0o444);
      realFs.chmodSync(freshDir, 0o555);

      await sweepTmp();

      expect(realFs.existsSync(staleRoot)).toBe(false);
      expect(realFs.existsSync(rootDir)).toBe(true);
      expect(realFs.existsSync(freshFile)).toBe(true);
      expect(realFs.statSync(freshDir).mode & 0o777).toBe(0o555);
    },
  );
});

describe("host-disk-monitor under CLAWS_RUNTIME=container", () => {
  const origRuntime = process.env["CLAWS_RUNTIME"];

  beforeEach(() => {
    process.env["CLAWS_RUNTIME"] = "container";
  });

  afterEach(() => {
    if (origRuntime === undefined) delete process.env["CLAWS_RUNTIME"];
    else process.env["CLAWS_RUNTIME"] = origRuntime;
    vi.restoreAllMocks();
  });

  it("never checks or alerts on disk, however high usage is", async () => {
    setUsage(92, 92, 92);

    await run();

    expect(mockFs.statfsSync).not.toHaveBeenCalled();
    expect(mockTracking.ensureAlertIssue).not.toHaveBeenCalled();
    expect(mockTracking.closeAlertIssueIfResolved).not.toHaveBeenCalled();
    expect(mockSlack.notify).not.toHaveBeenCalled();
    expect(mockWorktreeCleaner.run).not.toHaveBeenCalled();

    const calls = execCalls();
    expect(calls.some(c => c.cmd === "sudo")).toBe(false);
    expect(calls.some(c => c.cmd === "npm")).toBe(false);
    expect(calls.some(c => c.cmd.includes("nix-collect-garbage"))).toBe(false);

    for (const call of mockFs.rmSync.mock.calls) {
      const target = String(call[0]);
      expect(target).not.toContain(".cache");
      expect(target).not.toContain(".npm");
    }
  });

  it("sweeps stale /tmp scratch", async () => {
    await run();

    expect(mockFs.readdirSync).toHaveBeenCalledWith(os.tmpdir(), expect.anything());
    expect(findCalls().some(c => c.args[0] === os.tmpdir())).toBe(true);
  });

  it("rate-limits the sweep to once every 6 hours", async () => {
    await run();
    mockExecFile.mockClear();

    await run();
    expect(findCalls()).toHaveLength(0);

    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 6 * 60 * 60 * 1000 + 1);
    await run();
    expect(findCalls().length).toBeGreaterThan(0);
  });

  it("never files the container-runtime alert", async () => {
    setUsage(70);
    mockFs.existsSync.mockImplementation((p: string) => p === "/var/lib/containerd");

    await run();

    expect(mockTracking.ensureAlertIssue).not.toHaveBeenCalledWith(
      expect.objectContaining({ title: RUNTIME_TITLE }),
    );
  });

  it("still resolves when the sweep fails", async () => {
    mockFs.readdirSync.mockImplementation(() => {
      throw new Error("ENOENT");
    });

    await expect(run()).resolves.toBeUndefined();
  });
});
