import { describe, it, expect, vi, beforeEach } from "vitest";
import { mockRepo } from "../test-helpers.js";

vi.mock("../config.js", () => ({
  WORK_DIR: "/home/testuser/.claws",
}));

vi.mock("../log.js", () => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock("../error-reporter.js", () => ({
  reportError: vi.fn(),
}));

const { mockFs, mockGh, mockClaude } = vi.hoisted(() => ({
  mockFs: {
    existsSync: vi.fn(),
    readdirSync: vi.fn(),
    readFileSync: vi.fn(),
  },
  mockGh: {
    findIssueByExactTitle: vi.fn(),
    createIssue: vi.fn(),
  },
  mockClaude: {
    ensureClone: vi.fn(),
    repoDir: vi.fn((repo: { owner: string; name: string }) => `/home/testuser/.claws/repos/${repo.owner}/${repo.name}`),
  },
}));

vi.mock("node:fs", () => ({ default: mockFs }));
vi.mock("../github.js", () => mockGh);
vi.mock("../claude.js", () => mockClaude);

import { run } from "./design-guidelines-scanner.js";

const REPO_DIR = "/home/testuser/.claws/repos/test-org/test-repo";
const ISSUE_TITLE = "chore: add frontend design guidelines (docs/DESIGN.md)";

/** Builds an fs fixture from repo-relative path -> file content, wiring existsSync/readdirSync/
 *  readFileSync consistently. The scanner walks recursively, so a bare mockReturnValue won't do. */
function mockTree(files: Record<string, string>): void {
  const dirs = new Map<string, Map<string, boolean>>();
  const ensureDir = (d: string): Map<string, boolean> => {
    let entries = dirs.get(d);
    if (!entries) {
      entries = new Map();
      dirs.set(d, entries);
    }
    return entries;
  };

  ensureDir(REPO_DIR);
  for (const relPath of Object.keys(files)) {
    const parts = relPath.split("/");
    let cur = REPO_DIR;
    for (const part of parts.slice(0, -1)) {
      ensureDir(cur).set(part, true);
      cur = `${cur}/${part}`;
      ensureDir(cur);
    }
    ensureDir(cur).set(parts[parts.length - 1]!, false);
  }

  const filePaths = new Set(Object.keys(files).map((f) => `${REPO_DIR}/${f}`));

  mockFs.readdirSync.mockImplementation((p: string) => {
    const entries = dirs.get(p);
    if (!entries) throw Object.assign(new Error(`ENOENT: ${p}`), { code: "ENOENT" });
    return [...entries].map(([name, isDir]) => ({
      name,
      isDirectory: () => isDir,
      isFile: () => !isDir,
    }));
  });
  mockFs.existsSync.mockImplementation((p: string) => filePaths.has(p) || dirs.has(p));
  mockFs.readFileSync.mockImplementation((p: string) => {
    const rel = p.startsWith(`${REPO_DIR}/`) ? p.slice(REPO_DIR.length + 1) : null;
    const content = rel === null ? undefined : files[rel];
    if (content === undefined) throw Object.assign(new Error(`ENOENT: ${p}`), { code: "ENOENT" });
    return content;
  });
}

describe("design-guidelines-scanner", () => {
  const repo = mockRepo();

  beforeEach(() => {
    vi.clearAllMocks();
    mockGh.findIssueByExactTitle.mockResolvedValue(null);
    mockGh.createIssue.mockResolvedValue(1);
    mockClaude.ensureClone.mockResolvedValue(REPO_DIR);
  });

  it("creates an issue for a React repo with no guidelines", async () => {
    mockTree({
      "package.json": JSON.stringify({ dependencies: { react: "^18.0.0" } }),
      "src/App.tsx": "export const App = () => null;",
    });

    await run([repo]);

    expect(mockGh.createIssue).toHaveBeenCalledWith(
      repo.fullName,
      ISSUE_TITLE,
      expect.stringContaining("react"),
      [],
    );
  });

  it("skips a repo with UI files but an existing docs/DESIGN.md", async () => {
    mockTree({
      "package.json": JSON.stringify({ dependencies: { react: "^18.0.0" } }),
      "src/App.tsx": "export const App = () => null;",
      "src/Button.tsx": "export const Button = () => null;",
      "docs/DESIGN.md": "# Design",
    });

    await run([repo]);

    expect(mockGh.createIssue).not.toHaveBeenCalled();
  });

  it("skips a backend-only repo with sparse UI evidence", async () => {
    mockTree({
      "main.go": "package main",
      "server.go": "package main",
      "docs/coverage.html": "<html></html>",
    });

    await run([repo]);

    expect(mockGh.createIssue).not.toHaveBeenCalled();
  });

  it("skips when CLAUDE.md has a Frontend design section", async () => {
    mockTree({
      "package.json": JSON.stringify({ dependencies: { react: "^18.0.0" } }),
      "src/App.tsx": "export const App = () => null;",
      "CLAUDE.md": "# Claws\n\n## Frontend design\n\nSee docs/DESIGN.md.",
    });

    await run([repo]);

    expect(mockGh.createIssue).not.toHaveBeenCalled();
  });

  it("does not throw on a malformed package.json", async () => {
    mockTree({
      "package.json": "{ not valid json",
      "src/App.tsx": "export const App = () => null;",
      "src/Button.tsx": "export const Button = () => null;",
      "src/Card.tsx": "export const Card = () => null;",
    });

    await expect(run([repo])).resolves.not.toThrow();
    expect(mockGh.createIssue).toHaveBeenCalled();
  });

  it("skips repos without local clone", async () => {
    mockFs.existsSync.mockReturnValue(false);

    await run([repo]);

    expect(mockClaude.ensureClone).not.toHaveBeenCalled();
    expect(mockGh.createIssue).not.toHaveBeenCalled();
  });
});
