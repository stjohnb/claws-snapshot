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

  it("defaults every migrated setting to an empty list when the file names none", async () => {
    await refreshRepoConfigs(REPOS, fetcher(JSON.stringify({ notes: "nothing to see" })));
    const config = getRepoConfig("owner/repo");
    expect(config?.runners).toEqual([]);
    expect(config?.prodAlertWorkflows).toEqual([]);
    expect(config?.mainBuildIgnoreWorkflows).toEqual([]);
    expect(config?.dependabotIgnoredAdvisories).toEqual([]);
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
