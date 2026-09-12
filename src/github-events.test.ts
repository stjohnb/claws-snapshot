import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("./log.js", () => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

import {
  recordGitHubEvent,
  waitForEvents,
  getEventsSince,
  currentEventId,
  extractRelatedNumbers,
  resolveAllWaiters,
  resetGitHubEventsForTest,
} from "./github-events.js";

describe("github-events", () => {
  beforeEach(() => {
    resetGitHubEventsForTest();
  });

  afterEach(() => {
    resetGitHubEventsForTest();
    vi.useRealTimers();
  });

  it("returns immediately when events already exist past the cursor", async () => {
    recordGitHubEvent({ kind: "issue-comment", repo: "org/repo", number: 1, related: [] });
    const res = await waitForEvents(0, { repo: "org/repo" }, 10_000);
    expect(res.restarted).toBe(false);
    expect(res.events).toHaveLength(1);
    expect(res.lastId).toBe(1);
    expect(res.bootId).toMatch(/[0-9a-f-]{36}/);
  });

  it("resolves a waiter as soon as a matching event is recorded", async () => {
    const pending = waitForEvents(undefined, { repo: "org/repo", items: [7] }, 10_000);
    recordGitHubEvent({ kind: "label-added", repo: "org/repo", number: 7, related: [], detail: "Refined" });
    const res = await pending;
    expect(res.events).toHaveLength(1);
    expect(res.events[0]?.kind).toBe("label-added");
    expect(res.events[0]?.detail).toBe("Refined");
  });

  it("does not resolve a waiter for a non-matching event", async () => {
    vi.useFakeTimers();
    let settled = false;
    const pending = waitForEvents(undefined, { repo: "org/repo", items: [7] }, 10_000).then((r) => {
      settled = true;
      return r;
    });
    recordGitHubEvent({ kind: "label-added", repo: "org/other", number: 7, related: [] });
    recordGitHubEvent({ kind: "label-added", repo: "org/repo", number: 8, related: [] });
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(10_000);
    const res = await pending;
    expect(res.events).toEqual([]);
  });

  it("resolves empty when the timeout expires", async () => {
    vi.useFakeTimers();
    const pending = waitForEvents(undefined, {}, 5_000);
    await vi.advanceTimersByTimeAsync(5_000);
    const res = await pending;
    expect(res).toMatchObject({ restarted: false, events: [] });
  });

  it("reports restarted when the cursor is beyond the current id", async () => {
    recordGitHubEvent({ kind: "pr-merged", repo: "org/repo", number: 3, related: [] });
    const res = await waitForEvents(99, {}, 10_000);
    expect(res.restarted).toBe(true);
    expect(res.events).toEqual([]);
    expect(res.lastId).toBe(1);
  });

  it("keeps only the newest 500 events in the ring", () => {
    for (let i = 0; i < 600; i++) {
      recordGitHubEvent({ kind: "issue-comment", repo: "org/repo", number: i + 1, related: [] });
    }
    expect(currentEventId()).toBe(600);
    const all = getEventsSince(0, {});
    // Capped at 100 returned, but the oldest surviving entry proves the trim.
    expect(all[0]?.id).toBe(101);
    expect(all).toHaveLength(100);
  });

  it("matches an item filter via the related list", async () => {
    const pending = waitForEvents(undefined, { repo: "org/repo", items: [100] }, 10_000);
    recordGitHubEvent({ kind: "pr-opened", repo: "org/repo", number: 101, related: [100] });
    const res = await pending;
    expect(res.events[0]?.number).toBe(101);
  });

  it("filters by kind", () => {
    recordGitHubEvent({ kind: "issue-comment", repo: "org/repo", number: 1, related: [] });
    recordGitHubEvent({ kind: "pr-merged", repo: "org/repo", number: 2, related: [] });
    expect(getEventsSince(0, { kinds: ["pr-merged"] })).toHaveLength(1);
  });

  it("resolveAllWaiters settles pending long-polls", async () => {
    const pending = waitForEvents(undefined, {}, 60_000);
    resolveAllWaiters();
    expect((await pending).events).toEqual([]);
  });

  it("extractRelatedNumbers dedupes and caps at 10", () => {
    expect(extractRelatedNumbers("Closes #12, see #12 and #34")).toEqual([12, 34]);
    expect(extractRelatedNumbers("")).toEqual([]);
    const many = Array.from({ length: 20 }, (_, i) => `#${i + 1}`).join(" ");
    expect(extractRelatedNumbers(many)).toHaveLength(10);
  });
});
