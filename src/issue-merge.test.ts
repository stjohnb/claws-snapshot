import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("./config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./config.js")>()),
  DB_PATH: ":memory:",
  DATABASE_URL: "",
  DATABASE_PASSWORD: "",
  ATTACHMENTS_S3: null,
  getAutoPromotePolicy: () => ({}),
  isAgentDisabled: () => false,
}));

vi.mock("./log.js", () => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  runContext: { getStore: () => undefined, run: (_ctx: unknown, fn: () => unknown) => fn() },
}));

const { mockOpenPhasePRs } = vi.hoisted(() => ({ mockOpenPhasePRs: vi.fn() }));
vi.mock("./planned-prs.js", () => ({ listOpenPhasePRs: mockOpenPhasePRs }));

// Native issues only: the façade's calls go straight to the native tracker.
vi.mock("./github.js", async () => {
  const native = await import("./claws-issues.js");
  return {
    isNativeIssue: (ref: unknown) => typeof ref === "string" && ref.toLowerCase().startsWith("clw_"),
    getIssueBody: (_repo: string, id: string) => native.getIssueBody(id),
    editIssue: (_repo: string, id: string, body: string) => native.editIssue(id, body),
    commentOnIssue: (repo: string, id: string, body: string) => native.commentOnIssue(repo, id, body, native.CLAWS_NATIVE_LOGIN),
    getIssueComments: (_repo: string, id: string) => native.getIssueComments(id),
  };
});
vi.mock("./worker.js", () => ({ enqueue: vi.fn(), AGENT_KINDS: { ISSUE_REFINER_REPLAN: "work:issue-refiner:replan" } }));
vi.mock("./jobs/issue-importer.js", () => ({ importRepo: vi.fn() }));

import * as log from "./log.js";
import { initDb, closeDb, createClawsIssue, createShadowIssue, getClawsIssue, setClawsIssueState } from "./db.js";
import { resetGitHubEventsForTest } from "./github-events.js";
import * as clawsIssues from "./claws-issues.js";
import { registry, resetMetricsForTests } from "./metrics.js";
import { mergeDuplicateInto, mergedDuplicateMarker } from "./issue-merge.js";
import { routeDirectAlerts, type PolledBridge } from "./alert-bridge.js";

const REPO = "St-John-Software/production-infra";
const OTHER = "St-John-Software/fleet-infra";
const BRIDGE: PolledBridge = {
  repo: REPO, label: "alert", title: "[Alert] production-infra alerts firing",
  poll: { cluster: "prod", datasourceUid: "alertmanager", mode: "direct", source: "alertmanager", maxNewIssuesPerPoll: 3, ignoreAlertnames: [] },
};

const block = (prose: string, first: string, last: string, count: number, alerts: string[]) =>
  [prose, "", "---", `**Alerts:** ${alerts.join(", ")}`, `**First seen:** ${first}`, `**Last seen:** ${last}`, `**Occurrences:** ${count}`].join("\n");

async function issue(title: string, opts: { key?: string; repos?: string[]; body?: string } = {}): Promise<string> {
  return createClawsIssue({ title, body: opts.body ?? "", authorLogin: "claws", repos: opts.repos ?? [REPO], dedupeKey: opts.key });
}

async function movesCounted(): Promise<number> {
  const metric = (await registry.getMetricsAsJSON()).find((m) => m.name === "claws_dedupe_key_moves_total");
  return (metric?.values as { labels: { reason?: string }; value: number }[] | undefined)?.find((v) => v.labels.reason === "merge")?.value ?? 0;
}

beforeEach(async () => {
  vi.clearAllMocks();
  resetMetricsForTests();
  await initDb();
  await resetGitHubEventsForTest();
  mockOpenPhasePRs.mockResolvedValue([]);
});

afterEach(async () => {
  await closeDb();
});

