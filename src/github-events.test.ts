import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

vi.mock("./log.js", () => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

import { createSqliteDriver, type SqlDriver } from "./db-driver.js";
import {
  CLAWS_EVENTS_DDL,
  recordGitHubEvent,
  waitForEvents,
  getEventsSince,
  currentEventId,
  extractRelatedNumbers,
  flushGitHubEvents,
  parseKindFilter,
  resolveAllWaiters,
  resetGitHubEventsForTest,
  setGitHubEventsDriver,
} from "./github-events.js";

/** Only the timers a waiter uses; the outbox drain runs on `setImmediate`. */
const WAITER_TIMERS: Parameters<typeof vi.useFakeTimers>[0] = { toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] };

describe("github-events", () => {
  let base: number;

  beforeEach(async () => {
    await resetGitHubEventsForTest();
    // Ids are the table's autoincrement and are never reused, so assert relative to it.
    base = await currentEventId();
  });

  afterEach(async () => {
    vi.useRealTimers();
    await resetGitHubEventsForTest();
  });

  it("returns immediately when events already exist past the cursor", async () => {
    recordGitHubEvent({ kind: "issue-comment", repo: "org/repo", number: 1, related: [] });
    const res = await waitForEvents(base, { repo: "org/repo" }, 10_000);
    expect(res.restarted).toBe(false);
    expect(res.events).toHaveLength(1);
    expect(res.events[0]).toMatchObject({ id: base + 1, kind: "issue-comment", repo: "org/repo", number: 1, related: [] });
    expect(res.lastId).toBe(base + 1);
    expect(res.bootId).toBe("db");
  });

  it("resolves a waiter as soon as a matching event is recorded", async () => {
    const pending = waitForEvents(undefined, { repo: "org/repo", items: [7] }, 10_000);
    // Let the waiter read its starting cursor first.
    await new Promise((resolve) => setTimeout(resolve, 20));
    const started = Date.now();
    recordGitHubEvent({ kind: "label-added", repo: "org/repo", number: 7, related: [], detail: "Refined" });
    const res = await pending;
    expect(Date.now() - started).toBeLessThan(900);
    expect(res.events).toHaveLength(1);
    expect(res.events[0]?.kind).toBe("label-added");
    expect(res.events[0]?.detail).toBe("Refined");
    expect(res.lastId).toBe(base + 1);
  });

  it("does not resolve a waiter for a non-matching event", async () => {
    vi.useFakeTimers(WAITER_TIMERS);
    let settled = false;
    const pending = waitForEvents(undefined, { repo: "org/repo", items: [7] }, 10_000).then((r) => {
      settled = true;
      return r;
    });
    await vi.advanceTimersByTimeAsync(1);
    recordGitHubEvent({ kind: "label-added", repo: "org/other", number: 7, related: [] });
    recordGitHubEvent({ kind: "label-added", repo: "org/repo", number: 8, related: [] });
    await flushGitHubEvents();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(10_000);
    const res = await pending;
    expect(res.events).toEqual([]);
    // The cursor moves past the events it skipped.
    expect(res.lastId).toBe(base + 2);
  });

  it("resolves empty when the timeout expires", async () => {
    vi.useFakeTimers(WAITER_TIMERS);
    const pending = waitForEvents(undefined, {}, 5_000);
    await vi.advanceTimersByTimeAsync(5_000);
    const res = await pending;
    expect(res).toMatchObject({ restarted: false, events: [], lastId: base });
  });

  it("reports restarted when the cursor is beyond the current id", async () => {
    recordGitHubEvent({ kind: "pr-merged", repo: "org/repo", number: 3, related: [] });
    const res = await waitForEvents(base + 99, {}, 10_000);
    expect(res.restarted).toBe(true);
    expect(res.events).toEqual([]);
    expect(res.lastId).toBe(base + 1);
  });

  it("returns at most 100 events, oldest first, and pages past non-matching rows", async () => {
    for (let i = 0; i < 600; i++) {
      recordGitHubEvent({ kind: "issue-comment", repo: "org/repo", number: i + 1, related: [] });
    }
    recordGitHubEvent({ kind: "issue-comment", repo: "org/repo", number: 9999, related: [] });
    expect(await getEventsSince(base, {})).toHaveLength(100);
    expect((await getEventsSince(base, {}))[0]?.id).toBe(base + 1);
    expect(await currentEventId()).toBe(base + 601);
    // The item filter runs in JS, so the match beyond the first page must still be found.
    expect((await getEventsSince(base, { items: [9999] })).map((e) => e.number)).toEqual([9999]);
  });

  it("matches an item filter via the related list", async () => {
    const pending = waitForEvents(undefined, { repo: "org/repo", items: [100] }, 10_000);
    await new Promise((resolve) => setTimeout(resolve, 20));
    recordGitHubEvent({ kind: "pr-opened", repo: "org/repo", number: 101, related: [100] });
    const res = await pending;
    expect(res.events[0]?.number).toBe(101);
  });

  it("filters by kind", async () => {
    recordGitHubEvent({ kind: "issue-comment", repo: "org/repo", number: 1, related: [] });
    recordGitHubEvent({ kind: "pr-merged", repo: "org/repo", number: 2, related: [] });
    expect(await getEventsSince(base, { kinds: ["pr-merged"] })).toHaveLength(1);
  });

  it("resolveAllWaiters settles pending long-polls", async () => {
    const pending = waitForEvents(undefined, {}, 60_000);
    await new Promise((resolve) => setTimeout(resolve, 20));
    resolveAllWaiters();
    expect((await pending).events).toEqual([]);
  });

  it("marks waits settled by resolveAllWaiters, and later ones, as interrupted", async () => {
    const pending = waitForEvents(undefined, {}, 60_000);
    await new Promise((resolve) => setTimeout(resolve, 20));
    resolveAllWaiters();
    expect(await pending).toMatchObject({ interrupted: true, restarted: false, events: [] });
    const started = Date.now();
    expect(await waitForEvents(undefined, {}, 60_000)).toMatchObject({ interrupted: true, events: [] });
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("a timed-out wait is not interrupted", async () => {
    expect((await waitForEvents(undefined, {}, 0)).interrupted).toBeUndefined();
  });

  describe("detail filters (#clw_01M5Q66MKK4WHBJ8XT1EMZZGEA)", () => {
    it("parses kind and kind:detail entries, refusing unknown kinds and empty details", () => {
      expect(parseKindFilter("task-failed")).toEqual({ kind: "task-failed" });
      expect(parseKindFilter("task-completed:pr-reviewer")).toEqual({ kind: "task-completed", detail: "pr-reviewer" });
      expect(parseKindFilter("issue-comment:a:b")).toEqual({ kind: "issue-comment", detail: "a:b" });
      expect(parseKindFilter("ci-status:failing")).toEqual({ kind: "ci-status", detail: "failing" });
      expect(parseKindFilter("forge-review")).toEqual({ kind: "forge-review" });
      expect(parseKindFilter("bogus")).toBeNull();
      expect(parseKindFilter("bogus:x")).toBeNull();
      expect(parseKindFilter("task-failed:")).toBeNull();
    });

    it("task-completed:pr-reviewer ignores other jobs' completions and matches the reviewer's", async () => {
      recordGitHubEvent({ kind: "task-completed", repo: "o/r", number: 3, related: [], detail: "pr-merger" });
      const filter = { kinds: [{ kind: "task-completed" as const, detail: "pr-reviewer" }] };
      expect(await getEventsSince(base, filter)).toEqual([]);
      recordGitHubEvent({ kind: "task-completed", repo: "o/r", number: 3, related: [], detail: "pr-reviewer" });
      expect((await getEventsSince(base, filter)).map((e) => e.detail)).toEqual(["pr-reviewer"]);
    });

    it("a waiter filtered on a detail is not woken by another detail of the same kind", async () => {
      vi.useFakeTimers(WAITER_TIMERS);
      const pending = waitForEvents(base, { kinds: [{ kind: "task-completed", detail: "pr-reviewer" }] }, 60_000);
      recordGitHubEvent({ kind: "task-completed", repo: "o/r", number: 3, related: [], detail: "ci-fixer" });
      await flushGitHubEvents();
      await vi.advanceTimersByTimeAsync(5_000);
      recordGitHubEvent({ kind: "task-completed", repo: "o/r", number: 3, related: [], detail: "pr-reviewer" });
      await flushGitHubEvents();
      await vi.advanceTimersByTimeAsync(2_000);
      expect((await pending).events.map((e) => e.detail)).toEqual(["pr-reviewer"]);
    });

    it("a bare task-failed matches a failure of any task, and task-failed:<job> only that job's", async () => {
      recordGitHubEvent({ kind: "task-failed", repo: "o/r", number: 3, related: [], detail: "pr-reviewer: boom" });
      recordGitHubEvent({ kind: "task-failed", repo: "o/r", number: 3, related: [], detail: "ci-fixer: bang" });
      expect(await getEventsSince(base, { kinds: ["task-failed"] })).toHaveLength(2);
      expect((await getEventsSince(base, { kinds: [{ kind: "task-failed", detail: "ci-fixer" }] })).map((e) => e.detail)).toEqual(["ci-fixer: bang"]);
    });

    it("stage-changed:awaiting-merge matches only moves into awaiting-merge", async () => {
      recordGitHubEvent({ kind: "stage-changed", repo: "o/r", number: 3, related: [], detail: "planning->approved" });
      recordGitHubEvent({ kind: "stage-changed", repo: "o/r", number: 3, related: [], detail: "awaiting-merge->approved" });
      recordGitHubEvent({ kind: "stage-changed", repo: "o/r", number: 3, related: [], detail: "approved->awaiting-merge" });
      expect((await getEventsSince(base, { kinds: [{ kind: "stage-changed", detail: "awaiting-merge" }] })).map((e) => e.detail))
        .toEqual(["approved->awaiting-merge"]);
    });

    it("mixes bare and detailed entries, and bare kinds behave as before", async () => {
      recordGitHubEvent({ kind: "pr-merged", repo: "o/r", number: 4, related: [] });
      recordGitHubEvent({ kind: "review-posted", repo: "o/r", number: 4, related: [], detail: "blocking" });
      recordGitHubEvent({ kind: "review-posted", repo: "o/r", number: 4, related: [], detail: "clean" });
      recordGitHubEvent({ kind: "label-added", repo: "o/r", number: 4, related: [], detail: "Refined" });
      expect((await getEventsSince(base, { kinds: ["pr-merged", { kind: "review-posted", detail: "clean" }] })).map((e) => e.kind))
        .toEqual(["pr-merged", "review-posted"]);
      expect(await getEventsSince(base, { repo: "o/r", items: [4], kinds: ["label-added"] })).toHaveLength(1);
      expect(await getEventsSince(base, {})).toHaveLength(4);
    });
  });

  it("extractRelatedNumbers dedupes and caps at 10", () => {
    expect(extractRelatedNumbers("Closes #12, see #12 and #34")).toEqual([12, 34]);
    expect(extractRelatedNumbers("")).toEqual([]);
    const many = Array.from({ length: 20 }, (_, i) => `#${i + 1}`).join(" ");
    expect(extractRelatedNumbers(many)).toHaveLength(10);
  });

  it("extractRelatedNumbers canonicalises Claws-native references", () => {
    const native = "clw_01JBQ7X4M2K8NV3TYRW9GZ5PDC";
    expect(extractRelatedNumbers(`Closes #${native.toLowerCase()} and #7`)).toEqual([native, 7]);
  });

  it("a waiter on a native reference is woken by an event that mentions it", async () => {
    const native = "clw_01JBQ7X4M2K8NV3TYRW9GZ5PDC";
    recordGitHubEvent({ kind: "pr-opened", repo: "org/a", number: 11, related: extractRelatedNumbers(`Closes #${native}`) });

    expect(await getEventsSince(base, { items: [native] })).toHaveLength(1);
    expect(await getEventsSince(base, { items: ["clw_01JBQ7X4M2K8NV3TYRW9GZ5PDD"] })).toHaveLength(0);
  });

  describe("across processes", () => {
    let dir: string;
    let mine: SqlDriver;
    let other: SqlDriver;

    beforeEach(async () => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), "claws-events-"));
      const file = path.join(dir, "claws.db");
      mine = createSqliteDriver(file);
      await mine.exec(CLAWS_EVENTS_DDL);
      other = createSqliteDriver(file);
      setGitHubEventsDriver(mine);
    });

    afterEach(async () => {
      resolveAllWaiters();
      setGitHubEventsDriver(null);
      await mine.close();
      await other.close();
      fs.rmSync(dir, { recursive: true, force: true });
    });

    it("wakes a waiter with an event another process stored, within a poll", async () => {
      const pending = waitForEvents(undefined, { items: [5] }, 10_000);
      await new Promise((resolve) => setTimeout(resolve, 20));
      await other.run(
        `INSERT INTO claws_events (at, kind, repo, number, related_json, detail) VALUES (?, ?, ?, ?, ?, ?)`,
        [new Date().toISOString(), "issue-closed", "org/repo", "5", "[]", null],
      );
      const started = Date.now();
      const res = await pending;
      expect(Date.now() - started).toBeLessThan(2_000);
      expect(res.events.map((e) => [e.kind, e.number])).toEqual([["issue-closed", 5]]);
    });

    it("keeps events recorded before a driver is registered and stores them once one is", async () => {
      setGitHubEventsDriver(null);
      expect(() => recordGitHubEvent({ kind: "task-started", repo: "org/repo", number: "clw_01JBQ7X4M2K8NV3TYRW9GZ5PDC", related: [7], detail: "planner" })).not.toThrow();
      setGitHubEventsDriver(mine);
      const events = await getEventsSince(0, {});
      expect(events).toEqual([expect.objectContaining({ kind: "task-started", number: "clw_01JBQ7X4M2K8NV3TYRW9GZ5PDC", related: [7], detail: "planner" })]);
      // Another process reads the same row.
      expect((await other.all<{ kind: string }>(`SELECT kind FROM claws_events`)).map((r) => r.kind)).toEqual(["task-started"]);
    });
  });
});
