import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./log.js", () => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));

import * as log from "./log.js";
import { resolveIssueFiler } from "./issue-filer.js";
import type { RepoConfig, RepoIssueFiler } from "./repo-config.js";

const SENTINEL_HASH = "a".repeat(64);
const GROWTH_HASH = "b".repeat(64);
const OTHER_HASH = "c".repeat(64);

function entry(fullName: string, issueFiler: RepoIssueFiler | null): { fullName: string; config: RepoConfig } {
  return { fullName, config: { issueFiler } as RepoConfig };
}

function filer(tokenSha256: string, dedupeKeyPrefix: string, repos: string[] = []): RepoIssueFiler {
  return { tokenSha256, dedupeKeyPrefix, repos };
}

describe("resolveIssueFiler", () => {
  beforeEach(() => vi.clearAllMocks());

  it("resolves the path repo's own filer, in its configured casing", () => {
    const configs = [entry("St-John-Software/Bonkus", filer(GROWTH_HASH, "site-review-"))];
    expect(resolveIssueFiler("st-john-software/bonkus", GROWTH_HASH, configs, "present")).toEqual({
      tokenSha256: GROWTH_HASH, dedupeKeyPrefix: "site-review-", repo: "St-John-Software/Bonkus", declaredBy: "St-John-Software/Bonkus",
    });
  });

  it("resolves a cross-repo filer that names the path repo exactly", () => {
    const configs = [
      entry("St-John-Software/sentinel", filer(SENTINEL_HASH, "sentinel-", ["st-john-software/fleet-infra"])),
      entry("St-John-Software/fleet-infra", null),
    ];
    expect(resolveIssueFiler("St-John-Software/fleet-infra", SENTINEL_HASH, configs, "present")).toEqual({
      tokenSha256: SENTINEL_HASH, dedupeKeyPrefix: "sentinel-", repo: "St-John-Software/fleet-infra", declaredBy: "St-John-Software/sentinel",
    });
  });

  it("resolves a cross-repo filer through an owner wildcard", () => {
    const configs = [
      entry("St-John-Software/sentinel", filer(SENTINEL_HASH, "sentinel-", ["St-John-Software/*"])),
      entry("St-John-Software/bonkus", filer(GROWTH_HASH, "site-review-")),
    ];
    expect(resolveIssueFiler("st-john-software/bonkus", SENTINEL_HASH, configs, "present")).toMatchObject({
      dedupeKeyPrefix: "sentinel-", repo: "St-John-Software/bonkus", declaredBy: "St-John-Software/sentinel",
    });
  });

  it("does not let one owner's wildcard reach another owner's repo", () => {
    const configs = [
      entry("St-John-Software/sentinel", filer(SENTINEL_HASH, "sentinel-", ["St-John-Software/*"])),
      entry("Other/repo", null),
    ];
    expect(resolveIssueFiler("Other/repo", SENTINEL_HASH, configs, "present")).toBeNull();
    expect(resolveIssueFiler("St-John-Software-x/repo", SENTINEL_HASH, configs, "present")).toBeNull();
  });

  it.each(["absent", "unknown"] as const)("refuses a target whose claws.json is %s", (state) => {
    const configs = [entry("St-John-Software/sentinel", filer(SENTINEL_HASH, "sentinel-", ["St-John-Software/*"]))];
    expect(resolveIssueFiler("St-John-Software/unmanaged", SENTINEL_HASH, configs, state)).toBeNull();
  });

  it("prefers the path repo's own filer over a cross-repo match with the same hash", () => {
    const configs = [
      entry("St-John-Software/sentinel", filer(GROWTH_HASH, "sentinel-", ["St-John-Software/*"])),
      entry("St-John-Software/bonkus", filer(GROWTH_HASH, "site-review-")),
    ];
    expect(resolveIssueFiler("St-John-Software/bonkus", GROWTH_HASH, configs, "present")).toMatchObject({
      dedupeKeyPrefix: "site-review-", declaredBy: "St-John-Software/bonkus",
    });
  });

  it.each([
    ["the cross prefix extends the own prefix", "site-", "site-review-"],
    ["the own prefix extends the cross prefix", "site-review-x-", "site-review-"],
    ["the prefixes are equal", "site-review-", "site-review-"],
  ])("refuses a cross-repo match whose prefix overlaps the path repo's own (%s) and warns", (_name, crossPrefix, ownPrefix) => {
    const configs = [
      entry("St-John-Software/sentinel", filer(SENTINEL_HASH, crossPrefix, ["St-John-Software/*"])),
      entry("St-John-Software/bonkus", filer(GROWTH_HASH, ownPrefix)),
    ];
    expect(resolveIssueFiler("St-John-Software/bonkus", SENTINEL_HASH, configs, "present")).toBeNull();
    expect(vi.mocked(log.warn).mock.calls[0]![0]).toContain("overlaps");
  });

  it("refuses cross-repo matches that disagree on prefix and warns", () => {
    const configs = [
      entry("St-John-Software/sentinel", filer(SENTINEL_HASH, "sentinel-", ["St-John-Software/*"])),
      entry("St-John-Software/other", filer(SENTINEL_HASH, "other-", ["St-John-Software/target"])),
      entry("St-John-Software/target", null),
    ];
    expect(resolveIssueFiler("St-John-Software/target", SENTINEL_HASH, configs, "present")).toBeNull();
    expect(vi.mocked(log.warn).mock.calls[0]![0]).toContain("conflicting prefixes");
  });

  it("collapses cross-repo matches that share a prefix", () => {
    const configs = [
      entry("St-John-Software/sentinel", filer(SENTINEL_HASH, "sentinel-", ["St-John-Software/*"])),
      entry("St-John-Software/sentinel-two", filer(SENTINEL_HASH, "sentinel-", ["St-John-Software/target"])),
      entry("St-John-Software/target", null),
    ];
    expect(resolveIssueFiler("St-John-Software/target", SENTINEL_HASH, configs, "present")).toMatchObject({ dedupeKeyPrefix: "sentinel-" });
    expect(vi.mocked(log.warn)).not.toHaveBeenCalled();
  });

  it("refuses a token whose declarer does not list the path repo", () => {
    const configs = [
      entry("St-John-Software/sentinel", filer(SENTINEL_HASH, "sentinel-", ["St-John-Software/fleet-infra"])),
      entry("St-John-Software/target", null),
    ];
    expect(resolveIssueFiler("St-John-Software/target", SENTINEL_HASH, configs, "present")).toBeNull();
  });

  it("lets a declarer with no repos cover only itself", () => {
    const configs = [
      entry("St-John-Software/growth-engine", filer(GROWTH_HASH, "site-review-")),
      entry("St-John-Software/target", null),
    ];
    expect(resolveIssueFiler("St-John-Software/growth-engine", GROWTH_HASH, configs, "present")).toMatchObject({ declaredBy: "St-John-Software/growth-engine" });
    expect(resolveIssueFiler("St-John-Software/target", GROWTH_HASH, configs, "present")).toBeNull();
  });

  it("refuses a hash no filer declares, and an empty hash", () => {
    const configs = [entry("St-John-Software/sentinel", filer(SENTINEL_HASH, "sentinel-", ["St-John-Software/*"]))];
    expect(resolveIssueFiler("St-John-Software/sentinel", OTHER_HASH, configs, "present")).toBeNull();
    expect(resolveIssueFiler("St-John-Software/sentinel", "", configs, "present")).toBeNull();
  });
});
