import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { collectMemoryFiles } from "../claude-memory-files.js";

// Entry point of the one-shot session memory capture pod (`buildMemoryCapturePod`):
// mounts an ended session's HOME read-only, prints its Claude memory files as one
// JSON line on stdout, and exits. Claws reads that line through the pod-log API
// (`src/session-memory-capture.ts`). Runs with no Claws config, database or logger.

/** Version of the line's shape; `parseMemoryDump` in `session-memory-capture.ts` rejects any other. */
export const MEMORY_DUMP_VERSION = 1;

export interface MemoryDump {
  v: typeof MEMORY_DUMP_VERSION;
  /** project-slug → (filename → content). */
  projects: Record<string, Record<string, string>>;
  skipped: number;
}

/** The capture line for `home`, without a trailing newline. A missing `~/.claude/projects` gives empty `projects`. */
export function dumpMemories(home: string): string {
  const { projects, skipped } = collectMemoryFiles(path.join(home, ".claude", "projects"));
  const out: MemoryDump = { v: MEMORY_DUMP_VERSION, projects: {}, skipped };
  for (const [slug, files] of projects) out.projects[slug] = Object.fromEntries(files);
  return JSON.stringify(out);
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
  try {
    process.stdout.write(`${dumpMemories(process.env.HOME || os.homedir())}\n`);
  } catch (err) {
    process.stderr.write(`dump-memories failed: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  }
}
