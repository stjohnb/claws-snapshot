import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../log.js", () => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock("../error-reporter.js", () => ({
  reportError: vi.fn(),
}));

vi.mock("./ubuntu-latest-scanner.js", () => ({
  run: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./concurrency-scanner.js", () => ({
  run: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./migration-scanner.js", () => ({
  run: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./main-build-monitor-scanner.js", () => ({
  run: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./cache-on-self-hosted-scanner.js", () => ({
  run: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./issue-comment-spam-scanner.js", () => ({
  run: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./runner-os-scanner.js", () => ({
  run: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./claude-config-scanner.js", () => ({
  run: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./gitignore-scanner.js", () => ({
  run: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../claude.js", () => ({
  refreshAllRepos: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../config.js", () => ({
  isJobDisabledForRepo: vi.fn().mockReturnValue(false),
}));

vi.mock("../db.js", () => ({ markRepoProcessedDaily: vi.fn() }));
vi.mock("../smart-schedule.js", () => ({ localDateString: () => "2024-01-15" }));

import { run } from "./scanner-dispatcher.js";
import { reportError } from "../error-reporter.js";
import * as db from "../db.js";
import * as ubuntuLatestScanner from "./ubuntu-latest-scanner.js";
import * as concurrencyScanner from "./concurrency-scanner.js";
import * as migrationScanner from "./migration-scanner.js";
import * as mainBuildMonitorScanner from "./main-build-monitor-scanner.js";
import * as cacheOnSelfHostedScanner from "./cache-on-self-hosted-scanner.js";
import * as issueCommentSpamScanner from "./issue-comment-spam-scanner.js";
import * as runnerOsScanner from "./runner-os-scanner.js";
import * as claudeConfigScanner from "./claude-config-scanner.js";
import * as gitignoreScanner from "./gitignore-scanner.js";
import * as claude from "../claude.js";
import { isJobDisabledForRepo, type Repo } from "../config.js";

const repos: Repo[] = [
  { owner: "test", name: "repo1", fullName: "test/repo1", defaultBranch: "main" },
];

