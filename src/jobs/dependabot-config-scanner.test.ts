import { describe, it, expect, vi, beforeEach } from "vitest";
import { mockRepo } from "../test-helpers.js";

vi.mock("../config.js", () => ({
  WORK_DIR: "/home/testuser/.claws",
  LABELS: { priority: "Priority" },
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

import { run, detectEcosystems, normalizeDir, parseCoverage, renderUpdateEntries } from "./dependabot-config-scanner.js";
import * as log from "../log.js";

const REPO_DIR = "/home/testuser/.claws/repos/test-org/test-repo";

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

  const filePaths = new Set(Object.keys(files).map(f => `${REPO_DIR}/${f}`));

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

/** bonkus's real shape: root npm workspace + a separate npm project at apps/mobile with its own
 *  lockfile, workspace members without lockfiles, pip, docker and workflows. */
const BONKUS_TREE: Record<string, string> = {
  "package.json": '{"workspaces":["packages/*"]}',
  "package-lock.json": "{}",
  "apps/mobile/package.json": "{}",
  "apps/mobile/package-lock.json": "{}",
  "packages/game-client/package.json": "{}",
  "packages/game-core/package.json": "{}",
  "training/requirements.txt": "flask==2.0.0\n",
  "Dockerfile": "FROM node:20\n",
  "Dockerfile.migrate": "FROM node:20\n",
  ".github/workflows/ci.yml": "name: ci\n",
};

function toObject(map: Map<string, Set<string>>): Record<string, string[]> {
  return Object.fromEntries([...map].map(([k, v]) => [k, [...v].sort()]));
}

describe("dependabot-config-scanner", () => {
  const repo = mockRepo();

  beforeEach(() => {
    vi.clearAllMocks();
    mockGh.findIssueByExactTitle.mockResolvedValue(null);
    mockGh.createIssue.mockResolvedValue(1);
    mockClaude.ensureClone.mockResolvedValue(REPO_DIR);
  });

  describe("normalizeDir", () => {
    it("collapses every root spelling to /", () => {
      for (const input of ["", ".", "./", "/", "//"]) expect(normalizeDir(input)).toBe("/");
    });

    it("adds a leading slash and strips trailing slashes and ./ prefixes", () => {
      expect(normalizeDir("apps/mobile")).toBe("/apps/mobile");
      expect(normalizeDir("./apps/mobile/")).toBe("/apps/mobile");
      expect(normalizeDir(" /apps/mobile ")).toBe("/apps/mobile");
    });
  });

  describe("detectEcosystems", () => {
    it("anchors npm on lockfiles, dropping workspace members covered by the root", () => {
      mockTree(BONKUS_TREE);

      expect(toObject(detectEcosystems(REPO_DIR))).toEqual({
        npm: ["/", "/apps/mobile"],
        pip: ["/training"],
        docker: ["/"],
        "github-actions": ["/"],
      });
    });

    it("registers github-actions at / rather than /.github/workflows", () => {
      mockTree({ ".github/workflows/ci.yml": "name: ci\n" });

      expect(toObject(detectEcosystems(REPO_DIR))).toEqual({ "github-actions": ["/"] });
    });

    it("ignores manifests inside node_modules", () => {
      mockTree({ "node_modules/left-pad/package.json": "{}" });

      expect(detectEcosystems(REPO_DIR).size).toBe(0);
    });

    it("collapses multiple manifests of one ecosystem in a directory", () => {
      mockTree({ "Dockerfile": "", "Dockerfile.migrate": "" });

      expect(toObject(detectEcosystems(REPO_DIR))).toEqual({ docker: ["/"] });
    });

    it("keeps a nested npm project that owns a lockfile", () => {
      mockTree({
        "package.json": "{}",
        "package-lock.json": "{}",
        "sub/package.json": "{}",
        "sub/pnpm-lock.yaml": "",
      });

      expect(toObject(detectEcosystems(REPO_DIR)).npm).toEqual(["/", "/sub"]);
    });
  });

  describe("parseCoverage", () => {
    it("returns null when the document is not a readable dependabot config", () => {
      expect(parseCoverage("updates:\n  - [unclosed")).toBeNull();
      expect(parseCoverage("version: 2\nupdates: nope")).toBeNull();
    });

    it("treats an entry using directories: as covering the ecosystem everywhere", () => {
      const coverage = parseCoverage('version: 2\nupdates:\n  - package-ecosystem: npm\n    directories: ["/apps/*"]\n');

      expect(coverage!.get("npm")!.glob).toBe(true);
    });

    it("normalizes parsed directories", () => {
      const coverage = parseCoverage("version: 2\nupdates:\n  - package-ecosystem: npm\n    directory: apps/mobile/\n");

      expect([...coverage!.get("npm")!.dirs]).toEqual(["/apps/mobile"]);
    });
  });

  describe("renderUpdateEntries", () => {
    it("emits valid, sorted entries with root first", () => {
      const yaml = renderUpdateEntries(new Map([["npm", new Set(["/apps/mobile", "/"])]]));

      expect(yaml.indexOf("directory: /\n")).toBeLessThan(yaml.indexOf("directory: /apps/mobile"));
      expect(yaml).toContain("interval: weekly");
      expect(yaml).toContain("open-pull-requests-limit: 5");
      expect(yaml).toContain("all-dependencies:");
    });
  });

  describe("scan", () => {
    it("skips repos without a local clone", async () => {
      mockFs.existsSync.mockReturnValue(false);

      await run([repo]);

      expect(mockClaude.ensureClone).not.toHaveBeenCalled();
      expect(mockGh.createIssue).not.toHaveBeenCalled();
    });

    it("files no issue for a repo with no dependency manifests", async () => {
      mockTree({ "README.md": "# hi\n" });

      await run([repo]);

      expect(mockGh.createIssue).not.toHaveBeenCalled();
    });

    it("files an issue listing every detected pair when no mechanism exists", async () => {
      mockTree(BONKUS_TREE);

      await run([repo]);

      expect(mockGh.createIssue).toHaveBeenCalledTimes(1);
      const [fullName, title, body, labels] = mockGh.createIssue.mock.calls[0]!;
      expect(fullName).toBe(repo.fullName);
      expect(title).toBe("Alert: missing dependency-update configuration");
      expect(labels).toEqual(["Priority"]);
      expect(body).toContain("directory: /apps/mobile");
      expect(body).toContain("package-ecosystem: pip");
      expect(body).toContain("directory: /training");
      expect(body).toContain("package-ecosystem: docker");
      expect(body).toContain("package-ecosystem: github-actions");
      expect(body).not.toContain("/packages/game-core");
      expect(body).not.toContain("/packages/game-client");
    });

    it("reports a directory the existing config misses, even when its ecosystem is covered elsewhere", async () => {
      mockTree({
        ...BONKUS_TREE,
        ".github/dependabot.yml": "version: 2\nupdates:\n  - package-ecosystem: npm\n    directory: /\n",
      });

      await run([repo]);

      expect(mockGh.createIssue).toHaveBeenCalledTimes(1);
      const body = mockGh.createIssue.mock.calls[0]![2] as string;
      expect(body).toContain("`npm` at `/apps/mobile`");
      expect(body).toContain("without altering the existing entries");
      // npm at / is already covered — only the uncovered directory may be re-emitted.
      expect(body.match(/ {2}- package-ecosystem: npm\n {4}directory: \S+/g)).toEqual([
        "  - package-ecosystem: npm\n    directory: /apps/mobile",
      ]);
    });

    it("treats an ecosystem covered by a directories glob as fully covered", async () => {
      mockTree({
        "apps/mobile/package.json": "{}",
        "apps/mobile/package-lock.json": "{}",
        ".github/dependabot.yml": 'version: 2\nupdates:\n  - package-ecosystem: npm\n    directories: ["/apps/*"]\n',
      });

      await run([repo]);

      expect(mockGh.createIssue).not.toHaveBeenCalled();
    });

    it("files no issue when the existing config covers every pair", async () => {
      mockTree({
        ...BONKUS_TREE,
        ".github/dependabot.yml": [
          "version: 2",
          "updates:",
          "  - package-ecosystem: npm",
          "    directory: /",
          "  - package-ecosystem: npm",
          "    directory: /apps/mobile",
          "  - package-ecosystem: pip",
          "    directory: /training",
          "  - package-ecosystem: docker",
          "    directory: /",
          "  - package-ecosystem: github-actions",
          "    directory: /",
          "",
        ].join("\n"),
      });

      await run([repo]);

      expect(mockGh.createIssue).not.toHaveBeenCalled();
    });

    it("leaves repos using Renovate alone", async () => {
      mockTree({ ...BONKUS_TREE, "renovate.json": "{}" });

      await run([repo]);

      expect(mockGh.createIssue).not.toHaveBeenCalled();
    });

    it("respects the committed opt-out marker", async () => {
      mockTree({ ...BONKUS_TREE, ".claws/dependency-updates-optout": "" });

      await run([repo]);

      expect(mockGh.createIssue).not.toHaveBeenCalled();
    });

    it("warns instead of filing an alert when dependabot.yml cannot be parsed", async () => {
      mockTree({ ...BONKUS_TREE, ".github/dependabot.yml": "updates:\n  - [unclosed" });

      await run([repo]);

      expect(mockGh.createIssue).not.toHaveBeenCalled();
      expect(vi.mocked(log.warn)).toHaveBeenCalledWith(
        expect.stringContaining("unparseable .github/dependabot.yml"),
      );
    });

    it("skips issue creation when a matching open issue already exists", async () => {
      mockTree(BONKUS_TREE);
      mockGh.findIssueByExactTitle.mockResolvedValue({ number: 42, title: "Alert: missing dependency-update configuration" });

      await run([repo]);

      expect(mockGh.createIssue).not.toHaveBeenCalled();
    });
  });
});
