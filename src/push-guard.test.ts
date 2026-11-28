import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  auditOutgoingFiles,
  CORE_DUMP_EXCLUDE_LINES,
  DEFAULT_MAX_PUSH_FILE_BYTES,
  ensureCoreDumpExclude,
  formatPushRefusal,
  OversizedPushError,
  type RunGit,
} from "./push-guard.js";

const ZERO = "0".repeat(40);
const MiB = 1024 * 1024;

interface Change {
  path: string;
  /** Omitted for a deletion. */
  blob?: string;
  status?: string;
}

interface FakeRepo {
  branchExists?: boolean;
  /** Outgoing commits, newest first like `rev-list`. */
  commits: { sha: string; changes: Change[] }[];
  sizes?: Record<string, number>;
  /** `<ref>:<path>` entries that `cat-file -e` finds. */
  remoteFiles?: string[];
}

function fakeGit(repo: FakeRepo): { runGit: RunGit; calls: string[][] } {
  const calls: string[][] = [];
  const ok = (stdout = "") => ({ code: 0, stdout, stderr: "" });
  const fail = () => ({ code: 1, stdout: "", stderr: "fatal" });
  const runGit: RunGit = async (args) => {
    calls.push(args);
    const [cmd, ...rest] = args;
    if (cmd === "rev-parse") return repo.branchExists ? ok("abc") : fail();
    if (cmd === "rev-list") return ok(repo.commits.map((c) => c.sha).join("\n"));
    if (cmd === "diff-tree") {
      const commit = repo.commits.find((c) => c.sha === rest[rest.length - 1]);
      const out = (commit?.changes ?? [])
        .map((ch) => {
          const deleted = ch.blob === undefined;
          const meta = `:${deleted ? "100644" : "000000"} ${deleted ? "000000" : "100644"} ${deleted ? "e".repeat(40) : ZERO} ${ch.blob ?? ZERO} ${ch.status ?? (deleted ? "D" : "A")}`;
          return `${meta}\0${ch.path}\0`;
        })
        .join("");
      return ok(out);
    }
    if (cmd === "cat-file" && rest[0] === "-s") return ok(String(repo.sizes?.[rest[1]] ?? 10));
    if (cmd === "cat-file" && rest[0] === "-e") return repo.remoteFiles?.includes(rest[1]) ? ok() : fail();
    throw new Error(`unexpected git ${args.join(" ")}`);
  };
  return { runGit, calls };
}

const OPTS = { branchName: "claws/issue-1", defaultBranch: "main", maxFileBytes: DEFAULT_MAX_PUSH_FILE_BYTES };