describe("scanner-dispatcher", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("runs all nine scanners sequentially with the same repos", async () => {
    const order: string[] = [];
    vi.mocked(ubuntuLatestScanner.run).mockImplementation(async () => { order.push("ubuntu-latest"); });
    vi.mocked(concurrencyScanner.run).mockImplementation(async () => { order.push("concurrency"); });
    vi.mocked(migrationScanner.run).mockImplementation(async () => { order.push("migration"); });
    vi.mocked(mainBuildMonitorScanner.run).mockImplementation(async () => { order.push("main-build-monitor"); });
    vi.mocked(cacheOnSelfHostedScanner.run).mockImplementation(async () => { order.push("cache-on-self-hosted"); });
    vi.mocked(issueCommentSpamScanner.run).mockImplementation(async () => { order.push("issue-comment-spam"); });
    vi.mocked(runnerOsScanner.run).mockImplementation(async () => { order.push("runner-os"); });
    vi.mocked(claudeConfigScanner.run).mockImplementation(async () => { order.push("claude-config"); });
    vi.mocked(gitignoreScanner.run).mockImplementation(async () => { order.push("gitignore"); });

    await run(repos);

    expect(ubuntuLatestScanner.run).toHaveBeenCalledWith(repos);
    expect(concurrencyScanner.run).toHaveBeenCalledWith(repos);
    expect(migrationScanner.run).toHaveBeenCalledWith(repos);
    expect(mainBuildMonitorScanner.run).toHaveBeenCalledWith(repos);
    expect(cacheOnSelfHostedScanner.run).toHaveBeenCalledWith(repos);
    expect(issueCommentSpamScanner.run).toHaveBeenCalledWith(repos);
    expect(runnerOsScanner.run).toHaveBeenCalledWith(repos);
    expect(claudeConfigScanner.run).toHaveBeenCalledWith(repos);
    expect(gitignoreScanner.run).toHaveBeenCalledWith(repos);
    expect(order).toEqual(["ubuntu-latest", "concurrency", "migration", "main-build-monitor", "cache-on-self-hosted", "issue-comment-spam", "runner-os", "claude-config", "gitignore"]);
  });

  it("continues to next scanner when one fails", async () => {
    vi.mocked(ubuntuLatestScanner.run).mockRejectedValueOnce(new Error("scan failed"));

    await run(repos);

    expect(reportError).toHaveBeenCalledWith(
      "scanner-dispatcher:ubuntu-latest-scanner",
      "ubuntu-latest-scanner",
      expect.any(Error),
    );
    // Other scanners still ran
    expect(concurrencyScanner.run).toHaveBeenCalledWith(repos);
    expect(migrationScanner.run).toHaveBeenCalledWith(repos);
    expect(mainBuildMonitorScanner.run).toHaveBeenCalledWith(repos);
    expect(cacheOnSelfHostedScanner.run).toHaveBeenCalledWith(repos);
    expect(issueCommentSpamScanner.run).toHaveBeenCalledWith(repos);
    expect(runnerOsScanner.run).toHaveBeenCalledWith(repos);
    expect(claudeConfigScanner.run).toHaveBeenCalledWith(repos);
    expect(gitignoreScanner.run).toHaveBeenCalledWith(repos);
  });

  it("reports errors for each failing scanner independently", async () => {
    vi.mocked(ubuntuLatestScanner.run).mockRejectedValueOnce(new Error("fail1"));
    vi.mocked(migrationScanner.run).mockRejectedValueOnce(new Error("fail2"));

    await run(repos);

    expect(reportError).toHaveBeenCalledTimes(2);
    expect(concurrencyScanner.run).toHaveBeenCalledWith(repos);
  });

  it("filters repos for opt-in scanners while passing all repos to standard scanners", async () => {
    vi.mocked(isJobDisabledForRepo).mockImplementation((job, _repo) =>
      job === "main-build-monitor-scanner"
    );

    await run(repos);

    expect(ubuntuLatestScanner.run).toHaveBeenCalledWith(repos);
    expect(concurrencyScanner.run).toHaveBeenCalledWith(repos);
    expect(migrationScanner.run).toHaveBeenCalledWith(repos);
    expect(cacheOnSelfHostedScanner.run).toHaveBeenCalledWith(repos);
    expect(issueCommentSpamScanner.run).toHaveBeenCalledWith(repos);
    expect(runnerOsScanner.run).toHaveBeenCalledWith(repos);
    expect(claudeConfigScanner.run).toHaveBeenCalledWith(repos);
    expect(gitignoreScanner.run).toHaveBeenCalledWith(repos);
    expect(mainBuildMonitorScanner.run).toHaveBeenCalledWith([]);
  });

  it("marks all repos processed after run", async () => {
    await run(repos);
    expect(vi.mocked(db.markRepoProcessedDaily)).toHaveBeenCalledWith(
      "scanner-dispatcher", "test/repo1", "2024-01-15"
    );
  });

  it("calls refreshAllRepos before running scanners", async () => {
    const order: string[] = [];
    vi.mocked(claude.refreshAllRepos).mockImplementation(async () => { order.push("refresh"); });
    vi.mocked(ubuntuLatestScanner.run).mockImplementation(async () => { order.push("ubuntu-latest"); });
    vi.mocked(concurrencyScanner.run).mockImplementation(async () => { order.push("concurrency"); });
    vi.mocked(migrationScanner.run).mockImplementation(async () => { order.push("migration"); });
    vi.mocked(mainBuildMonitorScanner.run).mockImplementation(async () => { order.push("main-build-monitor"); });
    vi.mocked(cacheOnSelfHostedScanner.run).mockImplementation(async () => { order.push("cache-on-self-hosted"); });
    vi.mocked(issueCommentSpamScanner.run).mockImplementation(async () => { order.push("issue-comment-spam"); });
    vi.mocked(runnerOsScanner.run).mockImplementation(async () => { order.push("runner-os"); });
    vi.mocked(claudeConfigScanner.run).mockImplementation(async () => { order.push("claude-config"); });
    vi.mocked(gitignoreScanner.run).mockImplementation(async () => { order.push("gitignore"); });

    await run(repos);

    expect(claude.refreshAllRepos).toHaveBeenCalledWith(repos);
    expect(order).toEqual(["refresh", "ubuntu-latest", "concurrency", "migration", "main-build-monitor", "cache-on-self-hosted", "issue-comment-spam", "runner-os", "claude-config", "gitignore"]);
  });
});
