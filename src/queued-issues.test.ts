import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("./config.js", () => ({
  DB_PATH: ":memory:",
  DATABASE_URL: "",
  DATABASE_PASSWORD: "",
  DASHBOARD_URL: "https://claws.example.invalid",
  LABELS: { duplicate: "Duplicate", blocked: "Blocked" },
  isAgentDisabled: () => false,
}));

vi.mock("./log.js", () => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

import * as db from "./db.js";
import { blockClawsIssue, closeDb, createClawsIssueLink, initDb, markClawsIssueLinksReleased, setIssueBlockedReason } from "./db.js";
import * as claws from "./claws-issues.js";
import * as log from "./log.js";
import { dependencyParkReason } from "./blocked-reason.js";
import { prWaitReason } from "./pr-wait-park.js";
import { issuesQueued } from "./queued-issues.js";

const REPO = "org/a";

async function issue(title: string, opts: { labels?: string[]; body?: string } = {}): Promise<string> {
  return await claws.createIssue({ title, authorLogin: "stjohnb", repos: [REPO], labels: opts.labels, body: opts.body });
}

async function dependsOn(source: string, target: string): Promise<void> {
  await createClawsIssueLink({ sourceId: source, targetId: target, kind: "depends_on", createdBy: "x", actingId: source });
}

beforeEach(async () => {
  await initDb();
  vi.clearAllMocks();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await closeDb();
});

describe("issuesQueued (#clw_01M64CH10AK2PKH1JDGTB3FBMJ)", () => {
  it("queues a PR-wait park with its stored reason", async () => {
    const a = await issue("A");
    const reason = prWaitReason([{ repo: REPO, number: 4 }]);
    await blockClawsIssue(a, reason);
    expect(await issuesQueued([a])).toEqual(new Map([[a, reason]]));
  });

  it("queues a link park while a dependency is open, naming the open ones", async () => {
    const a = await issue("A");
    const b = await issue("B");
    const c = await issue("C");
    await dependsOn(a, b);
    await dependsOn(a, c);
    await blockClawsIssue(a, dependencyParkReason([{ id: b, title: "B" }]));
    expect(await issuesQueued([a])).toEqual(new Map([[a, dependencyParkReason([{ id: b, title: "B" }, { id: c, title: "C" }])]]));
    await claws.closeIssue(REPO, b, "completed");
    expect(await issuesQueued([a])).toEqual(new Map([[a, dependencyParkReason([{ id: c, title: "C" }])]]));
  });

  it("keeps a link park Queued with its stored reason once every dependency closed but the sweep has not run", async () => {
    const a = await issue("A");
    const b = await issue("B");
    await dependsOn(a, b);
    const stored = dependencyParkReason([{ id: b, title: "B" }]);
    await blockClawsIssue(a, stored);
    await claws.closeIssue(REPO, b, "completed");
    expect(await issuesQueued([a])).toEqual(new Map([[a, stored]]));
  });

  it("leaves a link park in Blocked once its links are released, since no sweep will release it", async () => {
    const a = await issue("A");
    const b = await issue("B");
    await dependsOn(a, b);
    await blockClawsIssue(a, dependencyParkReason([{ id: b, title: "B" }]));
    await markClawsIssueLinksReleased(a);
    expect(await issuesQueued([a])).toEqual(new Map());
  });

  it("leaves an alert issue in Blocked: the sweep never releases it", async () => {
    const a = await issue("Alert", { labels: ["alert"] });
    const b = await issue("B");
    await dependsOn(a, b);
    await blockClawsIssue(a, dependencyParkReason([{ id: b, title: "B" }]));
    expect(await issuesQueued([a])).toEqual(new Map());
  });

  it("leaves an operator's re-block in Blocked even while a dependency is open", async () => {
    const a = await issue("A");
    const b = await issue("B");
    await dependsOn(a, b);
    await blockClawsIssue(a, dependencyParkReason([{ id: b, title: "B" }]));
    await setIssueBlockedReason(a, "Needs the operator to rotate the key first");
    expect(await issuesQueued([a])).toEqual(new Map());
  });

  it("leaves a shadow with a link reason in Blocked", async () => {
    const a = await issue("A");
    const b = await issue("B");
    await dependsOn(a, b);
    await blockClawsIssue(a, dependencyParkReason([{ id: b, title: "B" }]));
    const record = (await db.getClawsIssue(a))!;
    vi.spyOn(db, "getClawsIssue").mockResolvedValue({ ...record, kind: "shadow" });
    expect(await issuesQueued([a])).toEqual(new Map());
  });

  it("answers an empty map, and logs, when a read fails", async () => {
    const a = await issue("A");
    await blockClawsIssue(a, prWaitReason([{ repo: REPO, number: 4 }]));
    vi.spyOn(db, "getIssueBlockedReasons").mockRejectedValueOnce(new Error("db down"));
    expect(await issuesQueued([a])).toEqual(new Map());
    expect(vi.mocked(log.warn)).toHaveBeenCalledWith(expect.stringContaining("[queued-issues]"));
  });
});

describe("listUnreleasedDependencyTargets", () => {
  it("lists each source's unreleased depends_on targets with whether they are open", async () => {
    const a = await issue("A");
    const b = await issue("B");
    const c = await issue("C");
    const d = await issue("D");
    await dependsOn(a, b);
    await dependsOn(a, c);
    await createClawsIssueLink({ sourceId: d, targetId: b, kind: "relates_to", createdBy: "x", actingId: d });
    await claws.closeIssue(REPO, c, "completed");
    const out = await db.listUnreleasedDependencyTargets([a, d]);
    expect(out).toEqual(new Map([[a, [{ id: b, title: "B", open: true }, { id: c, title: "C", open: false }]]]));
    await markClawsIssueLinksReleased(a);
    expect(await db.listUnreleasedDependencyTargets([a])).toEqual(new Map());
    expect(await db.listUnreleasedDependencyTargets([])).toEqual(new Map());
  });
});
