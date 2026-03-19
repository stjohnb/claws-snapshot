import type { Repo } from "./config.js";
import type { Issue, PR } from "./github.js";

export function mockRepo(overrides: Partial<Repo> = {}): Repo {
  return {
    owner: "test-org",
    name: "test-repo",
    fullName: "test-org/test-repo",
    defaultBranch: "main",
    ...overrides,
  };
}

export function mockIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    number: 1,
    title: "Test issue",
    body: "Test issue body",
    labels: [],
    ...overrides,
  };
}

export function mockPR(overrides: Partial<PR> = {}): PR {
  return {
    number: 10,
    title: "Test PR",
    headRefName: "feature-branch",
    baseRefName: "main",
    labels: [],
    author: { login: "testuser" },
    body: "",
    ...overrides,
  };
}
