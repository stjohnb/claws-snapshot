import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { dumpMemories } from "./dump-memories.js";
import { MAX_MEMORY_FILE_BYTES, MAX_MEMORY_TOTAL_BYTES } from "../claude-memory-files.js";

describe("dumpMemories", () => {
  let home: string;
  const memDir = (slug: string) => path.join(home, ".claude", "projects", slug, "memory");

  function write(slug: string, name: string, content: string): void {
    fs.mkdirSync(memDir(slug), { recursive: true });
    fs.writeFileSync(path.join(memDir(slug), name), content);
  }

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "dump-memories-"));
  });

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("emits one JSON line with every project's .md memory files", () => {
    write("-home-claws-work-org-app", "MEMORY.md", "- [a](a.md)\n");
    write("-home-claws-work-org-app", "a.md", "fact \"quoted\"\n");
    write("-home-claws-work-org-app", "notes.txt", "ignored");
    write("-home-claws", "MEMORY.md", "home");

    const line = dumpMemories(home);

    expect(line).not.toContain("\n");
    expect(JSON.parse(line)).toEqual({
      v: 1,
      projects: {
        "-home-claws": { "MEMORY.md": "home" },
        "-home-claws-work-org-app": { "MEMORY.md": "- [a](a.md)\n", "a.md": "fact \"quoted\"\n" },
      },
      skipped: 0,
    });
  });

  it("gives empty projects when ~/.claude/projects is missing", () => {
    expect(JSON.parse(dumpMemories(home))).toEqual({ v: 1, projects: {}, skipped: 0 });
  });

  it("does not follow symlinks", () => {
    write("-p", "real.md", "real");
    fs.symlinkSync(path.join(memDir("-p"), "real.md"), path.join(memDir("-p"), "link.md"));
    expect(JSON.parse(dumpMemories(home)).projects).toEqual({ "-p": { "real.md": "real" } });
  });

  it("skips files over the per-file cap and stops at the total cap, counting what it skipped", () => {
    write("-p", "big.md", "x".repeat(MAX_MEMORY_FILE_BYTES + 1));
    const chunk = "y".repeat(MAX_MEMORY_FILE_BYTES);
    const fitting = Math.floor(MAX_MEMORY_TOTAL_BYTES / MAX_MEMORY_FILE_BYTES);
    for (let i = 0; i < fitting + 2; i++) write("-q", `f${String(i).padStart(2, "0")}.md`, chunk);

    const dump = JSON.parse(dumpMemories(home));

    expect(dump.projects["-p"]).toBeUndefined();
    expect(Object.keys(dump.projects["-q"])).toHaveLength(fitting);
    expect(dump.skipped).toBe(1 + 2);
    expect(Buffer.byteLength(JSON.stringify(dump.projects))).toBeLessThan(4 * 1024 * 1024);
  });
});
