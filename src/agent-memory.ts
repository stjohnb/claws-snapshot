import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { SELF_REPO, WORK_DIR } from "./config.js";
import * as claude from "./claude.js";
import * as log from "./log.js";

export interface MemoryFile { scope: string; name: string; content: string }
export interface RepoMemories { files: MemoryFile[]; digest: string; available: boolean }

const MAX_FILE_BYTES = 64 * 1024;
const MAX_FILES = 80;
const MAX_TOTAL_BYTES = 512 * 1024;

const BRANCH = "claude-memories";
/** Approximates "once per doc-maintainer run": one tick fans out over repos concurrently. */
const SYNC_TTL_MS = 10 * 60 * 1000;
let syncPromise: Promise<string | null> | null = null;
let syncedAt = 0;

/** Fetches the claude-memories branch into a read-only checkout and returns its path,
 *  or null if the branch is missing or the fetch failed. Deduped across concurrent
 *  callers and cached for SYNC_TTL_MS. */
export async function syncMemoryBranch(): Promise<string | null> {
  if (syncPromise && Date.now() - syncedAt < SYNC_TTL_MS) return syncPromise;

  syncedAt = Date.now();
  syncPromise = (async () => {
    try {
      // A separate checkout from claude-memory-backup's WORK_DIR/claude-memory-backup:
      // that job does `reset --hard` / `add -A` / `commit` in its own working tree every
      // hour, and a concurrent `reset --hard` from here could destroy its staged backup
      // mid-run, or read a half-written tree. This tree is read-only and only ever fetched.
      const dir = path.join(WORK_DIR, "claude-memories-fold");
      const owner = SELF_REPO.split("/")[0]!;
      if (!fs.existsSync(path.join(dir, ".git"))) {
        fs.mkdirSync(dir, { recursive: true });
        await claude.git(["init", "-b", BRANCH], dir);
        await claude.git(["remote", "add", "origin", `https://github.com/${SELF_REPO}.git`], dir);
      }

      const ls = await claude.git(["ls-remote", "origin", BRANCH], dir, { owner });
      if (!ls.trim()) return null;

      await claude.git(["fetch", "--depth=1", "origin", BRANCH], dir, { owner });
      await claude.git(["reset", "--hard", "FETCH_HEAD"], dir, { owner });
      await claude.git(["checkout", "-B", BRANCH], dir);
      return dir;
    } catch (err) {
      log.warn(`[agent-memory] Failed to sync ${BRANCH}: ${err}`);
      return null;
    }
  })();
  return syncPromise;
}

function collectSource(dir: string, scope: string): MemoryFile[] {
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch (err) {
    log.debug(`[agent-memory] Failed to list ${dir}: ${err}`);
    return [];
  }

  // MEMORY.md indexes the rest of the store, so it always leads; the remainder is
  // alphabetical for stable, deterministic output.
  const mdFiles = entries.filter((name) => name.endsWith(".md")).sort((a, b) => {
    if (a === "MEMORY.md") return -1;
    if (b === "MEMORY.md") return 1;
    return a.localeCompare(b);
  });

  const files: MemoryFile[] = [];
  for (const name of mdFiles) {
    const full = path.join(dir, name);

    let st: fs.Stats;
    try {
      // lstatSync, not statSync — a memory file must never be followed through a symlink.
      st = fs.lstatSync(full);
    } catch (err) {
      log.debug(`[agent-memory] Failed to stat ${full}: ${err}`);
      continue;
    }
    if (!st.isFile()) continue;
    if (st.size > MAX_FILE_BYTES) {
      log.warn(`[agent-memory] Skipping ${full} — exceeds ${MAX_FILE_BYTES}-byte file cap`);
      continue;
    }

    try {
      files.push({ scope, name, content: fs.readFileSync(full, "utf8") });
    } catch (err) {
      log.debug(`[agent-memory] Failed to read ${full}: ${err}`);
    }
  }
  return files;
}

/** Collects every memories/<slug>/*.md on the claude-memories branch whose slug belongs to
 *  this repo, from any host that ever wrote it. `available: false` means the branch could
 *  not be read this run — callers must NOT treat that as "no memories". */
export async function collectRepoMemories(repo: { owner: string; name: string }): Promise<RepoMemories> {
  const dir = await syncMemoryBranch();
  if (!dir) return { files: [], digest: "", available: false };

  const root = path.join(dir, "memories");
  if (!fs.existsSync(root)) return { files: [], digest: "", available: true };

  // Slugs are the clone's absolute path with `/` and `.` replaced by `-`, so any host's
  // slug for this repo ends with this suffix. Including the owner segment is what makes
  // the match safe: `-St-John-Software-config` cannot match
  // `…-St-John-Software-home-assistant-config`.
  const suffix = `-${repo.owner}-${repo.name}`.replace(/[/.]/g, "-");

  let entries: string[];
  try {
    entries = fs.readdirSync(root);
  } catch (err) {
    log.debug(`[agent-memory] Failed to list ${root}: ${err}`);
    return { files: [], digest: "", available: false };
  }

  const matched = entries.filter((entry) => {
    if (!entry.endsWith(suffix)) return false;
    try {
      return fs.lstatSync(path.join(root, entry)).isDirectory();
    } catch (err) {
      log.debug(`[agent-memory] Failed to stat ${path.join(root, entry)}: ${err}`);
      return false;
    }
  }).sort((a, b) => a.localeCompare(b));

  if (matched.length > 0) {
    log.info(`[agent-memory] ${repo.owner}/${repo.name}: folding ${matched.length} memory slug(s) from ${BRANCH}`);
  }

  const collected: MemoryFile[] = [];
  matched.forEach((slug, i) => {
    collected.push(...collectSource(path.join(root, slug), `claude-h${i + 1}`));
  });

  const files: MemoryFile[] = [];
  let totalBytes = 0;
  let dropped = 0;
  for (const f of collected) {
    const size = Buffer.byteLength(f.content, "utf8");
    if (files.length >= MAX_FILES || totalBytes + size > MAX_TOTAL_BYTES) {
      dropped = collected.length - files.length;
      break;
    }
    files.push(f);
    totalBytes += size;
  }
  if (dropped > 0) {
    log.warn(`[agent-memory] Dropped ${dropped} memory file(s) for ${repo.owner}/${repo.name} — exceeded the ${MAX_FILES}-file / ${MAX_TOTAL_BYTES}-byte cap`);
  }

  if (files.length === 0) return { files, digest: "", available: true };

  const hash = crypto.createHash("sha256");
  for (const f of files) hash.update(`${f.scope}/${f.name}\n${f.content}\n`);
  return { files, digest: hash.digest("hex"), available: true };
}

/** Test-only: clears the module-level sync cache so each test gets a fresh fetch. */
export function __resetMemoryBranchCacheForTests(): void {
  syncPromise = null;
  syncedAt = 0;
}
