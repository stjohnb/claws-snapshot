import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./log.js", () => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));

import * as log from "./log.js";
import {
  refreshRepoConfigs,
  getRepoConfig,
  getRepoConfigState,
  isRepoMonitored,
  clearRepoConfigCache,
  forceRefreshRepoConfig,
  FORCED_REFRESH_MIN_INTERVAL_MS,
  listRepoConfigs,
  REPO_CONFIG_PATH,
} from "./repo-config.js";

const REPOS = [{ fullName: "owner/repo" }];

/** What every optional key defaults to — `{}` and a malformed file both land here. */
const EMPTY_CONFIG = {
  enabled: true,
  disabledJobs: [],
  runners: [],
  prodAlertWorkflows: [],
  mainBuildIgnoreWorkflows: [],
  dependabotIgnoredAdvisories: [],
  incidentLabels: [],
  description: null,
  autoPromote: {},
  issuePreviewSummaryUrl: null,
  deploys: [],
  avatar: null,
  alertBridge: null,
  issueFiler: null,
  mergeWithoutChecks: false,
  maxPushFileBytes: null,
};

beforeEach(() => {
  clearRepoConfigCache();
  vi.mocked(log.warn).mockClear();
});

/** A fetcher that returns the same body (or throws the same error) every call. */
function fetcher(result: string | null | Error): (fullName: string, path: string) => Promise<string | null> {
  return vi.fn(async () => {
    if (result instanceof Error) throw result;
    return result;
  });
}

