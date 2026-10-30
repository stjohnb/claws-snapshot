/**
 * Keeps core dumps and oversized new files out of agent pushes.
 *
 * A 4.1 GB `core` an implementer committed on 2026-10-18 OOMKilled Forgejo on
 * every fetch for three hours (#clw_01M5863MC9E599TGY0S6R12VN4). Two layers:
 * `ensureCoreDumpExclude` keeps `git add -A` from staging a core dump at all,
 * and `auditOutgoingFiles` (run by `claude.pushBranch` before any `git push`)
 * catches whatever still reaches a commit.
 */
import fs from "node:fs";
import path from "node:path";
import { formatBytes } from "./format.js";

/** Basename of a core dump: `core` or `core.<pid>`. `core.ts` and `core/` dirs never match. */
export const CORE_DUMP_RE = /^core(\.\d+)?$/;

/** Default size limit for a file new to the branch; a repo overrides it with `maxPushFileBytes` in `claws.json`. */
export const DEFAULT_MAX_PUSH_FILE_BYTES = 5 * 1024 * 1024;

/** Lines appended to a clone's `.git/info/exclude`; the first is the idempotency marker. */
export const CORE_DUMP_EXCLUDE_LINES = ["# claws push-guard: core dumps", "core", "core.[0-9]*", "!core/"];