describe("auditOutgoingFiles", () => {
  it("flags a root core dump and a nested core.<pid> even when small", async () => {
    const { runGit } = fakeGit({
      commits: [{ sha: "c1", changes: [{ path: "core", blob: "b1" }, { path: "dir/core.1234", blob: "b2" }] }],
    });
    const offenders = await auditOutgoingFiles("/wt", OPTS, runGit);
    expect(offenders).toEqual([
      { path: "core", bytes: 10, reason: "core-dump", commit: "c1" },
      { path: "dir/core.1234", bytes: 10, reason: "core-dump", commit: "c1" },
    ]);
  });

  it("does not flag core.ts or files under a core/ directory", async () => {
    const { runGit } = fakeGit({
      commits: [{ sha: "c1", changes: [{ path: "src/core.ts", blob: "b1" }, { path: "apps/android/core/Main.kt", blob: "b2" }] }],
    });
    expect(await auditOutgoingFiles("/wt", OPTS, runGit)).toEqual([]);
  });

  it("still flags a core dump added in one commit and deleted in a later one", async () => {
    const { runGit } = fakeGit({
      commits: [
        { sha: "c2", changes: [{ path: "core" }] },
        { sha: "c1", changes: [{ path: "core", blob: "b1" }] },
      ],
      sizes: { b1: 4 * 1024 * MiB },
    });
    const offenders = await auditOutgoingFiles("/wt", OPTS, runGit);
    expect(offenders).toEqual([{ path: "core", bytes: 4 * 1024 * MiB, reason: "core-dump", commit: "c1" }]);
  });

  it("flags a new file above the threshold", async () => {
    const { runGit } = fakeGit({
      commits: [{ sha: "c1", changes: [{ path: "big.bin", blob: "b1" }] }],
      sizes: { b1: 6 * MiB },
    });
    expect(await auditOutgoingFiles("/wt", OPTS, runGit)).toEqual([
      { path: "big.bin", bytes: 6 * MiB, reason: "oversized", commit: "c1" },
    ]);
  });

  it("allows a large file the default branch already tracks", async () => {
    const { runGit } = fakeGit({
      commits: [{ sha: "c1", changes: [{ path: "big.bin", blob: "b1", status: "M" }] }],
      sizes: { b1: 6 * MiB },
      remoteFiles: ["origin/main:big.bin"],
    });
    expect(await auditOutgoingFiles("/wt", OPTS, runGit)).toEqual([]);
  });

  it("allows a large file the remote branch already tracks", async () => {
    const { runGit } = fakeGit({
      branchExists: true,
      commits: [{ sha: "c1", changes: [{ path: "big.bin", blob: "b1", status: "M" }] }],
      sizes: { b1: 6 * MiB },
      remoteFiles: ["origin/claws/issue-1:big.bin"],
    });
    expect(await auditOutgoingFiles("/wt", OPTS, runGit)).toEqual([]);
  });

  it("honours a raised per-repo threshold", async () => {
    const { runGit } = fakeGit({
      commits: [{ sha: "c1", changes: [{ path: "big.bin", blob: "b1" }] }],
      sizes: { b1: 6 * MiB },
    });
    expect(await auditOutgoingFiles("/wt", { ...OPTS, maxFileBytes: 10 * MiB }, runGit)).toEqual([]);
  });

  it("allows a small new file", async () => {
    const { runGit } = fakeGit({
      commits: [{ sha: "c1", changes: [{ path: "notes.txt", blob: "b1" }] }],
      sizes: { b1: 1024 },
    });
    expect(await auditOutgoingFiles("/wt", OPTS, runGit)).toEqual([]);
  });

  it("ignores deletion records", async () => {
    const { runGit, calls } = fakeGit({ commits: [{ sha: "c1", changes: [{ path: "huge.bin" }] }] });
    expect(await auditOutgoingFiles("/wt", OPTS, runGit)).toEqual([]);
    expect(calls.some((c) => c[0] === "cat-file")).toBe(false);
  });

  it("takes the destination path of a rename", async () => {
    const { runGit } = fakeGit({ commits: [{ sha: "c1", changes: [] }] });
    const renaming: RunGit = async (args) =>
      args[0] === "diff-tree"
        ? { code: 0, stdout: `:100644 100644 ${"a".repeat(40)} ${"b".repeat(40)} R100\0old.txt\0core\0`, stderr: "" }
        : runGit(args);
    const offenders = await auditOutgoingFiles("/wt", OPTS, renaming);
    expect(offenders.map((o) => o.path)).toEqual(["core"]);
  });

  it("makes no git calls beyond rev-list when nothing is outgoing", async () => {
    const { runGit, calls } = fakeGit({ commits: [] });
    expect(await auditOutgoingFiles("/wt", OPTS, runGit)).toEqual([]);
    expect(calls.map((c) => c[0])).toEqual(["rev-parse", "rev-list"]);
  });

  it("excludes the remote branch from rev-list only when it exists", async () => {
    const absent = fakeGit({ commits: [] });
    await auditOutgoingFiles("/wt", OPTS, absent.runGit);
    expect(absent.calls[1]).toEqual(["rev-list", "HEAD", "^origin/main"]);

    const present = fakeGit({ branchExists: true, commits: [] });
    await auditOutgoingFiles("/wt", OPTS, present.runGit);
    expect(present.calls[1]).toEqual(["rev-list", "HEAD", "^origin/main", "^origin/claws/issue-1"]);
  });
});

describe("formatPushRefusal / OversizedPushError", () => {
  it("names every file and its reason", () => {
    const err = new OversizedPushError(
      "claws/issue-1",
      [
        { path: "core", bytes: 4.1 * 1024 * MiB, reason: "core-dump", commit: "c1" },
        { path: "big.bin", bytes: 12.3 * MiB, reason: "oversized", commit: "c1" },
      ],
      DEFAULT_MAX_PUSH_FILE_BYTES,
    );
    expect(err.name).toBe("OversizedPushError");
    expect(err.branchName).toBe("claws/issue-1");
    expect(err.message).toBe(
      "Push of claws/issue-1 refused: `core` (4.10 GB) is a core dump. `big.bin` (12.3 MB) exceeds the 5.0 MB limit for new files. Set maxPushFileBytes in claws.json to raise the limit for this repo.",
    );
  });

  it("omits the threshold hint when only core dumps are refused", () => {
    expect(formatPushRefusal("b", [{ path: "core", bytes: 10, reason: "core-dump", commit: "c" }], MiB)).toBe(
      "Push of b refused: `core` (10 B) is a core dump.",
    );
  });
});

describe("ensureCoreDumpExclude", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  it("creates the exclude file, appends once, and is a no-op afterwards", () => {
    const gitDir = fs.mkdtempSync(path.join(os.tmpdir(), "push-guard-"));
    dirs.push(gitDir);
    const excludePath = path.join(gitDir, "info", "exclude");

    ensureCoreDumpExclude(gitDir);
    const first = fs.readFileSync(excludePath, "utf8");
    expect(first).toBe(CORE_DUMP_EXCLUDE_LINES.join("\n") + "\n");

    ensureCoreDumpExclude(gitDir);
    expect(fs.readFileSync(excludePath, "utf8")).toBe(first);
  });

  it("appends after existing excludes without a trailing newline", () => {
    const gitDir = fs.mkdtempSync(path.join(os.tmpdir(), "push-guard-"));
    dirs.push(gitDir);
    fs.mkdirSync(path.join(gitDir, "info"));
    fs.writeFileSync(path.join(gitDir, "info", "exclude"), "*.log");

    ensureCoreDumpExclude(gitDir);
    expect(fs.readFileSync(path.join(gitDir, "info", "exclude"), "utf8")).toBe(
      "*.log\n" + CORE_DUMP_EXCLUDE_LINES.join("\n") + "\n",
    );
  });
});
