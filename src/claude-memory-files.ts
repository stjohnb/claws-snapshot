import fs from "node:fs";
import path from "node:path";

// Reads Claude's persistent per-project memory files (`<projectsDir>/<slug>/memory/*.md`).
// Shared by the service's `claude-memory-backup` job and the session pod's
// `dump-memories` entry, so it imports only `node:*` — no `config.js`/`log.js`.

/** Files larger than this are skipped. */
export const MAX_MEMORY_FILE_BYTES = 512 * 1024;
/** Once this many bytes have been read, every further file is skipped. */
export const MAX_MEMORY_TOTAL_BYTES = 2 * 1024 * 1024;

export interface CollectedMemoryFiles {
  /** project-slug → (filename → content); a project with no readable files is absent. */
  projects: Map<string, Map<string, string>>;
  /** Files left out by the per-file or total cap, or because they could not be read. */
  skipped: number;
}

/**
 * Every readable memory `*.md` file under `projectsDir`. Only regular files are
 * read (`lstat`, so a symlink is never followed). A project whose `memory/`
 * directory cannot be listed is left out entirely, so a caller replacing its
 * backed-up copy never mistakes an unreadable directory for an empty one.
 * A missing `projectsDir` gives no projects.
 */
export function collectMemoryFiles(
  projectsDir: string,
  opts: { maxFileBytes?: number; maxTotalBytes?: number } = {},
): CollectedMemoryFiles {
  const maxFileBytes = opts.maxFileBytes ?? MAX_MEMORY_FILE_BYTES;
  const maxTotalBytes = opts.maxTotalBytes ?? MAX_MEMORY_TOTAL_BYTES;
  const projects = new Map<string, Map<string, string>>();
  let skipped = 0;
  let total = 0;

  if (!fs.existsSync(projectsDir)) return { projects, skipped };
  let projectEntries: fs.Dirent[];
  try {
    projectEntries = fs.readdirSync(projectsDir, { withFileTypes: true });
  } catch {
    return { projects, skipped };
  }
  projectEntries.sort((a, b) => a.name.localeCompare(b.name));

  for (const projectEntry of projectEntries) {
    if (!projectEntry.isDirectory()) continue;
    const memDir = path.join(projectsDir, projectEntry.name, "memory");
    if (!fs.existsSync(memDir)) continue;

    let fileEntries: fs.Dirent[];
    try {
      fileEntries = fs.readdirSync(memDir, { withFileTypes: true });
    } catch {
      continue;
    }
    fileEntries.sort((a, b) => a.name.localeCompare(b.name));

    const files = new Map<string, string>();
    for (const fileEntry of fileEntries) {
      if (!fileEntry.name.endsWith(".md")) continue;
      const full = path.join(memDir, fileEntry.name);
      try {
        const st = fs.lstatSync(full);
        if (!st.isFile()) continue;
        if (st.size > maxFileBytes || total + st.size > maxTotalBytes) {
          skipped++;
          continue;
        }
        const content = fs.readFileSync(full, "utf8");
        total += Buffer.byteLength(content, "utf8");
        files.set(fileEntry.name, content);
      } catch {
        skipped++;
      }
    }

    if (files.size > 0) projects.set(projectEntry.name, files);
  }

  return { projects, skipped };
}
