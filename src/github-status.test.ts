import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./log.js", () => ({
  warn: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
}));

const mockNotify = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock("./slack.js", () => ({
  notify: mockNotify,
}));

import {
  refreshGitHubStatus,
  getGitHubStatusSnapshot,
  isGitHubDegraded,
  getRecentDegradedWindows,
  __resetGitHubStatusForTests,
} from "./github-status.js";
import * as log from "./log.js";

function makeResponse(opts: { ok: boolean; status?: number; body: unknown }): Response {
  return {
    ok: opts.ok,
    status: opts.status ?? (opts.ok ? 200 : 500),
    json: async () => opts.body,
  } as unknown as Response;
}

const OPERATIONAL_PAYLOAD = {
  status: { indicator: "none", description: "All Systems Operational" },
  components: [
    { name: "Git Operations", status: "operational" },
    { name: "API Requests", status: "operational" },
    { name: "Webhooks", status: "operational" },
    { name: "Issues", status: "operational" },
    { name: "Pull Requests", status: "operational" },
    { name: "Actions", status: "operational" },
    { name: "Copilot", status: "operational" },
  ],
  incidents: [],
};

function degradedPayload(overrides: Partial<typeof OPERATIONAL_PAYLOAD> = {}) {
  return {
    status: { indicator: "major", description: "Partially Degraded Service" },
    components: [
      { name: "Git Operations", status: "operational" },
      { name: "API Requests", status: "degraded_performance" },
      { name: "Webhooks", status: "operational" },
      { name: "Issues", status: "operational" },
      { name: "Pull Requests", status: "operational" },
      { name: "Actions", status: "operational" },
    ],
    incidents: [
      {
        name: "Incident with API Requests",
        status: "investigating",
        impact: "major",
        shortlink: "https://stspg.io/abc123",
      },
    ],
    ...overrides,
  };
}

