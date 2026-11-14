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
    author: { login: "testuser" },
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
    isCrossRepository: false,
    ...overrides,
  };
}

/**
 * Complete a partial `./config.js` mock: copy every export of the real module
 * that `mock` does not define onto `mock` as a plain value, and return `mock`
 * itself so a test's later mutations of its hoisted object (and any getters on
 * it) keep working. Use as
 * `vi.mock("./config.js", async (importOriginal) => completeConfigMock(await importOriginal(), mockConfig))`,
 * so production code can read config bindings directly with no
 * catch-and-fallback helper for missing mock exports.
 */
export function completeConfigMock<T extends object>(real: object, mock: T): T {
  for (const key of Object.keys(real)) {
    if (Object.hasOwn(mock, key)) continue;
    (mock as Record<string, unknown>)[key] = (real as Record<string, unknown>)[key];
  }
  return mock;
}
