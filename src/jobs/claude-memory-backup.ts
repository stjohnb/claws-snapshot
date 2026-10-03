import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as claude from "../claude.js";
import { SELF_REPO, WORK_DIR } from "../config.js";
import { ensureAlertIssue, closeAlertIssueIfResolved } from "../occurrence-tracking.js";
import * as log from "../log.js";

const NAME = "claude-memory-backup";
const BRANCH = "claude-memories";
const MAX_FILE_BYTES = 512 * 1024;
const ALERT_TITLE = "[claude-memory-backup] Memory backup push is failing";

// project-slug → (filename → content) for every readable memory/*.md file under ~/.claude/projects.
function collectMemories(): Map<string, Map<string, string>> {
  const memories = new Map<string, Map<string, string>>();

  const projectsDir = path.join(os.homedir(), ".claude", "projects");
  if (!fs.existsSync(projectsDir)) return memories;

  const projectEntries = fs.readdirSync(projectsDir, { withFileTypes: true });
  for (const projectEntry of projectEntries) {
    if (!projectEntry.isDirectory()) continue;

    const memDir = path.join(projectsDir, projectEntry.name, "memory");
    if (!fs.existsSync(memDir)) continue;

    let fileEntries;
    try {
      fileEntries = fs.readdirSync(memDir, { withFileTypes: true });
    } catch (err) {
      log.debug(`[${NAME}] Failed to list ${memDir}: ${err}`);
      continue;
    }

    const files = new Map<string, string>();
    for (const fileEntry of fileEntries) {
      if (!fileEntry.name.endsWith(".md")) continue;
      const full = path.join(memDir, fileEntry.name);

      const st = fs.lstatSync(full);
      if (!st.isFile()) continue;
      if (st.size > MAX_FILE_BYTES) {
        log.debug(`[${NAME}] Skipping ${full} — exceeds ${MAX_FILE_BYTES} bytes`);
        continue;
      }

      try {
        files.set(fileEntry.name, fs.readFileSync(full, "utf8"));
      } catch (err) {
        log.debug(`[${NAME}] Failed to read ${full}: ${err}`);
      }
    }

    if (files.size > 0) memories.set(projectEntry.name, files);
  }

  return memories;
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

async function doRun(): Promise<void> {
  const memories = collectMemories();
  if (memories.size === 0) {
    log.debug(`[${NAME}] No memory files found — skipping`);
    return;
  }

  const owner = SELF_REPO.split("/")[0]!;
  const dir = path.join(WORK_DIR, "claude-memory-backup");

  try {
    if (!fs.existsSync(path.join(dir, ".git"))) {
      fs.mkdirSync(dir, { recursive: true });
      await claude.git(["init", "-b", BRANCH], dir);
      await claude.git(["remote", "add", "origin", `https://github.com/${SELF_REPO}.git`], dir);
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

    await claude.git(["add", "-A"], dir);
    const staged = await claude.git(["status", "--porcelain"], dir);
    if (!staged) {
      log.debug(`[${NAME}] No memory changes`);
      await closeAlertIssueIfResolved({ repo: SELF_REPO, title: ALERT_TITLE, logPrefix: NAME, reason: "backup succeeded" });
      return;
    }

    const total = [...memories.values()].reduce((n, m) => n + m.size, 0);
    await claude.git(["commit", "-m", `chore(memories): sync ${total} memory file(s) across ${memories.size} project(s)`], dir);
    await claude.git(["push", "origin", `HEAD:refs/heads/${BRANCH}`], dir, { owner });
    log.info(`[${NAME}] Pushed ${total} memory file(s) to ${SELF_REPO}@${BRANCH}`);
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