export type RunGit = (args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;

export interface PushOffender {
  path: string;
  bytes: number;
  reason: "core-dump" | "oversized";
  /** The outgoing commit that adds or changes the file. */
  commit: string;
}

/**
 * Append the core-dump patterns to `<gitDir>/info/exclude` unless they are
 * already there. Every linked worktree of the clone honours that file.
 */
export function ensureCoreDumpExclude(gitDir: string): void {
  const infoDir = path.join(gitDir, "info");
  const excludePath = path.join(infoDir, "exclude");
  fs.mkdirSync(infoDir, { recursive: true });
  const existing = fs.existsSync(excludePath) ? fs.readFileSync(excludePath, "utf8") : "";
  if (existing.split("\n").some((line) => line.trim() === CORE_DUMP_EXCLUDE_LINES[0])) return;
  const separator = existing === "" || existing.endsWith("\n") ? "" : "\n";
  fs.appendFileSync(excludePath, `${separator}${CORE_DUMP_EXCLUDE_LINES.join("\n")}\n`);
}

const ZERO_SHA_RE = /^0+$/;
const SUBMODULE_MODE = "160000";

/** Destination blobs of one `diff-tree --raw -z` output; deletions and submodules are skipped. */
function parseDiffTreeRecords(stdout: string): { path: string; sha: string }[] {
  const tokens = stdout.split("\0");
  const records: { path: string; sha: string }[] = [];
  let i = 0;
  while (i < tokens.length) {
    const meta = tokens[i];
    if (!meta.startsWith(":")) {
      i++;
      continue;
    }
    const [, dstMode, , dstSha, status] = meta.slice(1).split(" ");
    const pathCount = status && (status.startsWith("R") || status.startsWith("C")) ? 2 : 1;
    const filePath = tokens[i + pathCount];
    i += pathCount + 1;
    if (!filePath || !dstSha || ZERO_SHA_RE.test(dstSha) || dstMode === SUBMODULE_MODE) continue;
    records.push({ path: filePath, sha: dstSha });
  }
  return records;
}

/**
 * List the files the commits between the remote state and `HEAD` would send
 * that are core dumps (any size) or larger than `maxFileBytes` and absent from
 * both `origin/<branchName>` and `origin/<defaultBranch>`. Deduplicated by
 * path, keeping the largest blob.
 */
export async function auditOutgoingFiles(
  wtPath: string,
  opts: { branchName: string; defaultBranch: string; maxFileBytes: number },
  runGit: RunGit,
): Promise<PushOffender[]> {
  const { branchName, defaultBranch, maxFileBytes } = opts;
  const branchRef = `origin/${branchName}`;
  const defaultRef = `origin/${defaultBranch}`;

  const branchExists = (await runGit(["rev-parse", "--verify", "--quiet", branchRef])).code === 0;
  const revList = await runGit(["rev-list", "HEAD", `^${defaultRef}`, ...(branchExists ? [`^${branchRef}`] : [])]);
  if (revList.code !== 0) {
    throw new Error(`push-guard: git rev-list of outgoing commits failed in ${wtPath}: ${revList.stderr}`);
  }
  const commits = revList.stdout.split("\n").map((s) => s.trim()).filter(Boolean);
  if (commits.length === 0) return [];

  const sizes = new Map<string, number>();
  const onRemote = new Map<string, boolean>();
  const offenders = new Map<string, PushOffender>();

  const blobSize = async (sha: string): Promise<number> => {
    const cached = sizes.get(sha);
    if (cached !== undefined) return cached;
    const res = await runGit(["cat-file", "-s", sha]);
    if (res.code !== 0) throw new Error(`push-guard: git cat-file -s ${sha} failed in ${wtPath}: ${res.stderr}`);
    const size = Number(res.stdout.trim());
    sizes.set(sha, size);
    return size;
  };

  const existsOnRemote = async (filePath: string): Promise<boolean> => {
    const cached = onRemote.get(filePath);
    if (cached !== undefined) return cached;
    let exists = false;
    if (branchExists && (await runGit(["cat-file", "-e", `${branchRef}:${filePath}`])).code === 0) exists = true;
    if (!exists && (await runGit(["cat-file", "-e", `${defaultRef}:${filePath}`])).code === 0) exists = true;
    onRemote.set(filePath, exists);
    return exists;
  };

  for (const commit of commits) {
    const diff = await runGit(["diff-tree", "-r", "-m", "--no-commit-id", "--raw", "-z", commit]);
    if (diff.code !== 0) throw new Error(`push-guard: git diff-tree ${commit} failed in ${wtPath}: ${diff.stderr}`);
    for (const record of parseDiffTreeRecords(diff.stdout)) {
      const bytes = await blobSize(record.sha);
      let reason: PushOffender["reason"] | null = null;
      if (CORE_DUMP_RE.test(path.posix.basename(record.path))) {
        reason = "core-dump";
      } else if (bytes > maxFileBytes && !(await existsOnRemote(record.path))) {
        reason = "oversized";
      }
      if (!reason) continue;
      const prior = offenders.get(record.path);
      if (!prior || bytes > prior.bytes) offenders.set(record.path, { path: record.path, bytes, reason, commit });
    }
  }
  return [...offenders.values()];
}

/** The refusal recorded in the log, the PR or issue comment, and the `[claws-error]` issue. */
export function formatPushRefusal(branchName: string, offenders: readonly PushOffender[], maxFileBytes: number): string {
  const sentences = offenders.map((o) =>
    o.reason === "core-dump"
      ? `\`${o.path}\` (${formatBytes(o.bytes)}) is a core dump.`
      : `\`${o.path}\` (${formatBytes(o.bytes)}) exceeds the ${formatBytes(maxFileBytes)} limit for new files.`,
  );
  const hint = offenders.some((o) => o.reason === "oversized")
    ? " Set maxPushFileBytes in claws.json to raise the limit for this repo."
    : "";
  return `Push of ${branchName} refused: ${sentences.join(" ")}${hint}`;
}

/** Thrown by `claude.pushBranch` before any `git push` when the outgoing commits carry an offender. */
export class OversizedPushError extends Error {
  readonly offenders: readonly PushOffender[];
  readonly branchName: string;

  constructor(branchName: string, offenders: readonly PushOffender[], maxFileBytes: number) {
    super(formatPushRefusal(branchName, offenders, maxFileBytes));
    this.name = "OversizedPushError";
    this.offenders = offenders;
    this.branchName = branchName;
  }
}
