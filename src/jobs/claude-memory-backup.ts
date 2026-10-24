import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as claude from "../claude.js";
import { collectMemoryFiles } from "../claude-memory-files.js";
import { SELF_REPO, WORK_DIR, selfRepoGitUrl } from "../config.js";
import { listUnpushedSessionMemoryCaptures, markSessionMemoryCapturePushed, type SessionMemoryCapture } from "../db.js";
import { ensureAlertIssue, closeAlertIssueIfResolved } from "../occurrence-tracking.js";
import * as log from "../log.js";

const NAME = "claude-memory-backup";
const BRANCH = "claude-memories";
const ALERT_TITLE = "[claude-memory-backup] Memory backup push is failing";
/**
 * Branch directories `memories/session-<id>-<slug>` hold one interactive session's
 * captured memories (`session-memory-capture.ts`). The host pass never writes or
 * removes one; a session's capture replaces only its own.
 */
const SESSION_DIR_PREFIX = "session-";

// project-slug → (filename → content) for every readable memory/*.md file under ~/.claude/projects.
function collectMemories(): Map<string, Map<string, string>> {
  const { projects, skipped } = collectMemoryFiles(path.join(os.homedir(), ".claude", "projects"));
  if (skipped > 0) log.debug(`[${NAME}] Skipped ${skipped} memory file(s) over the size caps or unreadable`);
  // A local project of that name would collide with a session's directory on the branch.
  for (const project of [...projects.keys()]) if (project.startsWith(SESSION_DIR_PREFIX)) projects.delete(project);
  return projects;
}

/** Replace session `capture.session_id`'s directories under `memoriesDir` with its captured files. */
function applySessionCapture(memoriesDir: string, capture: SessionMemoryCapture): number {
  const own = `${SESSION_DIR_PREFIX}${capture.session_id}-`;
  let existing: string[] = [];
  try {
    existing = fs.readdirSync(memoriesDir);
  } catch {
    // No memories/ directory yet: nothing of this session's to remove.
  }
  // Slugs always start with `-`, so `session-<id>--` cannot match another session's id.
  for (const entry of existing) {
    if (entry.startsWith(`${own}-`)) fs.rmSync(path.join(memoriesDir, entry), { recursive: true, force: true });
  }
  let written = 0;
  for (const [slug, files] of Object.entries(capture.files)) {
    if (!slug.startsWith("-") || slug.includes("/")) continue;
    const pDir = path.join(memoriesDir, `${own}${slug}`);
    fs.mkdirSync(pDir, { recursive: true });
    for (const [filename, content] of Object.entries(files)) {
      if (!filename.endsWith(".md") || filename.includes("/") || filename.startsWith(".") || typeof content !== "string") continue;
      fs.writeFileSync(path.join(pDir, filename), content, "utf8");
      written++;
    }
  }
  return written;
}

let inFlight: Promise<void> | undefined;

export function run(): Promise<void> {
  if (!inFlight) {
    inFlight = doRun().finally(() => {
      inFlight = undefined;
    });
  }
  return inFlight;
}

async function markCapturesPushed(captures: SessionMemoryCapture[]): Promise<void> {
  const at = Date.now();
  for (const capture of captures) {
    try {
      await markSessionMemoryCapturePushed(capture.session_id, capture.captured_at, at);
    } catch (err) {
      // Left unpushed: the next run re-applies the same files, which is a no-op.
      log.warn(`[${NAME}] Failed to mark session ${capture.session_id}'s memory capture pushed: ${err}`);
    }
  }
}

async function doRun(): Promise<void> {
  const memories = collectMemories();
  let captures: SessionMemoryCapture[] = [];
  try {
    captures = await listUnpushedSessionMemoryCaptures();
  } catch (err) {
    log.warn(`[${NAME}] Failed to list session memory captures: ${err}`);
  }
  if (memories.size === 0 && captures.length === 0) {
    log.debug(`[${NAME}] No memory files found — skipping`);
    return;
  }
  const owner = SELF_REPO.split("/")[0]!;
  const dir = path.join(WORK_DIR, "claude-memory-backup");

  try {
    const url = selfRepoGitUrl();
    if (!fs.existsSync(path.join(dir, ".git"))) {
      fs.mkdirSync(dir, { recursive: true });
      await claude.git(["init", "-b", BRANCH], dir);
      await claude.git(["remote", "add", "origin", url], dir);
    } else if ((await claude.git(["remote", "get-url", "origin"], dir)) !== url) {
      // Re-point a checkout made before the repo moved forge.
      await claude.git(["remote", "set-url", "origin", url], dir);
    }

    const ls = await claude.git(["ls-remote", "origin", BRANCH], dir, { owner });
    if (ls.trim()) {
      await claude.git(["fetch", "--depth=1", "origin", BRANCH], dir, { owner });
      await claude.git(["reset", "--hard", "FETCH_HEAD"], dir, { owner });
      await claude.git(["checkout", "-B", BRANCH], dir);
    }

    for (const [project, files] of memories) {
      const pDir = path.join(dir, "memories", project);
      fs.rmSync(pDir, { recursive: true, force: true });
      fs.mkdirSync(pDir, { recursive: true });
      for (const [filename, content] of files) {
        fs.writeFileSync(path.join(pDir, filename), content, "utf8");
      }
    }

    let sessionFiles = 0;
    for (const capture of captures) sessionFiles += applySessionCapture(path.join(dir, "memories"), capture);

    await claude.git(["add", "-A"], dir);
    const staged = await claude.git(["status", "--porcelain"], dir);
    if (!staged) {
      log.debug(`[${NAME}] No memory changes`);
      await markCapturesPushed(captures);
      await closeAlertIssueIfResolved({ repo: SELF_REPO, title: ALERT_TITLE, logPrefix: NAME, reason: "backup succeeded" });
      return;
    }

    const total = [...memories.values()].reduce((n, m) => n + m.size, 0) + sessionFiles;
    const sessionPart = captures.length > 0 ? ` and ${captures.length} session capture(s)` : "";
    await claude.git(["commit", "-m", `chore(memories): sync ${total} memory file(s) across ${memories.size} project(s)${sessionPart}`], dir);
    await claude.git(["push", "origin", `HEAD:refs/heads/${BRANCH}`], dir, { owner });
    log.info(`[${NAME}] Pushed ${total} memory file(s) to ${SELF_REPO}@${BRANCH}`);
    await markCapturesPushed(captures);
    await closeAlertIssueIfResolved({ repo: SELF_REPO, title: ALERT_TITLE, logPrefix: NAME, reason: "backup succeeded" });
  } catch (err) {
    await ensureAlertIssue({
      repo: SELF_REPO,
      title: ALERT_TITLE,
      body: [
        `Pushing memory backups to the \`${BRANCH}\` branch of this repo has been failing.`,
        `Error: ${err instanceof Error ? err.message : String(err)}`,
        "Claude memories are unbacked-up until this is fixed.",
      ].join("\n"),
      logPrefix: NAME,
    });
  }
}
