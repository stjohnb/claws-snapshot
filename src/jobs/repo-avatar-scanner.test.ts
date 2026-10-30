import { describe, it, expect, vi, beforeEach } from "vitest";
import { mockRepo } from "../test-helpers.js";

vi.mock("../log.js", () => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));

vi.mock("../error-reporter.js", () => ({
  reportError: vi.fn(),
}));

const { mockOccurrence, mockRepoConfig } = vi.hoisted(() => ({
  mockOccurrence: {
    upsertAlertIssue: vi.fn(),
    closeAlertIssueIfResolved: vi.fn(),
  },
  mockRepoConfig: {
    getRepoConfig: vi.fn(),
    getRepoConfigState: vi.fn(),
    REPO_CONFIG_PATH: "claws.json",
  },
}));

vi.mock("../occurrence-tracking.js", () => mockOccurrence);
vi.mock("../repo-config.js", () => mockRepoConfig);

import { run, buildBody, ISSUE_TITLE } from "./repo-avatar-scanner.js";
import { reportError } from "../error-reporter.js";

describe("repo-avatar-scanner", () => {
  const repo = mockRepo();

  beforeEach(() => {
    vi.clearAllMocks();
    mockRepoConfig.getRepoConfigState.mockReturnValue("present");
    mockRepoConfig.getRepoConfig.mockReturnValue({ avatar: null });
    mockOccurrence.upsertAlertIssue.mockResolvedValue("created");
    mockOccurrence.closeAlertIssueIfResolved.mockResolvedValue(null);
  });

  it("files one unlabelled issue when claws.json has no avatar", async () => {
    await run([repo]);

    expect(mockOccurrence.upsertAlertIssue).toHaveBeenCalledTimes(1);
    expect(mockOccurrence.upsertAlertIssue).toHaveBeenCalledWith({
      repo: repo.fullName,
      title: ISSUE_TITLE,
      body: buildBody(repo.fullName),
      labels: [],
      logPrefix: "repo-avatar-scanner",
    });
    expect(mockOccurrence.closeAlertIssueIfResolved).not.toHaveBeenCalled();
  });

  it("files the issue when the repo has no claws.json", async () => {
    mockRepoConfig.getRepoConfigState.mockReturnValue("absent");
    mockRepoConfig.getRepoConfig.mockReturnValue(null);

    await run([repo]);

    expect(mockOccurrence.upsertAlertIssue).toHaveBeenCalledTimes(1);
  });

  it("sends the same body on every run so an existing issue is left unchanged", async () => {
    await run([repo]);
    mockOccurrence.upsertAlertIssue.mockResolvedValue("unchanged");
    await run([repo]);

    const [first, second] = mockOccurrence.upsertAlertIssue.mock.calls.map((c) => c[0]);
    expect(second).toEqual(first);
  });

  it("closes an open issue and files nothing once an avatar is declared", async () => {
    mockRepoConfig.getRepoConfig.mockReturnValue({ avatar: "docs/avatar.png" });

    await run([repo]);

    expect(mockOccurrence.closeAlertIssueIfResolved).toHaveBeenCalledWith({
      repo: repo.fullName,
      title: ISSUE_TITLE,
      logPrefix: "repo-avatar-scanner",
      reason: "avatar declared in claws.json",
    });
    expect(mockOccurrence.upsertAlertIssue).not.toHaveBeenCalled();
  });

  it("does nothing while the repo's config state is unknown", async () => {
    mockRepoConfig.getRepoConfigState.mockReturnValue("unknown");
    mockRepoConfig.getRepoConfig.mockReturnValue(null);

    await run([repo]);

    expect(mockOccurrence.upsertAlertIssue).not.toHaveBeenCalled();
    expect(mockOccurrence.closeAlertIssueIfResolved).not.toHaveBeenCalled();
  });

  it("reports a per-repo failure without stopping other repos", async () => {
    const other = mockRepo({ name: "other", fullName: "test-org/other" });
    mockOccurrence.upsertAlertIssue.mockRejectedValueOnce(new Error("boom"));

    await run([repo, other]);

    expect(reportError).toHaveBeenCalledWith(
      "repo-avatar-scanner:process-repo",
      repo.fullName,
      expect.any(Error),
      { repo: repo.fullName },
    );
    expect(mockOccurrence.upsertAlertIssue).toHaveBeenCalledTimes(2);
  });

  it("explains the key, an example and the opt-out", () => {
    const body = buildBody("test-org/test-repo");
    expect(body).toContain('{"avatar": "docs/avatar.png"}');
    expect(body).toContain(".webp");
    expect(body).toContain("repo-avatar-scanner");
  });
});
