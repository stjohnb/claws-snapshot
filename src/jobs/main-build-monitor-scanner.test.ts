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

import { run } from "./main-build-monitor-scanner.js";
import { reportError } from "../error-reporter.js";

const CI_WORKFLOW = [
  "name: CI",
  "on:",
  "  push:",
  "    branches:",
  "      - main",
  "jobs:",
  "  build:",
  "    runs-on: self-hosted",
].join("\n");

const NOTIFY_WORKFLOW = [
  "name: Notify on main build failure",
  "on:",
  "  workflow_run:",
  "    workflows: [\"CI\"]",
  "    types: [completed]",
  "jobs:",
  "  notify:",
  "    runs-on: self-hosted",
  "    if: github.event.workflow_run.conclusion == 'failure'",
  "    steps:",
  "      - run: gh issue create --title 'Build failure'",
].join("\n");

describe("main-build-monitor-scanner", () => {
  const repo = mockRepo();

  beforeEach(() => {
    vi.clearAllMocks();
    mockFs.existsSync.mockReturnValue(true);
    mockFs.readdirSync.mockReturnValue([]);
    mockGh.searchIssues.mockResolvedValue([]);
    mockGh.createIssue.mockResolvedValue(1);
    mockClaude.ensureClone.mockResolvedValue(
      "/home/testuser/.claws/repos/test-org/test-repo",
    );
  });

  it("skips repos without local clone", async () => {
    mockFs.existsSync.mockReturnValue(false);

    await run([repo]);

    expect(mockClaude.ensureClone).not.toHaveBeenCalled();
    expect(mockGh.createIssue).not.toHaveBeenCalled();
  });

  it("skips repos without a workflows directory", async () => {
    mockFs.existsSync
      .mockReturnValueOnce(true) // repoDir
      .mockReturnValueOnce(false); // workflowsDir

    await run([repo]);

    expect(mockFs.readdirSync).not.toHaveBeenCalled();
    expect(mockGh.createIssue).not.toHaveBeenCalled();
  });

  it("skips repos with no main-branch-push workflows", async () => {
    mockFs.readdirSync.mockReturnValue(["manual.yml", "release.yml"]);
    mockFs.readFileSync.mockImplementation((filePath: string) => {
      if (String(filePath).includes("manual")) {
        return "name: Manual\non: workflow_dispatch\njobs:\n  build:\n    runs-on: self-hosted\n";
      }
      return "name: Release\non:\n  push:\n    tags:\n      - 'v*'\njobs:\n  release:\n    runs-on: self-hosted\n";
    });

    await run([repo]);

    expect(mockGh.createIssue).not.toHaveBeenCalled();
  });

  it("files an issue listing all main-build workflows when no monitor workflow exists", async () => {
    mockFs.readdirSync.mockReturnValue(["ci.yml"]);
    mockFs.readFileSync.mockReturnValue(CI_WORKFLOW);

    await run([repo]);

    expect(mockGh.createIssue).toHaveBeenCalledWith(
      repo.fullName,
      "Alert: main-branch builds not monitored for failure",
      expect.stringContaining("CI"),
      ["Priority"],
    );
    const body = mockGh.createIssue.mock.calls[0]![2] as string;
    expect(body).toContain("notify-failures.yml");
    expect(body).toContain("No failure-monitoring workflow was found");
  });

  it("files an issue listing only unmonitored workflows when partial monitor exists", async () => {
    mockFs.readdirSync.mockReturnValue(["ci.yml", "deploy.yml", "notify-failures.yml"]);
    mockFs.readFileSync.mockImplementation((filePath: string) => {
      if (String(filePath).includes("notify-failures")) {
        return [
          "name: Notify on main build failure",
          "on:",
          "  workflow_run:",
          '    workflows: ["CI"]',
          "    types: [completed]",
          "jobs:",
          "  notify:",
          "    runs-on: self-hosted",
          "    steps:",
          "      - run: gh issue create --title 'failure'",
        ].join("\n");
      }
      if (String(filePath).includes("deploy")) {
        return [
          "name: Deploy",
          "on:",
          "  push:",
          "    branches:",
          "      - main",
          "jobs:",
          "  deploy:",
          "    runs-on: self-hosted",
        ].join("\n");
      }
      return CI_WORKFLOW;
    });

    await run([repo]);

    expect(mockGh.createIssue).toHaveBeenCalledWith(
      repo.fullName,
      "Alert: main-branch builds not monitored for failure",
      expect.stringContaining("Deploy"),
      ["Priority"],
    );
    const body = mockGh.createIssue.mock.calls[0]![2] as string;
    expect(body).toContain("Extend its");
    expect(body).not.toContain("No failure-monitoring workflow was found");
  });

  it("does not file an issue when every main-build workflow is covered", async () => {
    mockFs.readdirSync.mockReturnValue(["ci.yml", "notify-failures.yml"]);
    mockFs.readFileSync.mockImplementation((filePath: string) => {
      if (String(filePath).includes("notify-failures")) return NOTIFY_WORKFLOW;
      return CI_WORKFLOW;
    });

    await run([repo]);

    expect(mockGh.createIssue).not.toHaveBeenCalled();
  });

  it("skips when an existing open alert issue is found", async () => {
    mockFs.readdirSync.mockReturnValue(["ci.yml"]);
    mockFs.readFileSync.mockReturnValue(CI_WORKFLOW);
    mockGh.searchIssues.mockResolvedValue([
      { number: 99, title: "Alert: main-branch builds not monitored for failure" },
    ]);

    await run([repo]);

    expect(mockGh.createIssue).not.toHaveBeenCalled();
  });

  it("recognizes inline 'on: push' as a main-build trigger", async () => {
    mockFs.readdirSync.mockReturnValue(["ci.yml"]);
    mockFs.readFileSync.mockReturnValue("name: CI\non: push\njobs:\n  build:\n    runs-on: self-hosted\n");

    await run([repo]);

    expect(mockGh.createIssue).toHaveBeenCalled();
  });

  it("recognizes inline 'on: [push]' as a main-build trigger", async () => {
    mockFs.readdirSync.mockReturnValue(["ci.yml"]);
    mockFs.readFileSync.mockReturnValue("name: CI\non: [push, pull_request]\njobs:\n  build:\n    runs-on: self-hosted\n");

    await run([repo]);

    expect(mockGh.createIssue).toHaveBeenCalled();
  });

  it("recognizes on.push.branches: [main] (inline) as a main-build trigger", async () => {
    mockFs.readdirSync.mockReturnValue(["ci.yml"]);
    mockFs.readFileSync.mockReturnValue(
      ["name: CI", "on:", "  push:", "    branches: [main]", "jobs:", "  build:", "    runs-on: self-hosted"].join("\n"),
    );

    await run([repo]);

    expect(mockGh.createIssue).toHaveBeenCalled();
  });

  it("recognizes on.push.branches block form with main as a main-build trigger", async () => {
    mockFs.readdirSync.mockReturnValue(["ci.yml"]);
    mockFs.readFileSync.mockReturnValue(CI_WORKFLOW);

    await run([repo]);

    expect(mockGh.createIssue).toHaveBeenCalled();
  });

  it("detects main-build trigger when branches-ignore does not exclude main", async () => {
    mockFs.readdirSync.mockReturnValue(["ci.yml"]);
    mockFs.readFileSync.mockReturnValue(
      ["name: CI", "on:", "  push:", "    branches-ignore:", "      - develop", "jobs:", "  build:", "    runs-on: self-hosted"].join("\n"),
    );
    await run([repo]);
    expect(mockGh.createIssue).toHaveBeenCalled();
  });

  it("does not detect main-build trigger when branches-ignore excludes main", async () => {
    mockFs.readdirSync.mockReturnValue(["ci.yml"]);
    mockFs.readFileSync.mockReturnValue(
      ["name: CI", "on:", "  push:", "    branches-ignore:", "      - main", "jobs:", "  build:", "    runs-on: self-hosted"].join("\n"),
    );
    await run([repo]);
    expect(mockGh.createIssue).not.toHaveBeenCalled();
  });

  it("does not recognize pull_request-only workflow as a main-build trigger", async () => {
    mockFs.readdirSync.mockReturnValue(["ci.yml"]);
    mockFs.readFileSync.mockReturnValue(
      "name: CI\non:\n  pull_request:\njobs:\n  build:\n    runs-on: self-hosted\n",
    );

    await run([repo]);

    expect(mockGh.createIssue).not.toHaveBeenCalled();
  });

  it("recognizes a scheduled workflow as a main-build trigger", async () => {
    mockFs.readdirSync.mockReturnValue(["cleanup.yml"]);
    mockFs.readFileSync.mockReturnValue(
      [
        "name: Cleanup test data",
        "on:",
        "  schedule:",
        '    - cron: "0 4 * * *"',
        "  workflow_dispatch:",
        "jobs:",
        "  cleanup:",
        "    runs-on: [self-hosted, linux]",
      ].join("\n"),
    );

    await run([repo]);

    expect(mockGh.createIssue).toHaveBeenCalledOnce();
    const body = mockGh.createIssue.mock.calls[0]![2] as string;
    expect(body).toContain("Cleanup test data");
  });

  it("does not file an issue when a scheduled workflow is covered by a monitor", async () => {
    mockFs.readdirSync.mockReturnValue(["cleanup.yml", "notify-failures.yml"]);
    mockFs.readFileSync.mockImplementation((filePath: string) => {
      if (String(filePath).includes("notify-failures")) {
        return [
          "name: Notify on main build failure",
          "on:",
          "  workflow_run:",
          '    workflows: ["Cleanup test data"]',
          "    types: [completed]",
          "jobs:",
          "  notify:",
          "    runs-on: self-hosted",
          "    if: github.event.workflow_run.conclusion == 'failure'",
          "    steps:",
          "      - run: gh issue create --title 'Build failure'",
        ].join("\n");
      }
      return [
        "name: Cleanup test data",
        "on:",
        "  schedule:",
        '    - cron: "0 4 * * *"',
        "  workflow_dispatch:",
        "jobs:",
        "  cleanup:",
        "    runs-on: [self-hosted, linux]",
      ].join("\n");
    });

    await run([repo]);

    expect(mockGh.createIssue).not.toHaveBeenCalled();
  });

  it("does not recognize workflow_dispatch-only workflow as a main-build trigger", async () => {
    mockFs.readdirSync.mockReturnValue(["ci.yml"]);
    mockFs.readFileSync.mockReturnValue(
      "name: CI\non: workflow_dispatch\njobs:\n  build:\n    runs-on: self-hosted\n",
    );

    await run([repo]);

    expect(mockGh.createIssue).not.toHaveBeenCalled();
  });

  it("recognizes workflow_run with inline workflows list as a monitor", async () => {
    mockFs.readdirSync.mockReturnValue(["ci.yml", "notify.yml"]);
    mockFs.readFileSync.mockImplementation((filePath: string) => {
      if (String(filePath).includes("notify")) return NOTIFY_WORKFLOW;
      return CI_WORKFLOW;
    });

    await run([repo]);

    expect(mockGh.createIssue).not.toHaveBeenCalled();
  });

  it("recognizes workflow_run with block-form workflows list as a monitor", async () => {
    mockFs.readdirSync.mockReturnValue(["ci.yml", "notify.yml"]);
    mockFs.readFileSync.mockImplementation((filePath: string) => {
      if (String(filePath).includes("notify")) {
        return [
          "name: Notify on main build failure",
          "on:",
          "  workflow_run:",
          "    workflows:",
          "      - CI",
          "    types: [completed]",
          "jobs:",
          "  notify:",
          "    runs-on: self-hosted",
          "    steps:",
          "      - run: gh issue create --title 'Build failure' && failure",
        ].join("\n");
      }
      return CI_WORKFLOW;
    });

    await run([repo]);

    expect(mockGh.createIssue).not.toHaveBeenCalled();
  });

  it("does not count a workflow_run workflow that lacks gh issue create", async () => {
    mockFs.readdirSync.mockReturnValue(["ci.yml", "deploy-trigger.yml"]);
    mockFs.readFileSync.mockImplementation((filePath: string) => {
      if (String(filePath).includes("deploy-trigger")) {
        return [
          "name: Deploy trigger",
          "on:",
          "  workflow_run:",
          '    workflows: ["CI"]',
          "    types: [completed]",
          "jobs:",
          "  deploy:",
          "    runs-on: self-hosted",
          "    steps:",
          "      - run: echo deploying",
        ].join("\n");
      }
      return CI_WORKFLOW;
    });

    await run([repo]);

    // No gh issue create in deploy-trigger → it's not a monitor workflow → issue filed
    expect(mockGh.createIssue).toHaveBeenCalledWith(
      repo.fullName,
      "Alert: main-branch builds not monitored for failure",
      expect.any(String),
      ["Priority"],
    );
  });

  it("calls reportError and continues to next repo on per-repo failure", async () => {
    const repo2 = mockRepo({ name: "test-repo-2", fullName: "test-org/test-repo-2" });

    mockFs.readdirSync.mockReturnValue(["ci.yml"]);
    mockFs.readFileSync.mockReturnValue(CI_WORKFLOW);
    mockGh.searchIssues
      .mockRejectedValueOnce(new Error("API error"))
      .mockResolvedValueOnce([]);

    await run([repo, repo2]);

    expect(reportError).toHaveBeenCalledWith(
      "main-build-monitor-scanner:process-repo",
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
});
