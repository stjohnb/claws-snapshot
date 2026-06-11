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

import { run } from "./concurrency-scanner.js";
import { reportError } from "../error-reporter.js";

describe("concurrency-scanner", () => {
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

  it("skips workflow_dispatch-only workflows", async () => {
    mockFs.readdirSync.mockReturnValue(["manual.yml"]);
    mockFs.readFileSync.mockReturnValue(
      "on: workflow_dispatch\njobs:\n  build:\n    runs-on: self-hosted\n",
    );

    await run([repo]);

    expect(mockGh.createIssue).not.toHaveBeenCalled();
  });

  it("detects missing top-level concurrency group", async () => {
    mockFs.readdirSync.mockReturnValue(["ci.yml"]);
    mockFs.readFileSync.mockReturnValue(
      "on:\n  push:\njobs:\n  build:\n    runs-on: self-hosted\n",
    );

    await run([repo]);

    expect(mockGh.createIssue).toHaveBeenCalledWith(
      repo.fullName,
      "Alert: workflow concurrency misconfiguration",
      expect.stringContaining("Missing concurrency group"),
      ["Priority"],
    );
  });

  it("does not flag missing concurrency for workflow_run-only triggers", async () => {
    mockFs.readdirSync.mockReturnValue(["notify-failures.yml"]);
    mockFs.readFileSync.mockReturnValue(
      "on:\n  workflow_run:\n    workflows: [\"CI\"]\n    types: [completed]\njobs:\n  notify:\n    runs-on: self-hosted\n",
    );

    await run([repo]);

    expect(mockGh.createIssue).not.toHaveBeenCalled();
  });

  it("does not flag missing concurrency for schedule-only triggers", async () => {
    mockFs.readdirSync.mockReturnValue(["nightly.yml"]);
    mockFs.readFileSync.mockReturnValue(
      "on:\n  schedule:\n    - cron: '0 6 * * *'\njobs:\n  job:\n    runs-on: self-hosted\n",
    );

    await run([repo]);

    expect(mockGh.createIssue).not.toHaveBeenCalled();
  });

  it("does not flag missing concurrency for push restricted to main", async () => {
    mockFs.readdirSync.mockReturnValue(["release.yml"]);
    mockFs.readFileSync.mockReturnValue(
      "on:\n  push:\n    branches: [main]\njobs:\n  release:\n    runs-on: self-hosted\n",
    );

    await run([repo]);

    expect(mockGh.createIssue).not.toHaveBeenCalled();
  });

  it("does not flag missing concurrency for push restricted to main/master block list", async () => {
    mockFs.readdirSync.mockReturnValue(["release.yml"]);
    mockFs.readFileSync.mockReturnValue(
      [
        "on:",
        "  push:",
        "    branches:",
        "      - main",
        "      - master",
        "jobs:",
        "  build:",
        "    runs-on: self-hosted",
      ].join("\n"),
    );

    await run([repo]);

    expect(mockGh.createIssue).not.toHaveBeenCalled();
  });

  it("does not flag missing concurrency for tag-only push", async () => {
    mockFs.readdirSync.mockReturnValue(["publish.yml"]);
    mockFs.readFileSync.mockReturnValue(
      "on:\n  push:\n    tags: ['v*']\njobs:\n  publish:\n    runs-on: self-hosted\n",
    );

    await run([repo]);

    expect(mockGh.createIssue).not.toHaveBeenCalled();
  });

  it("flags missing concurrency for bare push (all branches)", async () => {
    mockFs.readdirSync.mockReturnValue(["build.yml"]);
    mockFs.readFileSync.mockReturnValue(
      "on:\n  push:\njobs:\n  build:\n    runs-on: self-hosted\n",
    );

    await run([repo]);

    expect(mockGh.createIssue).toHaveBeenCalledWith(
      repo.fullName,
      "Alert: workflow concurrency misconfiguration",
      expect.stringContaining("Missing concurrency group"),
      ["Priority"],
    );
  });

  it("flags missing concurrency for push with non-default branch list", async () => {
    mockFs.readdirSync.mockReturnValue(["ci.yml"]);
    mockFs.readFileSync.mockReturnValue(
      "on:\n  push:\n    branches: [main, develop]\njobs:\n  build:\n    runs-on: self-hosted\n",
    );

    await run([repo]);

    expect(mockGh.createIssue).toHaveBeenCalledWith(
      repo.fullName,
      "Alert: workflow concurrency misconfiguration",
      expect.stringContaining("Missing concurrency group"),
      ["Priority"],
    );
  });

  it("flags missing concurrency for push with wildcard branches", async () => {
    mockFs.readdirSync.mockReturnValue(["ci.yml"]);
    mockFs.readFileSync.mockReturnValue(
      "on:\n  push:\n    branches: ['feature/*']\njobs:\n  build:\n    runs-on: self-hosted\n",
    );

    await run([repo]);

    expect(mockGh.createIssue).toHaveBeenCalledWith(
      repo.fullName,
      "Alert: workflow concurrency misconfiguration",
      expect.stringContaining("Missing concurrency group"),
      ["Priority"],
    );
  });

  it("flags missing concurrency for pull_request triggers", async () => {
    mockFs.readdirSync.mockReturnValue(["ci.yml"]);
    mockFs.readFileSync.mockReturnValue(
      "on:\n  pull_request:\njobs:\n  build:\n    runs-on: self-hosted\n",
    );

    await run([repo]);

    expect(mockGh.createIssue).toHaveBeenCalledWith(
      repo.fullName,
      "Alert: workflow concurrency misconfiguration",
      expect.stringContaining("Missing concurrency group"),
      ["Priority"],
    );
  });

  it("does not flag missing concurrency for release-only triggers", async () => {
    mockFs.readdirSync.mockReturnValue(["publish.yml"]);
    mockFs.readFileSync.mockReturnValue(
      "on:\n  release:\n    types: [published]\njobs:\n  publish:\n    runs-on: self-hosted\n",
    );

    await run([repo]);

    expect(mockGh.createIssue).not.toHaveBeenCalled();
  });

  it("detects static job-level concurrency groups", async () => {
    mockFs.readdirSync.mockReturnValue(["ci.yml"]);
    mockFs.readFileSync.mockReturnValue(
      [
        "on:",
        "  push:",
        "concurrency:",
        "  group: ci-${{ github.ref }}",
        "  cancel-in-progress: true",
        "jobs:",
        "  build:",
        "    concurrency:",
        "      group: static-group",
        "      cancel-in-progress: true",
        "    runs-on: self-hosted",
      ].join("\n"),
    );

    await run([repo]);

    const body = mockGh.createIssue.mock.calls[0]![2] as string;
    expect(body).toContain("Shared global group");
    expect(body).toContain("static-group");
  });

  it("does not flag static job-level concurrency with cancel-in-progress: false", async () => {
    mockFs.readdirSync.mockReturnValue(["ci.yml"]);
    mockFs.readFileSync.mockReturnValue(
      [
        "on:",
        "  push:",
        "concurrency:",
        "  group: ci-${{ github.ref }}",
        "  cancel-in-progress: true",
        "jobs:",
        "  prod:",
        "    concurrency:",
        "      group: prod-job",
        "      cancel-in-progress: false",
        "    runs-on: self-hosted",
      ].join("\n"),
    );

    await run([repo]);

    expect(mockGh.createIssue).not.toHaveBeenCalled();
  });

  it("does not flag missing top-level concurrency when a job has a dynamic concurrency group", async () => {
    mockFs.readdirSync.mockReturnValue(["cypress-tests.yml"]);
    mockFs.readFileSync.mockReturnValue(
      [
        "on:",
        "  deployment_status:",
        "  schedule:",
        "    - cron: '0 7 * * *'",
        "jobs:",
        "  resolve-branch:",
        "    runs-on: self-hosted",
        "  cypress-preview:",
        "    needs: resolve-branch",
        "    concurrency:",
        "      group: cypress-preview-${{ needs.resolve-branch.outputs.branch }}",
        "      cancel-in-progress: true",
        "    runs-on: self-hosted",
        "  cypress-prod:",
        "    concurrency:",
        "      group: cypress-prod",
        "      cancel-in-progress: false",
        "    runs-on: self-hosted",
      ].join("\n"),
    );

    await run([repo]);

    expect(mockGh.createIssue).not.toHaveBeenCalled();
  });

  it("flags missing concurrency when no jobs have dynamic concurrency groups", async () => {
    mockFs.readdirSync.mockReturnValue(["ci.yml"]);
    mockFs.readFileSync.mockReturnValue(
      [
        "on:",
        "  push:",
        "jobs:",
        "  prod:",
        "    concurrency:",
        "      group: prod-job",
        "      cancel-in-progress: false",
        "    runs-on: self-hosted",
      ].join("\n"),
    );

    await run([repo]);

    expect(mockGh.createIssue).toHaveBeenCalledWith(
      repo.fullName,
      "Alert: workflow concurrency misconfiguration",
      expect.stringContaining("Missing concurrency group"),
      ["Priority"],
    );
  });

  it("detects deployment_status workflows using github.ref in top-level concurrency group", async () => {
    mockFs.readdirSync.mockReturnValue(["cypress-tests.yml"]);
    mockFs.readFileSync.mockReturnValue(
      [
        "on:",
        "  deployment_status:",
        "concurrency:",
        "  group: cypress-tests-${{ github.ref }}",
        "  cancel-in-progress: true",
        "jobs:",
        "  test:",
        "    runs-on: self-hosted",
      ].join("\n"),
    );

    await run([repo]);

    const body = mockGh.createIssue.mock.calls[0]![2] as string;
    expect(body).toContain("deployment_status uses github.ref");
    expect(body).toContain("github.event.deployment.ref");
  });

  it("detects deployment_status workflows using github.ref in job-level concurrency group", async () => {
    mockFs.readdirSync.mockReturnValue(["cypress-tests.yml"]);
    mockFs.readFileSync.mockReturnValue(
      [
        "on:",
        "  deployment_status:",
        "concurrency:",
        "  group: top-level-${{ github.event.deployment.ref }}",
        "  cancel-in-progress: true",
        "jobs:",
        "  test:",
        "    concurrency:",
        "      group: cypress-${{ github.ref }}",
        "      cancel-in-progress: true",
        "    runs-on: self-hosted",
      ].join("\n"),
    );

    await run([repo]);

    const body = mockGh.createIssue.mock.calls[0]![2] as string;
    expect(body).toContain("deployment_status uses github.ref");
    expect(body).toContain("Job `test`");
  });

  it("does not flag deployment_status workflows using github.event.deployment.ref", async () => {
    mockFs.readdirSync.mockReturnValue(["cypress-tests.yml"]);
    mockFs.readFileSync.mockReturnValue(
      [
        "on:",
        "  deployment_status:",
        "concurrency:",
        "  group: cypress-tests-${{ github.event.deployment.ref }}",
        "  cancel-in-progress: true",
        "jobs:",
        "  test:",
        "    runs-on: self-hosted",
      ].join("\n"),
    );

    await run([repo]);

    expect(mockGh.createIssue).not.toHaveBeenCalled();
  });

  it("does not flag pull_request workflows using github.ref", async () => {
    mockFs.readdirSync.mockReturnValue(["ci.yml"]);
    mockFs.readFileSync.mockReturnValue(
      [
        "on:",
        "  pull_request:",
        "concurrency:",
        "  group: ci-${{ github.ref }}",
        "  cancel-in-progress: true",
        "jobs:",
        "  build:",
        "    runs-on: self-hosted",
      ].join("\n"),
    );

    await run([repo]);

    expect(mockGh.createIssue).not.toHaveBeenCalled();
  });

  it("does not flag deployment_status with fallback pattern using github.event.deployment", async () => {
    mockFs.readdirSync.mockReturnValue(["cypress-tests.yml"]);
    mockFs.readFileSync.mockReturnValue(
      [
        "on:",
        "  deployment_status:",
        "concurrency:",
        "  group: cypress-${{ github.event.deployment.ref || github.ref }}",
        "  cancel-in-progress: true",
        "jobs:",
        "  test:",
        "    runs-on: self-hosted",
      ].join("\n"),
    );

    await run([repo]);

    expect(mockGh.createIssue).not.toHaveBeenCalled();
  });

  it("skips issue creation when a matching open issue already exists", async () => {
    mockFs.readdirSync.mockReturnValue(["ci.yml"]);
    mockFs.readFileSync.mockReturnValue(
      "on:\n  push:\njobs:\n  build:\n    runs-on: self-hosted\n",
    );
    mockGh.searchIssues.mockResolvedValue([
      { number: 42, title: "Alert: workflow concurrency misconfiguration" },
    ]);

    await run([repo]);

    expect(mockGh.createIssue).not.toHaveBeenCalled();
  });

  it("reports errors without crashing the loop", async () => {
    const repo2 = mockRepo({
      name: "test-repo-2",
      fullName: "test-org/test-repo-2",
    });

    mockFs.readdirSync.mockReturnValue(["ci.yml"]);
    mockFs.readFileSync.mockReturnValue(
      "on:\n  push:\njobs:\n  build:\n    runs-on: self-hosted\n",
    );
    mockGh.searchIssues
      .mockRejectedValueOnce(new Error("API error"))
      .mockResolvedValueOnce([]);

    await run([repo, repo2]);

    expect(reportError).toHaveBeenCalledWith(
      "concurrency-scanner:process-repo",
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