describe("refreshRepoConfigs", () => {
  it("treats a missing claws.json as opting out — the file is mandatory", async () => {
    await refreshRepoConfigs(REPOS, fetcher(null));
    expect(getRepoConfigState("owner/repo")).toBe("absent");
    expect(isRepoMonitored("owner/repo")).toBe(false);
    expect(getRepoConfig("owner/repo")).toBeNull();
  });

  it("monitors a repo with an empty object", async () => {
    await refreshRepoConfigs(REPOS, fetcher("{}"));
    expect(getRepoConfigState("owner/repo")).toBe("present");
    expect(isRepoMonitored("owner/repo")).toBe(true);
    expect(getRepoConfig("owner/repo")).toEqual(EMPTY_CONFIG);
  });

  it('does not monitor a repo with "enabled": false', async () => {
    await refreshRepoConfigs(REPOS, fetcher(JSON.stringify({ enabled: false })));
    expect(getRepoConfigState("owner/repo")).toBe("present");
    expect(isRepoMonitored("owner/repo")).toBe(false);
  });

  it("parses disabledJobs", async () => {
    await refreshRepoConfigs(REPOS, fetcher(JSON.stringify({ disabledJobs: ["doc-maintainer"] })));
    expect(getRepoConfig("owner/repo")?.disabledJobs).toEqual(["doc-maintainer"]);
    expect(isRepoMonitored("owner/repo")).toBe(true);
  });

  it("accepts an unknown key so a repo can adopt a newer Claws' setting", async () => {
    await refreshRepoConfigs(REPOS, fetcher(JSON.stringify({ futureThing: 1 })));
    expect(isRepoMonitored("owner/repo")).toBe(true);
    expect(getRepoConfigState("owner/repo")).toBe("present");
  });

  it("fails open on malformed JSON — a bad file must never unmonitor a repo", async () => {
    await refreshRepoConfigs(REPOS, fetcher("{ not json"));
    expect(isRepoMonitored("owner/repo")).toBe(true);
    expect(getRepoConfig("owner/repo")).toEqual(EMPTY_CONFIG);
    expect(vi.mocked(log.warn).mock.calls.flat().join(" ")).toContain("owner/repo");
  });

  it("fails open when the fetch throws and nothing was cached", async () => {
    await refreshRepoConfigs(REPOS, fetcher(new Error("HTTP 500")));
    expect(getRepoConfigState("owner/repo")).toBe("unknown");
    expect(isRepoMonitored("owner/repo")).toBe(true);
    expect(vi.mocked(log.warn)).toHaveBeenCalled();
  });

  it("leaves a cached absent decision standing when a later fetch throws", async () => {
    await refreshRepoConfigs(REPOS, fetcher(null));
    await refreshRepoConfigs(REPOS, fetcher(new Error("network down")));
    expect(getRepoConfigState("owner/repo")).toBe("absent");
    expect(isRepoMonitored("owner/repo")).toBe(false);
  });

  it("caches a present file for the TTL but re-fetches an absent one every time", async () => {
    const present = fetcher("{}");
    await refreshRepoConfigs(REPOS, present);
    await refreshRepoConfigs(REPOS, present);
    expect(present).toHaveBeenCalledTimes(1);
    expect(present).toHaveBeenCalledWith("owner/repo", REPO_CONFIG_PATH);

    clearRepoConfigCache();

    const absent = fetcher(null);
    await refreshRepoConfigs(REPOS, absent);
    await refreshRepoConfigs(REPOS, absent);
    expect(absent).toHaveBeenCalledTimes(2);
  });

  it("parses the per-repo settings migrated off the host config (#2898)", async () => {
    await refreshRepoConfigs(
      REPOS,
      fetcher(
        JSON.stringify({
          runners: ["macos"],
          prodAlertWorkflows: ["deploy.yml"],
          mainBuildIgnoreWorkflows: ["nightly.yml"],
          dependabotIgnoredAdvisories: ["GHSA-aaaa-bbbb-cccc"],
        }),
      ),
    );
    const config = getRepoConfig("owner/repo");
    expect(config?.runners).toEqual(["macos"]);
    expect(config?.prodAlertWorkflows).toEqual(["deploy.yml"]);
    expect(config?.mainBuildIgnoreWorkflows).toEqual(["nightly.yml"]);
    expect(config?.dependabotIgnoredAdvisories).toEqual(["GHSA-aaaa-bbbb-cccc"]);
  });

  it("ignores repo-side plannerCapabilities; grants are owned by Claws", async () => {
    await refreshRepoConfigs(REPOS, fetcher(JSON.stringify({ plannerCapabilities: ["home-assistant"] })));
    expect(getRepoConfig("owner/repo")).not.toHaveProperty("plannerCapabilities");
  });

  it("defaults every migrated setting to an empty list when the file names none", async () => {
    await refreshRepoConfigs(REPOS, fetcher(JSON.stringify({ notes: "nothing to see" })));
    const config = getRepoConfig("owner/repo");
    expect(config?.runners).toEqual([]);
    expect(config?.prodAlertWorkflows).toEqual([]);
    expect(config?.mainBuildIgnoreWorkflows).toEqual([]);
    expect(config?.dependabotIgnoredAdvisories).toEqual([]);
  });

  it("accepts a valid issuePreviewSummaryUrl template", async () => {
    const url = "https://www.bstjohn.net/3d-models/issue-preview/{issue}/{sha8}/preview-summary.json";
    await refreshRepoConfigs(REPOS, fetcher(JSON.stringify({ issuePreviewSummaryUrl: url })));
    expect(getRepoConfig("owner/repo")?.issuePreviewSummaryUrl).toBe(url);
  });

  it.each([
    ["not https", "http://example.test/{issue}/{sha8}/preview-summary.json"],
    ["missing {issue}", "https://example.test/{sha8}/preview-summary.json"],
    ["missing {sha8}", "https://example.test/{issue}/preview-summary.json"],
  ])("drops an invalid issuePreviewSummaryUrl (%s) and warns", async (_name, url) => {
    await refreshRepoConfigs(REPOS, fetcher(JSON.stringify({ issuePreviewSummaryUrl: url })));
    expect(getRepoConfig("owner/repo")?.issuePreviewSummaryUrl).toBeNull();
    expect(vi.mocked(log.warn).mock.calls.flat().join(" ")).toContain("owner/repo");
  });

  it("defaults issuePreviewSummaryUrl to null when absent", async () => {
    await refreshRepoConfigs(REPOS, fetcher("{}"));
    expect(getRepoConfig("owner/repo")?.issuePreviewSummaryUrl).toBeNull();
  });

  it("accepts a repo-relative avatar image path, and a file holding only avatar stays monitored", async () => {
    await refreshRepoConfigs(REPOS, fetcher(JSON.stringify({ avatar: "docs/avatar.png" })));
    expect(getRepoConfig("owner/repo")?.avatar).toBe("docs/avatar.png");
    expect(isRepoMonitored("owner/repo")).toBe(true);
    expect(vi.mocked(log.warn)).not.toHaveBeenCalled();
  });

  it.each([
    ["absolute", "/abs.png"],
    ["parent segment", "../x.png"],
    ["nested parent segment", "docs/../../x.png"],
    ["URL", "https://x/y.png"],
    ["unsupported extension", "logo.bmp"],
  ])("drops an invalid avatar (%s) and warns", async (_name, avatar) => {
    await refreshRepoConfigs(REPOS, fetcher(JSON.stringify({ avatar })));
    expect(getRepoConfig("owner/repo")?.avatar).toBeNull();
    expect(vi.mocked(log.warn).mock.calls.flat().join(" ")).toContain("owner/repo");
  });

  it("defaults avatar to null when absent", async () => {
    await refreshRepoConfigs(REPOS, fetcher("{}"));
    expect(getRepoConfig("owner/repo")?.avatar).toBeNull();
  });

  it("accepts a positive integer maxPushFileBytes", async () => {
    await refreshRepoConfigs(REPOS, fetcher(JSON.stringify({ maxPushFileBytes: 50_000_000 })));
    expect(getRepoConfig("owner/repo")?.maxPushFileBytes).toBe(50_000_000);
    expect(vi.mocked(log.warn)).not.toHaveBeenCalled();
  });

  it.each([
    ["zero", 0],
    ["negative", -1],
    ["fractional", 1.5],
    ["string", "10MB"],
  ])("drops an invalid maxPushFileBytes (%s) and warns", async (_name, maxPushFileBytes) => {
    await refreshRepoConfigs(REPOS, fetcher(JSON.stringify({ maxPushFileBytes })));
    expect(getRepoConfig("owner/repo")?.maxPushFileBytes).toBeNull();
    expect(isRepoMonitored("owner/repo")).toBe(true);
    expect(vi.mocked(log.warn).mock.calls.flat().join(" ")).toContain("maxPushFileBytes");
  });

  it("parses a well-formed alertBridge entry", async () => {
    const alertBridge = { label: "alert", title: "[Alert] repo alerts firing", tokenSha256: "a".repeat(64) };
    await refreshRepoConfigs(REPOS, fetcher(JSON.stringify({ alertBridge })));
    expect(getRepoConfig("owner/repo")?.alertBridge).toEqual(alertBridge);
    expect(vi.mocked(log.warn)).not.toHaveBeenCalled();
  });

  it.each([
    ["uppercase hash", { label: "alert", title: "t", tokenSha256: "A".repeat(64) }],
    ["short hash", { label: "alert", title: "t", tokenSha256: "a".repeat(63) }],
    ["missing title", { label: "alert", tokenSha256: "a".repeat(64) }],
    ["empty label", { label: " ", title: "t", tokenSha256: "a".repeat(64) }],
    ["not an object", "alert"],
  ])("drops an invalid alertBridge (%s) and warns, keeping the rest of the file", async (_name, alertBridge) => {
    await refreshRepoConfigs(REPOS, fetcher(JSON.stringify({ alertBridge, avatar: "docs/a.png" })));
    expect(getRepoConfig("owner/repo")?.alertBridge).toBeNull();
    expect(getRepoConfig("owner/repo")?.avatar).toBe("docs/a.png");
    expect(vi.mocked(log.warn).mock.calls.flat().join(" ")).toContain("alertBridge");
  });

  it("defaults alertBridge to null when absent", async () => {
    await refreshRepoConfigs(REPOS, fetcher("{}"));
    expect(getRepoConfig("owner/repo")?.alertBridge).toBeNull();
  });

  it("parses a well-formed issueFiler entry", async () => {
    const issueFiler = { tokenSha256: "b".repeat(64), dedupeKeyPrefix: "site-review-" };
    await refreshRepoConfigs(REPOS, fetcher(JSON.stringify({ issueFiler })));
    expect(getRepoConfig("owner/repo")?.issueFiler).toEqual(issueFiler);
    expect(vi.mocked(log.warn)).not.toHaveBeenCalled();
  });

  it.each([
    ["uppercase hash", { tokenSha256: "B".repeat(64), dedupeKeyPrefix: "site-review-" }],
    ["short hash", { tokenSha256: "b".repeat(63), dedupeKeyPrefix: "site-review-" }],
    ["missing prefix", { tokenSha256: "b".repeat(64) }],
    ["uppercase prefix", { tokenSha256: "b".repeat(64), dedupeKeyPrefix: "Site-" }],
    ["one-character prefix", { tokenSha256: "b".repeat(64), dedupeKeyPrefix: "s" }],
    ["prefix over 50 characters", { tokenSha256: "b".repeat(64), dedupeKeyPrefix: "s".repeat(51) }],
    ["alert- prefix", { tokenSha256: "b".repeat(64), dedupeKeyPrefix: "alert-site-" }],
    ["not an object", "site-review-"],
  ])("drops an invalid issueFiler (%s) and warns, keeping the rest of the file", async (_name, issueFiler) => {
    await refreshRepoConfigs(REPOS, fetcher(JSON.stringify({ issueFiler, avatar: "docs/a.png" })));
    expect(getRepoConfig("owner/repo")?.issueFiler).toBeNull();
    expect(getRepoConfig("owner/repo")?.avatar).toBe("docs/a.png");
    expect(vi.mocked(log.warn).mock.calls.flat().join(" ")).toContain("issueFiler");
  });

  it("defaults issueFiler to null when absent", async () => {
    await refreshRepoConfigs(REPOS, fetcher("{}"));
    expect(getRepoConfig("owner/repo")?.issueFiler).toBeNull();
  });

  it("parses mergeWithoutChecks and defaults it to false", async () => {
    await refreshRepoConfigs(REPOS, fetcher(JSON.stringify({ mergeWithoutChecks: true })));
    expect(getRepoConfig("owner/repo")?.mergeWithoutChecks).toBe(true);
    clearRepoConfigCache();
    await refreshRepoConfigs(REPOS, fetcher("{}"));
    expect(getRepoConfig("owner/repo")?.mergeWithoutChecks).toBe(false);
  });

  it("parses description, trimmed and first-line-only", async () => {
    await refreshRepoConfigs(REPOS, fetcher(JSON.stringify({ description: "  A 3D riding app.  \nSecond line ignored." })));
    expect(getRepoConfig("owner/repo")?.description).toBe("A 3D riding app.");
  });

  it("parses the autoPromote policy, and defaults it to empty", async () => {
    await refreshRepoConfigs(REPOS, fetcher(JSON.stringify({ autoPromote: { attended: true, bugsAndAlerts: false } })));
    expect(getRepoConfig("owner/repo")?.autoPromote).toEqual({ bugsAndAlerts: false });
    clearRepoConfigCache();
    await refreshRepoConfigs(REPOS, fetcher("{}"));
    expect(getRepoConfig("owner/repo")?.autoPromote).toEqual({});
  });

  it("parses autoPromote.bugsAndAlerts, and falls back to defaults on a non-boolean value", async () => {
    await refreshRepoConfigs(REPOS, fetcher(JSON.stringify({ autoPromote: { bugsAndAlerts: false } })));
    expect(getRepoConfig("owner/repo")?.autoPromote).toEqual({ bugsAndAlerts: false });

    clearRepoConfigCache();
    await refreshRepoConfigs(REPOS, fetcher(JSON.stringify({ autoPromote: { bugsAndAlerts: "nope" } })));
    expect(getRepoConfig("owner/repo")?.autoPromote).toEqual({});
    expect(vi.mocked(log.warn).mock.calls.flat().join(" ")).toContain("owner/repo");
  });

  it("caps description at 200 characters", async () => {
    const longDescription = "x".repeat(250);
    await refreshRepoConfigs(REPOS, fetcher(JSON.stringify({ description: longDescription })));
    expect(getRepoConfig("owner/repo")?.description).toBe("x".repeat(200));
  });

  it("defaults description to null when absent", async () => {
    await refreshRepoConfigs(REPOS, fetcher("{}"));
    expect(getRepoConfig("owner/repo")?.description).toBeNull();
  });

  it("parses deploys entries and drops a malformed one with a warning", async () => {
    await refreshRepoConfigs(REPOS, fetcher(JSON.stringify({
      deploys: [
        { repo: "St-John-Software/production-infra", path: "tofu/zone.tf", relation: "provisions" },
        { repo: "St-John-Software/whyrr", path: "apps/whyrr/deployment.yaml" },
        { repo: "not-a-full-name", path: "x.yaml" },
        { repo: "St-John-Software/namey", path: "x.yaml", relation: "depends-on" },
      ],
    })));
    expect(getRepoConfig("owner/repo")?.deploys).toEqual([
      { repo: "St-John-Software/production-infra", path: "tofu/zone.tf", relation: "provisions" },
      { repo: "St-John-Software/whyrr", path: "apps/whyrr/deployment.yaml" },
    ]);
    expect(getRepoConfig("owner/repo")?.enabled).toBe(true);
    expect(vi.mocked(log.warn)).toHaveBeenCalledTimes(2);
  });

  it("looks up repos case-insensitively", async () => {
    await refreshRepoConfigs([{ fullName: "Owner/Repo" }], fetcher(JSON.stringify({ disabledJobs: ["idea-suggester"] })));
    expect(isRepoMonitored("owner/repo")).toBe(true);
    expect(getRepoConfigState("OWNER/REPO")).toBe("present");
    expect(getRepoConfig("owner/REPO")?.disabledJobs).toEqual(["idea-suggester"]);
  });
});