describe("mergeDuplicateInto", () => {
  it("moves the keys, folds the occurrence block and comments once on the survivor", async () => {
    const target = await issue("Disk full", { key: "alert-service-disk", body: block("Disk.", "2026-11-02T00:00:00Z", "2026-11-04T00:00:00Z", 2, ["DiskFull"]) });
    const source = await issue("Disk pressure", { key: "alert-service-node", body: block("Node.", "2026-11-01T00:00:00Z", "2026-11-05T00:00:00Z", 3, ["DiskPressure"]) });

    const res = await mergeDuplicateInto(source, target);

    expect(res).toEqual({ ok: true, repo: REPO, keys: ["alert-service-node"], bodyMerged: true });
    expect((await getClawsIssue(source))!.dedupe_keys).toEqual([]);
    const kept = (await getClawsIssue(target))!;
    expect([...kept.dedupe_keys].sort()).toEqual(["alert-service-disk", "alert-service-node"]);
    expect(kept.body).toBe(block("Disk.", "2026-11-01T00:00:00Z", "2026-11-05T00:00:00Z", 5, ["DiskFull", "DiskPressure"]));
    const comments = await clawsIssues.getIssueComments(target);
    expect(comments).toHaveLength(1);
    expect(comments[0]!.body).toContain(`#${source}`);
    expect(comments[0]!.body).toContain("`alert-service-node`");
    expect(comments[0]!.body).toContain(mergedDuplicateMarker(source));
    expect(log.info).toHaveBeenCalledWith("[issue-merge] dedupe keys moved", { from: source, to: target, keys: ["alert-service-node"] });
    expect(await movesCounted()).toBe(1);

    // A retry (the caller's close failed) moves and folds nothing again.
    expect(await mergeDuplicateInto(source, target)).toEqual({ ok: true, repo: REPO, keys: [], bodyMerged: false });
    expect((await getClawsIssue(target))!.body).toBe(kept.body);
    expect(await clawsIssues.getIssueComments(target)).toHaveLength(1);
  });

  it("writes nothing when the source holds no key and no occurrence block", async () => {
    const target = await issue("Kept", { body: "Prose." });
    const source = await issue("Dup", { body: "Other prose." });
    expect(await mergeDuplicateInto(source, target)).toEqual({ ok: true, repo: REPO, keys: [], bodyMerged: false });
    expect((await getClawsIssue(target))!.body).toBe("Prose.");
    expect(await clawsIssues.getIssueComments(target)).toEqual([]);
    expect(log.info).not.toHaveBeenCalledWith("[issue-merge] dedupe keys moved", expect.anything());
  });

  describe("guards", () => {
    async function expectRefused(source: string, target: string, why: RegExp, holdsKeys = true) {
      const before = (await getClawsIssue(source))?.dedupe_keys ?? [];
      const res = await mergeDuplicateInto(source, target);
      expect(res).toEqual({ ok: false, reason: expect.stringMatching(why), sourceHoldsKeys: holdsKeys });
      expect((await getClawsIssue(source))?.dedupe_keys ?? []).toEqual(before);
    }

    it("refuses the same issue", async () => {
      const a = await issue("A", { key: "alert-a" });
      await expectRefused(a, a, /itself/);
    });

    it("refuses an unknown or shadow issue on either side", async () => {
      const a = await issue("A", { key: "alert-a" });
      const shadow = (await createShadowIssue(REPO, 11, { title: "Forge", authorLogin: "someone" }))!.id;
      await expectRefused(a, shadow, /not a Claws-native issue/);
      await expectRefused(a, "clw_01M7554EZ4SGZQHDHWTAEQW2ZZ", /not a Claws-native issue/);
      await expectRefused(shadow, a, /not a Claws-native issue/, false);
    });

    it("refuses a closed target", async () => {
      const a = await issue("A", { key: "alert-a" });
      const b = await issue("B");
      await setClawsIssueState(b, "closed", "completed");
      await expectRefused(a, b, /is closed/);
    });

    it("refuses issues with different primary repos", async () => {
      const a = await issue("A", { key: "alert-a" });
      const b = await issue("B", { repos: [OTHER] });
      await expectRefused(a, b, /different primary repos/);
    });

    it("refuses a source with an open phase PR of its own", async () => {
      const a = await issue("A", { key: "alert-a" });
      const b = await issue("B");
      mockOpenPhasePRs.mockResolvedValue([{ repo: REPO, number: 42, title: "fix", phase: 1 }]);
      await expectRefused(a, b, /open PR of its own \(St-John-Software\/production-infra#42\)/);
      expect(mockOpenPhasePRs).toHaveBeenCalledWith(REPO, a);
    });
  });

  it("routes a later firing of the duplicate's key to the survivor, filing nothing", async () => {
    const target = await issue("Runner evicted", { key: "alert-ci-runner-evicted", body: block("Evicted.", "2026-11-01T00:00:00Z", "2026-11-02T00:00:00Z", 2, ["Workload CI Runner Evicted"]) });
    const source = await issue("Runner OOM", { key: "alert-ci-runner-oom", body: block("OOM.", "2026-11-03T00:00:00Z", "2026-11-03T00:00:00Z", 1, ["CI Runner OOM"]) });
    expect((await mergeDuplicateInto(source, target)).ok).toBe(true);
    await setClawsIssueState(source, "closed", "not_planned");

    const res = await routeDirectAlerts(BRIDGE, [{
      name: "CI Runner OOM",
      severity: "warning",
      summary: "OOM",
      description: "",
      dashboard: "",
      source: "",
      startsAt: "2026-11-05T23:00:00Z",
      instances: [{ key: "i1", startsAt: "2026-11-05T23:00:00Z" }],
      fresh: true,
    }], { dryRun: false, now: "2026-11-06T00:00:00Z" });

    expect(res).toEqual([{ group: "CI Runner OOM", key: "alert-ci-runner-oom", decision: "bump", issue: target }]);
    const kept = (await getClawsIssue(target))!;
    expect(kept.body).toContain("**Occurrences:** 4");
    expect(kept.body).toContain("**Last seen:** 2026-11-06T00:00:00Z");
    expect((await getClawsIssue(source))!.body).toBe(block("OOM.", "2026-11-03T00:00:00Z", "2026-11-03T00:00:00Z", 1, ["CI Runner OOM"]));
  });
});
