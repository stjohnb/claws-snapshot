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
  },
  mockGh: {
    searchIssues: vi.fn(),
    createIssue: vi.fn(),
  },
  mockClaude: {
    ensureClone: vi.fn(),
  },
}));

vi.mock("node:fs", () => ({ default: mockFs }));
vi.mock("../github.js", () => mockGh);
vi.mock("../claude.js", () => mockClaude);

import { run } from "./migration-scanner.js";
import { reportError } from "../error-reporter.js";

describe("migration-scanner", () => {
  const repo = mockRepo();

  beforeEach(() => {
    vi.clearAllMocks();
    mockFs.existsSync.mockReturnValue(false);
    mockFs.readdirSync.mockReturnValue([]);
    mockGh.searchIssues.mockResolvedValue([]);
    mockGh.createIssue.mockResolvedValue(1);
    mockClaude.ensureClone.mockResolvedValue(
      "/home/testuser/.claws/repos/test-org/test-repo",
    );
  });

  it("skips repos without local clone", async () => {
    await run([repo]);

    expect(mockClaude.ensureClone).not.toHaveBeenCalled();
    expect(mockGh.createIssue).not.toHaveBeenCalled();
  });

  it("calls ensureClone before scanning", async () => {
    // repoDir exists
    mockFs.existsSync.mockReturnValue(true);
    // readdirSync for the recursive scan — return empty at each level
    mockFs.readdirSync.mockReturnValue([]);

    await run([repo]);

    expect(mockClaude.ensureClone).toHaveBeenCalledWith(repo, { skipFetchIfRecent: true });
  });

  it("flags directory with incrementally numbered migration files", async () => {
    mockFs.existsSync.mockImplementation((p: string) => {
      if (p.endsWith("test-repo")) return true;
      if (p.endsWith("migrations")) return true;
      return false;
    });

    mockFs.readdirSync.mockImplementation((dirPath: string, opts?: unknown) => {
      // Recursive scan of repo root — return empty for the shallow walk
      if (typeof dirPath === "string" && dirPath.endsWith("test-repo") && opts) {
        return [];
      }
      // Common migration dir check — return migration files
      if (typeof dirPath === "string" && dirPath.endsWith("migrations")) {
        return ["001_create_users.ts", "002_add_email.ts", "003_add_roles.ts"];
      }
      return [];
    });

    await run([repo]);

    expect(mockGh.createIssue).toHaveBeenCalledWith(
      repo.fullName,
      "Alert: migrations using incremental numbering instead of date stamps",
      expect.stringContaining("001_create_users.ts"),
      ["Priority"],
    );
  });

  it("does not flag directory with only timestamp-prefixed files", async () => {
    mockFs.existsSync.mockImplementation((p: string) => {
      if (p.endsWith("test-repo")) return true;
      if (p.endsWith("migrations")) return true;
      return false;
    });

    mockFs.readdirSync.mockImplementation((dirPath: string, opts?: unknown) => {
      if (typeof dirPath === "string" && dirPath.endsWith("test-repo") && opts) {
        return [];
      }
      if (typeof dirPath === "string" && dirPath.endsWith("migrations")) {
        return ["20260321143000_create_users.ts", "20260322100000_add_email.ts"];
      }
      return [];
    });

    await run([repo]);

    expect(mockGh.createIssue).not.toHaveBeenCalled();
  });

  it("does not flag mixed directory where repo has switched to timestamps", async () => {
    mockFs.existsSync.mockImplementation((p: string) => {
      if (p.endsWith("test-repo")) return true;
      if (p.endsWith("migrations")) return true;
      return false;
    });

    mockFs.readdirSync.mockImplementation((dirPath: string, opts?: unknown) => {
      if (typeof dirPath === "string" && dirPath.endsWith("test-repo") && opts) {
        return [];
      }
      if (typeof dirPath === "string" && dirPath.endsWith("migrations")) {
        return [
          "001_create_users.ts",
          "002_add_email.ts",
          "20260321143000_add_orders.ts",
        ];
      }
      return [];
    });

    await run([repo]);

    expect(mockGh.createIssue).not.toHaveBeenCalled();
  });

  it("does not flag directory with only one incremental file", async () => {
    mockFs.existsSync.mockImplementation((p: string) => {
      if (p.endsWith("test-repo")) return true;
      if (p.endsWith("migrations")) return true;
      return false;
    });

    mockFs.readdirSync.mockImplementation((dirPath: string, opts?: unknown) => {
      if (typeof dirPath === "string" && dirPath.endsWith("test-repo") && opts) {
        return [];
      }
      if (typeof dirPath === "string" && dirPath.endsWith("migrations")) {
        return ["001_init.ts"];
      }
      return [];
    });

    await run([repo]);

    expect(mockGh.createIssue).not.toHaveBeenCalled();
  });

  it("ignores non-migration file extensions", async () => {
    mockFs.existsSync.mockImplementation((p: string) => {
      if (p.endsWith("test-repo")) return true;
      if (p.endsWith("migrations")) return true;
      return false;
    });

    mockFs.readdirSync.mockImplementation((dirPath: string, opts?: unknown) => {
      if (typeof dirPath === "string" && dirPath.endsWith("test-repo") && opts) {
        return [];
      }
      if (typeof dirPath === "string" && dirPath.endsWith("migrations")) {
        return ["001_readme.md", "002_config.json", "003_data.csv"];
      }
      return [];
    });

    await run([repo]);

    expect(mockGh.createIssue).not.toHaveBeenCalled();
  });

  it("no violations when repo has no migration directories", async () => {
    mockFs.existsSync.mockImplementation((p: string) => {
      if (p.endsWith("test-repo")) return true;
      return false;
    });

    mockFs.readdirSync.mockImplementation((_dirPath: string, opts?: unknown) => {
      if (opts) return []; // withFileTypes scan returns nothing
      return [];
    });

    await run([repo]);

    expect(mockGh.createIssue).not.toHaveBeenCalled();
  });

  it("issue body contains violation details and recommendations", async () => {
    mockFs.existsSync.mockImplementation((p: string) => {
      if (p.endsWith("test-repo")) return true;
      if (p.endsWith("migrations")) return true;
      return false;
    });

    mockFs.readdirSync.mockImplementation((dirPath: string, opts?: unknown) => {
      if (typeof dirPath === "string" && dirPath.endsWith("test-repo") && opts) {
        return [];
      }
      if (typeof dirPath === "string" && dirPath.endsWith("migrations")) {
        return ["001_create_users.ts", "002_add_email.ts"];
      }
      return [];
    });

    await run([repo]);

    const body = mockGh.createIssue.mock.calls[0]![2] as string;
    expect(body).toContain("YYYYMMDDHHMMSS");
    expect(body).toContain("schema_migrations");
    expect(body).toContain("out-of-order");
    expect(body).toContain("migrations");
  });

  it("skips issue creation when matching open issue already exists", async () => {
    mockFs.existsSync.mockImplementation((p: string) => {
      if (p.endsWith("test-repo")) return true;
      if (p.endsWith("migrations")) return true;
      return false;
    });

    mockFs.readdirSync.mockImplementation((dirPath: string, opts?: unknown) => {
      if (typeof dirPath === "string" && dirPath.endsWith("test-repo") && opts) {
        return [];
      }
      if (typeof dirPath === "string" && dirPath.endsWith("migrations")) {
        return ["001_create_users.ts", "002_add_email.ts"];
      }
      return [];
    });

    mockGh.searchIssues.mockResolvedValue([
      { number: 99, title: "Alert: migrations using incremental numbering instead of date stamps" },
    ]);

    await run([repo]);

    expect(mockGh.createIssue).not.toHaveBeenCalled();
  });

  it("reports errors without crashing the loop", async () => {
    const repo2 = mockRepo({
      name: "test-repo-2",
      fullName: "test-org/test-repo-2",
    });

    mockFs.existsSync.mockImplementation((p: string) => {
      if (p.endsWith("test-repo") || p.endsWith("test-repo-2")) return true;
      if (p.endsWith("migrations")) return true;
      return false;
    });

    mockFs.readdirSync.mockImplementation((dirPath: string, opts?: unknown) => {
      if (typeof dirPath === "string" && (dirPath.endsWith("test-repo") || dirPath.endsWith("test-repo-2")) && opts) {
        return [];
      }
      if (typeof dirPath === "string" && dirPath.endsWith("migrations")) {
        return ["001_create_users.ts", "002_add_email.ts"];
      }
      return [];
    });

    mockGh.searchIssues
      .mockRejectedValueOnce(new Error("API error"))
      .mockResolvedValueOnce([]);

    await run([repo, repo2]);

    expect(reportError).toHaveBeenCalledWith(
      "migration-scanner:process-repo",
      repo.fullName,
      expect.any(Error),
    );
    expect(mockGh.createIssue).toHaveBeenCalledWith(
      repo2.fullName,
      expect.any(String),
      expect.any(String),
      ["Priority"],
    );
  });

  it("discovers migration dirs via recursive scan", async () => {
    mockFs.existsSync.mockImplementation((p: string) => {
      if (p.endsWith("test-repo")) return true;
      return false; // no common dirs exist
    });

    const makeDirent = (name: string, isDir: boolean) => ({
      name,
      isDirectory: () => isDir,
      isFile: () => !isDir,
    });

    mockFs.readdirSync.mockImplementation((dirPath: string, opts?: unknown) => {
      if (!opts) {
        // Reading migration files from the discovered dir
        if (typeof dirPath === "string" && dirPath.endsWith("migrations")) {
          return ["001_create_users.ts", "002_add_email.ts"];
        }
        return [];
      }
      // Recursive scan with withFileTypes
      if (typeof dirPath === "string" && dirPath.endsWith("test-repo")) {
        return [makeDirent("packages", true), makeDirent("README.md", false)];
      }
      if (typeof dirPath === "string" && dirPath.endsWith("packages")) {
        return [makeDirent("api", true)];
      }
      if (typeof dirPath === "string" && dirPath.endsWith("api")) {
        return [makeDirent("migrations", true)];
      }
      return [];
    });

    await run([repo]);

    expect(mockGh.createIssue).toHaveBeenCalledWith(
      repo.fullName,
      expect.any(String),
      expect.stringContaining("001_create_users.ts"),
      ["Priority"],
    );
  });

  it("skips node_modules, .git, and other non-source directories during scan", async () => {
    mockFs.existsSync.mockImplementation((p: string) => {
      if (p.endsWith("test-repo")) return true;
      return false;
    });

    const makeDirent = (name: string, isDir: boolean) => ({
      name,
      isDirectory: () => isDir,
      isFile: () => !isDir,
    });

    mockFs.readdirSync.mockImplementation((dirPath: string, opts?: unknown) => {
      if (!opts) return [];
      // Repo root contains node_modules, .git, and a src dir
      if (typeof dirPath === "string" && dirPath.endsWith("test-repo")) {
        return [
          makeDirent("node_modules", true),
          makeDirent(".git", true),
          makeDirent("vendor", true),
          makeDirent("dist", true),
          makeDirent("src", true),
        ];
      }
      // src should be traversed
      if (typeof dirPath === "string" && dirPath.endsWith("src")) {
        return [makeDirent("utils", true)];
      }
      return [];
    });

    await run([repo]);

    // Verify node_modules, .git, vendor, dist were NOT recursed into
    const readdirCalls = mockFs.readdirSync.mock.calls.map((c: unknown[]) => c[0] as string);
    const withFileTypeCalls = readdirCalls.filter(
      (_p: string, i: number) => mockFs.readdirSync.mock.calls[i]![1],
    );
    expect(withFileTypeCalls.some((p: string) => p.includes("node_modules"))).toBe(false);
    expect(withFileTypeCalls.some((p: string) => p.includes(".git"))).toBe(false);
    expect(withFileTypeCalls.some((p: string) => p.includes("/vendor"))).toBe(false);
    expect(withFileTypeCalls.some((p: string) => p.includes("/dist"))).toBe(false);
    // But src should be traversed
    expect(withFileTypeCalls.some((p: string) => p.endsWith("src"))).toBe(true);
  });

  it("treats 8-digit non-date prefixes as incremental, not timestamps", async () => {
    mockFs.existsSync.mockImplementation((p: string) => {
      if (p.endsWith("test-repo")) return true;
      if (p.endsWith("migrations")) return true;
      return false;
    });

    mockFs.readdirSync.mockImplementation((dirPath: string, opts?: unknown) => {
      if (typeof dirPath === "string" && dirPath.endsWith("test-repo") && opts) {
        return [];
      }
      if (typeof dirPath === "string" && dirPath.endsWith("migrations")) {
        return ["10000001_add_index.sql", "10000002_add_table.sql"];
      }
      return [];
    });

    await run([repo]);

    // 10000001 has month=00 which is invalid — should be treated as incremental
    expect(mockGh.createIssue).toHaveBeenCalledWith(
      repo.fullName,
      expect.any(String),
      expect.stringContaining("10000001_add_index.sql"),
      ["Priority"],
    );
  });

  it("does not flag directory with Unix-timestamp prefixed files", async () => {
    mockFs.existsSync.mockImplementation((p: string) => {
      if (p.endsWith("test-repo")) return true;
      if (p.endsWith("migrations")) return true;
      return false;
    });

    mockFs.readdirSync.mockImplementation((dirPath: string, opts?: unknown) => {
      if (typeof dirPath === "string" && dirPath.endsWith("test-repo") && opts) {
        return [];
      }
      if (typeof dirPath === "string" && dirPath.endsWith("migrations")) {
        return ["1742515200_create_users.sql", "1742601600_add_email.sql"];
      }
      return [];
    });

    await run([repo]);

    // 10-digit Unix timestamps are date-based — should not be flagged
    expect(mockGh.createIssue).not.toHaveBeenCalled();
  });

  it("reports multiple violation directories in one repo", async () => {
    mockFs.existsSync.mockImplementation((p: string) => {
      if (p.endsWith("test-repo")) return true;
      // Only the root "migrations" common dir exists (not db/migrations, src/migrations, etc.)
      if (p.endsWith("test-repo/migrations")) return true;
      return false;
    });

    const makeDirent = (name: string, isDir: boolean) => ({
      name,
      isDirectory: () => isDir,
      isFile: () => !isDir,
    });

    mockFs.readdirSync.mockImplementation((dirPath: string, opts?: unknown) => {
      if (!opts) {
        // Both migration dirs have incremental files
        if (typeof dirPath === "string" && dirPath.endsWith("migrations")) {
          return ["001_create_users.ts", "002_add_email.ts"];
        }
        return [];
      }
      // Recursive scan: repo root has a "packages" dir
      if (typeof dirPath === "string" && dirPath.endsWith("test-repo")) {
        return [makeDirent("packages", true)];
      }
      if (typeof dirPath === "string" && dirPath.endsWith("packages")) {
        return [makeDirent("api", true)];
      }
      if (typeof dirPath === "string" && dirPath.endsWith("api")) {
        return [makeDirent("migrations", true)];
      }
      return [];
    });

    await run([repo]);

    const body = mockGh.createIssue.mock.calls[0]![2] as string;
    // Both the common "migrations" dir and the discovered "packages/api/migrations" should appear
    expect(body).toContain("migrations");
    expect(body).toContain("packages/api/migrations");
    // Table should have two data rows
    const tableRows = body.split("\n").filter((line: string) => line.startsWith("| `"));
    expect(tableRows).toHaveLength(2);
  });

  it("discovers migration dirs at depth 4 (monorepo db/migrations)", async () => {
    mockFs.existsSync.mockImplementation((p: string) => {
      if (p.endsWith("test-repo")) return true;
      return false;
    });

    const makeDirent = (name: string, isDir: boolean) => ({
      name,
      isDirectory: () => isDir,
      isFile: () => !isDir,
    });

    mockFs.readdirSync.mockImplementation((dirPath: string, opts?: unknown) => {
      if (!opts) {
        if (typeof dirPath === "string" && dirPath.endsWith("migrations")) {
          return ["001_init.sql", "002_seed.sql"];
        }
        return [];
      }
      // packages/<name>/db/migrations is at depth 3 for the "migrations" entry
      if (typeof dirPath === "string" && dirPath.endsWith("test-repo")) {
        return [makeDirent("packages", true)];
      }
      if (typeof dirPath === "string" && dirPath.endsWith("packages")) {
        return [makeDirent("backend", true)];
      }
      if (typeof dirPath === "string" && dirPath.endsWith("backend")) {
        return [makeDirent("db", true)];
      }
      if (typeof dirPath === "string" && dirPath.endsWith("db")) {
        return [makeDirent("migrations", true)];
      }
      return [];
    });

    await run([repo]);

    expect(mockGh.createIssue).toHaveBeenCalledWith(
      repo.fullName,
      expect.any(String),
      expect.stringContaining("001_init.sql"),
      ["Priority"],
    );
  });

  it("limits example files to first 5 sorted alphabetically", async () => {
    mockFs.existsSync.mockImplementation((p: string) => {
      if (p.endsWith("test-repo")) return true;
      if (p.endsWith("migrations")) return true;
      return false;
    });

    mockFs.readdirSync.mockImplementation((dirPath: string, opts?: unknown) => {
      if (typeof dirPath === "string" && dirPath.endsWith("test-repo") && opts) {
        return [];
      }
      if (typeof dirPath === "string" && dirPath.endsWith("migrations")) {
        return [
          "007_g.ts", "006_f.ts", "005_e.ts", "004_d.ts",
          "003_c.ts", "002_b.ts", "001_a.ts",
        ];
      }
      return [];
    });

    await run([repo]);

    const body = mockGh.createIssue.mock.calls[0]![2] as string;
    expect(body).toContain("001_a.ts");
    expect(body).toContain("005_e.ts");
    expect(body).not.toContain("006_f.ts");
    expect(body).not.toContain("007_g.ts");
    expect(body).toContain("7");
  });
});