describe("github-status", () => {
  beforeEach(() => {
    __resetGitHubStatusForTests();
    globalThis.fetch = vi.fn();
    vi.clearAllMocks();
  });

  it("marks not degraded for an operational payload", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(makeResponse({ ok: true, body: OPERATIONAL_PAYLOAD }));

    await refreshGitHubStatus();

    const snap = getGitHubStatusSnapshot();
    expect(snap.degraded).toBe(false);
    expect(isGitHubDegraded()).toBe(false);
  });

  it("marks degraded when a depended-on component is non-operational, notifying once", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(makeResponse({ ok: true, body: degradedPayload() }));

    await refreshGitHubStatus();

    const snap = getGitHubStatusSnapshot();
    expect(snap.degraded).toBe(true);
    expect(snap.degradedComponents).toEqual(["API Requests (degraded_performance)"]);
    expect(isGitHubDegraded()).toBe(true);
    expect(mockNotify).toHaveBeenCalledTimes(1);
    expect(mockNotify).toHaveBeenCalledWith(expect.stringContaining("GitHub is reporting an incident"));
  });

  it("does not notify again on a second identical degraded refresh", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(makeResponse({ ok: true, body: degradedPayload() }));

    await refreshGitHubStatus();
    await refreshGitHubStatus();

    expect(mockNotify).toHaveBeenCalledTimes(1);
  });

  it("notifies once on recovery and stays degraded through the grace window", async () => {
    vi.useFakeTimers();
    try {
      vi.mocked(globalThis.fetch).mockResolvedValue(makeResponse({ ok: true, body: degradedPayload() }));
      await refreshGitHubStatus();
      expect(mockNotify).toHaveBeenCalledTimes(1);

      vi.mocked(globalThis.fetch).mockResolvedValue(makeResponse({ ok: true, body: OPERATIONAL_PAYLOAD }));
      await refreshGitHubStatus();

      expect(mockNotify).toHaveBeenCalledTimes(2);
      expect(mockNotify).toHaveBeenLastCalledWith(expect.stringContaining("back to normal"));
      // Snapshot itself is no longer degraded...
      expect(getGitHubStatusSnapshot().degraded).toBe(false);
      // ...but isGitHubDegraded() still suppresses within the recovery grace window.
      expect(isGitHubDegraded()).toBe(true);

      vi.advanceTimersByTime(11 * 60 * 1000);
      expect(isGitHubDegraded()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("sets lastError and does not throw on a non-200 response", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(makeResponse({ ok: false, status: 503, body: {} }));

    await expect(refreshGitHubStatus()).resolves.toBeUndefined();

    const snap = getGitHubStatusSnapshot();
    expect(snap.lastError).toBeTruthy();
    expect(snap.checkedAt).toBeNull();
    expect(log.error).not.toHaveBeenCalled();
  });

  it("sets lastError and does not throw on a rejected fetch", async () => {
    vi.mocked(globalThis.fetch).mockRejectedValue(new Error("network down"));

    await expect(refreshGitHubStatus()).resolves.toBeUndefined();

    const snap = getGitHubStatusSnapshot();
    expect(snap.lastError).toBeTruthy();
    expect(log.error).not.toHaveBeenCalled();
  });

  it("does not treat a Copilot-only degradation as degraded", async () => {
    const payload = {
      status: { indicator: "minor", description: "Partially Degraded Service" },
      components: [
        { name: "Git Operations", status: "operational" },
        { name: "API Requests", status: "operational" },
        { name: "Webhooks", status: "operational" },
        { name: "Issues", status: "operational" },
        { name: "Pull Requests", status: "operational" },
        { name: "Actions", status: "operational" },
        { name: "Copilot", status: "degraded_performance" },
      ],
      incidents: [],
    };
    vi.mocked(globalThis.fetch).mockResolvedValue(makeResponse({ ok: true, body: payload }));

    await refreshGitHubStatus();

    const snap = getGitHubStatusSnapshot();
    expect(snap.degraded).toBe(false);
    expect(isGitHubDegraded()).toBe(false);
    expect(mockNotify).not.toHaveBeenCalled();
  });

  describe("getRecentDegradedWindows", () => {
    it("is empty when GitHub has never been degraded", async () => {
      vi.mocked(globalThis.fetch).mockResolvedValue(makeResponse({ ok: true, body: OPERATIONAL_PAYLOAD }));
      await refreshGitHubStatus();

      expect(getRecentDegradedWindows()).toEqual([]);
    });

    it("opens an ongoing window when GitHub goes degraded", async () => {
      vi.useFakeTimers();
      try {
        vi.mocked(globalThis.fetch).mockResolvedValue(makeResponse({ ok: true, body: degradedPayload() }));
        await refreshGitHubStatus();
        const firstCheckedAt = getGitHubStatusSnapshot().checkedAt;

        // A later poll refreshes checkedAt but must not move the open window's start.
        vi.advanceTimersByTime(60_000);
        await refreshGitHubStatus();

        const windows = getRecentDegradedWindows();
        expect(windows).toHaveLength(1);
        expect(windows[0].startedAt).toBe(firstCheckedAt);
        expect(getGitHubStatusSnapshot().checkedAt).not.toBe(firstCheckedAt);
        expect(windows[0].endedAt).toBeNull();
      } finally {
        vi.useRealTimers();
      }
    });

    it("closes the window at the end of the recovery grace period", async () => {
      vi.useFakeTimers();
      try {
        vi.mocked(globalThis.fetch).mockResolvedValue(makeResponse({ ok: true, body: degradedPayload() }));
        await refreshGitHubStatus();

        vi.mocked(globalThis.fetch).mockResolvedValue(makeResponse({ ok: true, body: OPERATIONAL_PAYLOAD }));
        await refreshGitHubStatus();

        const windows = getRecentDegradedWindows();
        expect(windows).toHaveLength(1);
        expect(windows[0].endedAt).not.toBeNull();
        // The grace window is still incident time, so the window closes in the future.
        expect(Date.parse(windows[0].endedAt!)).toBeGreaterThan(Date.now());
      } finally {
        vi.useRealTimers();
      }
    });

    it("excludes a window that closed before the cutoff", async () => {
      vi.useFakeTimers();
      try {
        vi.mocked(globalThis.fetch).mockResolvedValue(makeResponse({ ok: true, body: degradedPayload() }));
        await refreshGitHubStatus();
        vi.mocked(globalThis.fetch).mockResolvedValue(makeResponse({ ok: true, body: OPERATIONAL_PAYLOAD }));
        await refreshGitHubStatus();

        expect(getRecentDegradedWindows()).toHaveLength(1);

        vi.advanceTimersByTime(25 * 60 * 60 * 1000);
        expect(getRecentDegradedWindows()).toEqual([]);
        // A wider lookback still finds it.
        expect(getRecentDegradedWindows(48 * 60 * 60 * 1000)).toHaveLength(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it("is cleared by __resetGitHubStatusForTests", async () => {
      vi.mocked(globalThis.fetch).mockResolvedValue(makeResponse({ ok: true, body: degradedPayload() }));
      await refreshGitHubStatus();
      expect(getRecentDegradedWindows()).toHaveLength(1);

      __resetGitHubStatusForTests();
      expect(getRecentDegradedWindows()).toEqual([]);
    });
  });
});