describe("listRepoConfigs", () => {
  it("returns only repos whose file was read, in their original casing", async () => {
    await refreshRepoConfigs([{ fullName: "Owner/Repo" }], fetcher(JSON.stringify({ runners: ["macos"] })));
    const listed = listRepoConfigs();
    expect(listed).toHaveLength(1);
    expect(listed[0].fullName).toBe("Owner/Repo");
    expect(listed[0].config.runners).toEqual(["macos"]);
  });

  it("omits absent and never-read repos", async () => {
    await refreshRepoConfigs([{ fullName: "owner/present" }], fetcher("{}"));
    await refreshRepoConfigs([{ fullName: "owner/absent" }], fetcher(null));
    await refreshRepoConfigs([{ fullName: "owner/unreachable" }], fetcher(new Error("HTTP 500")));
    expect(listRepoConfigs().map((e) => e.fullName)).toEqual(["owner/present"]);
  });
});

describe("forceRefreshRepoConfig", () => {
  it("bypasses the TTL and picks up the new file", async () => {
    await refreshRepoConfigs(REPOS, fetcher("{}"));
    expect(await forceRefreshRepoConfig("OWNER/repo", fetcher(JSON.stringify({ description: "new" })))).toBe(true);
    expect(getRepoConfig("owner/repo")?.description).toBe("new");
  });

  it("is rate-limited per repo", async () => {
    vi.useFakeTimers();
    try {
      await refreshRepoConfigs(REPOS, fetcher("{}"));
      const f = fetcher("{}");
      expect(await forceRefreshRepoConfig("owner/repo", f)).toBe(true);
      expect(await forceRefreshRepoConfig("owner/repo", f)).toBe(false);
      vi.advanceTimersByTime(FORCED_REFRESH_MIN_INTERVAL_MS + 1);
      expect(await forceRefreshRepoConfig("owner/repo", f)).toBe(true);
      expect(f).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns false without fetching for an unknown or absent repo", async () => {
    await refreshRepoConfigs(REPOS, fetcher(null));
    const f = fetcher("{}");
    expect(await forceRefreshRepoConfig("owner/repo", f)).toBe(false);
    expect(await forceRefreshRepoConfig("nobody/none", f)).toBe(false);
    expect(f).not.toHaveBeenCalled();
  });

  it("leaves the entry untouched when the fetch throws", async () => {
    vi.useFakeTimers();
    try {
      await refreshRepoConfigs(REPOS, fetcher(JSON.stringify({ description: "old" })));
      vi.advanceTimersByTime(5000);
      expect(await forceRefreshRepoConfig("owner/repo", fetcher(new Error("boom")))).toBe(true);
      expect(getRepoConfig("owner/repo")?.description).toBe("old");
    } finally {
      vi.useRealTimers();
    }
  });
});
