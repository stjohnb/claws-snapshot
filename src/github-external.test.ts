import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockExecFile, mockGithubApp } = vi.hoisted(() => ({
  mockExecFile: vi.fn(),
  mockGithubApp: {
    buildEnvForGh: vi.fn((token: string | null) => ({ GH_TOKEN: token ?? "" })),
    getInstallationTokenForOwner: vi.fn(async (owner: string) => `token-${owner}`),
    getAnyInstallationToken: vi.fn(async () => "token-any"),
    githubAppOwners: vi.fn(() => ["stjohnb"]),
  },
}));

vi.mock("node:child_process", () => ({ execFile: mockExecFile }));
vi.mock("./github-app.js", () => mockGithubApp);
vi.mock("./util.js", () => ({ sleep: vi.fn(async () => {}) }));
vi.mock("./log.js", () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }));

import { RateLimitError } from "./rate-limit.js";
import {
  createRelease,
  disableDependabot,
  ensureSnapshotTarget,
  getIssueState,
  getReleaseAssetNames,
  getUpstreamPRStatus,
  listReleases,
} from "./github-external.js";

type Reply = { stdout?: string; stderr?: string; fail?: boolean };

/** Answer successive `gh` calls in order; the last reply repeats. */
function replies(...rs: Reply[]): void {
  let i = 0;
  mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: (e: Error | null, o: string, s: string) => void) => {
    const r = rs[Math.min(i++, rs.length - 1)]!;
    if (r.fail) cb(new Error("exit 1"), "", r.stderr ?? "");
    else cb(null, r.stdout ?? "", "");
  });
}

function ghArgs(call = 0): string[] {
  return mockExecFile.mock.calls[call]![1] as string[];
}

function ghEnv(call = 0): Record<string, string> {
  return (mockExecFile.mock.calls[call]![2] as { env: Record<string, string> }).env;
}

describe("github-external", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("runs gh with the target owner's installation token when the App is installed there", async () => {
    replies({ stdout: '{"archived":false,"default_branch":"trunk"}' });

    expect(await ensureSnapshotTarget("stjohnb/claws-snapshot")).toEqual({ exists: true, archived: false, defaultBranch: "trunk" });
    expect(mockExecFile.mock.calls[0]![0]).toBe("gh");
    expect(ghArgs()).toEqual(["api", "repos/stjohnb/claws-snapshot", "--jq", "{archived: .archived, default_branch: .default_branch}"]);
    expect(mockGithubApp.getInstallationTokenForOwner).toHaveBeenCalledWith("stjohnb");
    expect(ghEnv().GH_TOKEN).toBe("token-stjohnb");
  });

  it("reads an outside owner's public repo with any installation's token", async () => {
    replies({ stdout: "[]" });

    await listReleases("seerr-team/seerr");

    expect(mockGithubApp.getInstallationTokenForOwner).not.toHaveBeenCalled();
    expect(ghEnv().GH_TOKEN).toBe("token-any");
  });

  it("reports a missing snapshot target as exists: false", async () => {
    replies({ fail: true, stderr: "gh: Not Found (HTTP 404)" });

    expect(await ensureSnapshotTarget("stjohnb/nope")).toEqual({ exists: false, archived: false, defaultBranch: "main" });
  });

  it("retries a GitHub 5xx and returns the eventual answer", async () => {
    replies({ fail: true, stderr: "gh: HTTP 502: Bad gateway" }, { stdout: "a.dmg\nb.tar.gz\n" });

    expect(await getReleaseAssetNames("stjohnb/TempoStatusBar", "v1.3.1")).toEqual(["a.dmg", "b.tar.gz"]);
    expect(mockExecFile).toHaveBeenCalledTimes(2);
  });

  it("throws RateLimitError on a rate-limit response without retrying", async () => {
    replies({ fail: true, stderr: "gh: API rate limit exceeded for installation ID 1 (HTTP 403)" });

    await expect(getUpstreamPRStatus("seerr-team/seerr", 2715)).rejects.toBeInstanceOf(RateLimitError);
    await expect(listReleases("seerr-team/seerr")).rejects.toBeInstanceOf(RateLimitError);
    expect(mockExecFile).toHaveBeenCalledTimes(2);
  });

  it("passes --latest=false to a release created while Latest is held back", async () => {
    replies({ stdout: "" });

    await createRelease("stjohnb/TempoStatusBar", "linux-v0.3.0", ["/tmp/a.tar.gz"], "abc123", "linux-v0.3.0", { latest: false });

    expect(ghArgs()).toEqual([
      "release", "create", "linux-v0.3.0", "/tmp/a.tar.gz", "--repo", "stjohnb/TempoStatusBar", "--title", "linux-v0.3.0",
      "--target", "abc123", "--notes", "Public snapshot release linux-v0.3.0.", "--latest=false",
    ]);
  });

  it("disables Dependabot best-effort, tolerating a 404 on either endpoint", async () => {
    replies({ fail: true, stderr: "gh: Not Found (HTTP 404)" }, { stdout: "" });

    await expect(disableDependabot("stjohnb/claws-snapshot")).resolves.toBeUndefined();
    expect(ghArgs(0)).toEqual(["api", "repos/stjohnb/claws-snapshot/automated-security-fixes", "--method", "DELETE"]);
    expect(ghArgs(1)).toEqual(["api", "repos/stjohnb/claws-snapshot/vulnerability-alerts", "--method", "DELETE"]);
  });

  it("normalises an upstream PR's state and returns null for a missing PR", async () => {
    replies({ stdout: JSON.stringify({ state: "CLOSED", merged: true, mergedAt: "2026-08-25T00:00:00Z", title: "feat: OIDC", url: "u", updatedAt: "2026-08-25T00:00:00Z" }) });
    expect(await getUpstreamPRStatus("seerr-team/seerr", 2715)).toMatchObject({ state: "closed", merged: true });

    replies({ fail: true, stderr: "gh: Not Found (HTTP 404)" });
    expect(await getUpstreamPRStatus("seerr-team/seerr", 1)).toBeNull();
  });

  it("reads an upstream issue's state, throwing a not-found error for a missing issue", async () => {
    replies({ stdout: '{"state":"closed","stateReason":"completed"}' });
    expect(await getIssueState("seerr-team/seerr", 42)).toEqual({ state: "CLOSED", stateReason: "completed" });

    replies({ fail: true, stderr: "gh: Not Found (HTTP 404)" });
    await expect(getIssueState("seerr-team/seerr", 43)).rejects.toThrow(/not found/i);
  });
});
