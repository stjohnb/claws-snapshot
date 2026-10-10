import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── Hoisted mocks ──

const mockBackupMonitorEnabled = vi.hoisted(() => ({ value: true }));
const mockHaConfigRepo = vi.hoisted(() => ({ value: "St-John-Software/home-assistant-config" as string | undefined }));
const mockFleetInfraRepo = vi.hoisted(() => ({ value: undefined as string | undefined }));

vi.mock("../config.js", () => ({
  get HOME_ASSISTANT_BACKUP_MONITOR_ENABLED() { return mockBackupMonitorEnabled.value; },
  get HOME_ASSISTANT_CONFIG_REPO() { return mockHaConfigRepo.value; },
  get FLEET_INFRA_REPO() { return mockFleetInfraRepo.value; },
  LABELS: { priority: "Priority" },
}));

const mockIsConfigured = vi.hoisted(() => vi.fn(() => true));
const mockListStates = vi.hoisted(() => vi.fn());
vi.mock("../home-assistant.js", () => ({
  isConfigured: mockIsConfigured,
  listStates: mockListStates,
}));

const mockCreateIssue = vi.hoisted(() => vi.fn());
const mockGetIssueBody = vi.hoisted(() => vi.fn());
const mockEditIssue = vi.hoisted(() => vi.fn());
const mockCloseIssue = vi.hoisted(() => vi.fn());
const mockListOpenIssues = vi.hoisted(() => vi.fn());
const mockOpenIssuesMayBeTruncated = vi.hoisted(() => vi.fn());
const mockEditIssueTitle = vi.hoisted(() => vi.fn());
vi.mock("../github.js", () => ({
  createIssue: mockCreateIssue,
  getIssueBody: mockGetIssueBody,
  editIssue: mockEditIssue,
  closeIssue: mockCloseIssue,
  listOpenIssues: mockListOpenIssues,
  openIssuesMayBeTruncated: mockOpenIssuesMayBeTruncated,
  editIssueTitle: mockEditIssueTitle,
}));

vi.mock("../log.js", () => ({
  info: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
  error: vi.fn(),
}));

const unavailStore = vi.hoisted(() => new Map<string, number>());
vi.mock("../db.js", () => ({
  recordHaEntityUnavailable: vi.fn((id: string, now: number) => {
    if (!unavailStore.has(id)) unavailStore.set(id, now);
    return unavailStore.get(id)!;
  }),
  clearHaEntityUnavailable: vi.fn((id: string) => {
    unavailStore.delete(id);
  }),
}));

import {
  run,
  readBackupEvent,
  readOverdue,
  buildFailedBody,
  buildOverdueBody,
  buildBlindBody,
  BLIND_THRESHOLD_MS,
} from "./ha-backup-monitor.js";
import type { HAState } from "../home-assistant.js";
import { __resetOccurrenceTrackingForTests } from "../occurrence-tracking.js";

// occurrence-tracking's per-title lock and recently-created map are real
// module state (only github.js is mocked here), so leftover entries from one
// test's title would otherwise leak into the next test reusing that title.
beforeEach(() => {
  __resetOccurrenceTrackingForTests();
});

const FAILED_TITLE = "[ha-backup-monitor] Home Assistant automatic backup failed";
const OVERDUE_TITLE = "[ha-backup-monitor] Home Assistant backups are overdue";
const BLIND_TITLE = "[ha-backup-monitor] Home Assistant backup monitor is blind — binary_sensor.backup_overdue unavailable";
const REPO = "St-John-Software/home-assistant-config";

function makeEvent(eventType: string | undefined, timestamp: string, failedReason?: string): HAState {
  const attributes: Record<string, unknown> = {};
  if (eventType !== undefined) attributes["event_type"] = eventType;
  if (failedReason !== undefined) attributes["failed_reason"] = failedReason;
  return { entity_id: "event.backup_automatic_backup", state: timestamp, attributes, last_changed: "", last_updated: "" };
}

function makeOverdue(state: string): HAState {
  return { entity_id: "binary_sensor.backup_overdue", state, attributes: {}, last_changed: "", last_updated: "" };
}

function makeLastSuccess(state: string): HAState {
  return { entity_id: "sensor.backup_last_successful_automatic_backup", state, attributes: {}, last_changed: "", last_updated: "" };
}

beforeEach(() => {
  vi.clearAllMocks();
  unavailStore.clear();
  mockBackupMonitorEnabled.value = true;
  mockHaConfigRepo.value = REPO;
  mockFleetInfraRepo.value = undefined;
  mockIsConfigured.mockReturnValue(true);
  mockCreateIssue.mockResolvedValue(undefined);
  mockGetIssueBody.mockResolvedValue("");
  mockEditIssue.mockResolvedValue(undefined);
  mockCloseIssue.mockResolvedValue(undefined);
  mockListOpenIssues.mockResolvedValue([]);
  mockOpenIssuesMayBeTruncated.mockReturnValue(false);
  mockEditIssueTitle.mockResolvedValue(undefined);
});

describe("readBackupEvent", () => {
  it("returns null when entity is absent", () => {
    expect(readBackupEvent([])).toBeNull();
  });

  it("returns null when state is unavailable", () => {
    const s = makeEvent("failed", "2026-08-10T00:00:00+00:00");
    s.state = "unavailable";
    expect(readBackupEvent([s])).toBeNull();
  });

  it("reads eventType and timestamp", () => {
    const info = readBackupEvent([makeEvent("failed", "2026-08-10T17:12:46.406+00:00", "NAS mount unavailable")]);
    expect(info).toEqual({
      eventType: "failed",
      timestamp: "2026-08-10T17:12:46.406+00:00",
      failedReason: "NAS mount unavailable",
    });
  });

  it("failedReason is null when absent", () => {
    const info = readBackupEvent([makeEvent("failed", "2026-08-10T00:00:00+00:00")]);
    expect(info?.failedReason).toBeNull();
  });
});

describe("readOverdue", () => {
  it("returns null when absent", () => {
    expect(readOverdue([])).toBeNull();
  });

  it("returns null when unavailable", () => {
    expect(readOverdue([makeOverdue("unavailable")])).toBeNull();
  });

  it("returns on/off", () => {
    expect(readOverdue([makeOverdue("on")])).toBe("on");
    expect(readOverdue([makeOverdue("off")])).toBe("off");
  });
});

describe("run()", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns early when disabled", async () => {
    mockBackupMonitorEnabled.value = false;
    await run();
    expect(mockListStates).not.toHaveBeenCalled();
  });

  it("returns early when not configured", async () => {
    mockIsConfigured.mockReturnValue(false);
    await run();
    expect(mockListStates).not.toHaveBeenCalled();
  });

  it("returns early when no repo configured", async () => {
    mockHaConfigRepo.value = undefined;
    mockFleetInfraRepo.value = undefined;
    await run();
    expect(mockListStates).not.toHaveBeenCalled();
  });

  it("failed event with reason → createIssue with FAILED_TITLE, Priority label, reason + timestamp in body", async () => {
    mockListStates.mockResolvedValue([
      makeEvent("failed", "2026-08-10T17:12:46.406+00:00", "NAS mount unavailable"),
    ]);

    await run();

    expect(mockCreateIssue).toHaveBeenCalledOnce();
    const [repo, title, body, labels] = mockCreateIssue.mock.calls[0]!;
    expect(repo).toBe(REPO);
    expect(title).toBe(FAILED_TITLE);
    expect(body).toContain("NAS mount unavailable");
    expect(body).toContain("2026-08-10T17:12:46.406+00:00");
    expect(labels).toContain("Priority");
  });

  it("failed event with no reason → body contains 'no reason reported'", async () => {
    mockListStates.mockResolvedValue([makeEvent("failed", "2026-08-10T17:12:46.406+00:00")]);

    await run();

    const [, , body] = mockCreateIssue.mock.calls[0]!;
    expect(body).toContain("no reason reported");
  });

  it("completed event + open failed issue → closeIssue(repo, n, 'completed')", async () => {
    mockListStates.mockResolvedValue([makeEvent("completed", "2026-08-10T17:12:46.406+00:00")]);
    mockListOpenIssues.mockResolvedValue([{ number: 7, title: FAILED_TITLE, body: "", labels: [], author: { login: "claws" } }]);

    await run();

    expect(mockCloseIssue).toHaveBeenCalledWith(REPO, 7, "completed");
  });

  it("in_progress event + open failed issue → no createIssue/editIssue/closeIssue for FAILED_TITLE", async () => {
    mockListStates.mockResolvedValue([makeEvent("in_progress", "2026-08-10T17:12:46.406+00:00")]);
    mockListOpenIssues.mockResolvedValue([{ number: 7, title: FAILED_TITLE, body: "", labels: [], author: { login: "claws" } }]);

    await run();

    expect(mockCreateIssue).not.toHaveBeenCalled();
    expect(mockEditIssue).not.toHaveBeenCalled();
    expect(mockCloseIssue).not.toHaveBeenCalled();
  });

  it("event entity absent or unavailable → no GitHub calls", async () => {
    mockListStates.mockResolvedValue([]);
    await run();
    expect(mockListOpenIssues).not.toHaveBeenCalled();

    vi.clearAllMocks();
    mockListOpenIssues.mockResolvedValue([]);
    const s = makeEvent("failed", "2026-08-10T00:00:00+00:00");
    s.state = "unavailable";
    mockListStates.mockResolvedValue([s]);
    await run();
    expect(mockListOpenIssues).not.toHaveBeenCalled();
  });

  it("overdue on → createIssue with OVERDUE_TITLE", async () => {
    mockListStates.mockResolvedValue([makeOverdue("on")]);

    await run();

    expect(mockCreateIssue).toHaveBeenCalledOnce();
    const [repo, title] = mockCreateIssue.mock.calls[0]!;
    expect(repo).toBe(REPO);
    expect(title).toBe(OVERDUE_TITLE);
  });

  it("overdue off + existing issue #9 → closeIssue(..., 9, 'completed')", async () => {
    mockListStates.mockResolvedValue([makeOverdue("off")]);
    mockListOpenIssues.mockResolvedValue([{ number: 9, title: OVERDUE_TITLE, body: "", labels: [], author: { login: "claws" } }]);

    await run();

    expect(mockCloseIssue).toHaveBeenCalledWith(REPO, 9, "completed");
  });

  it("overdue entity absent/unavailable → no GitHub calls for that title", async () => {
    mockListStates.mockResolvedValue([]);
    await run();
    expect(mockCreateIssue).not.toHaveBeenCalled();
    expect(mockCloseIssue).not.toHaveBeenCalled();
  });

  it("existing overdue issue with byte-identical body → editIssue not called", async () => {
    vi.useFakeTimers();
    const fixedTime = new Date("2026-01-01T00:00:00.000Z");
    vi.setSystemTime(fixedTime);

    const identicalBody = buildOverdueBody(fixedTime.toISOString());
    mockListStates.mockResolvedValue([makeOverdue("on")]);
    mockListOpenIssues.mockResolvedValue([{ number: 9, title: OVERDUE_TITLE, body: "", labels: [], author: { login: "claws" } }]);
    mockGetIssueBody.mockResolvedValue(identicalBody);

    await run();

    expect(mockEditIssue).not.toHaveBeenCalled();
  });

  it("both alerts active in one tick → two createIssue calls, one per title", async () => {
    mockListStates.mockResolvedValue([
      makeEvent("failed", "2026-08-10T17:12:46.406+00:00", "NAS mount unavailable"),
      makeOverdue("on"),
    ]);

    await run();

    expect(mockCreateIssue).toHaveBeenCalledTimes(2);
    const titles = mockCreateIssue.mock.calls.map((c: unknown[]) => c[1]);
    expect(titles).toContain(FAILED_TITLE);
    expect(titles).toContain(OVERDUE_TITLE);
  });

  it("listOpenIssues rejecting for failed alert still lets overdue alert file, run() resolves", async () => {
    mockListStates.mockResolvedValue([
      makeEvent("failed", "2026-08-10T17:12:46.406+00:00", "NAS mount unavailable"),
      makeOverdue("on"),
    ]);
    mockListOpenIssues.mockRejectedValueOnce(new Error("GitHub error"));

    await expect(run()).resolves.toBeUndefined();

    expect(mockCreateIssue).toHaveBeenCalledOnce();
    const [, title] = mockCreateIssue.mock.calls[0]!;
    expect(title).toBe(OVERDUE_TITLE);
  });

  it("listStates rejecting → run() resolves, no GitHub calls", async () => {
    mockListStates.mockRejectedValue(new Error("HA unreachable"));
    await expect(run()).resolves.toBeUndefined();
    expect(mockListOpenIssues).not.toHaveBeenCalled();
  });
});

describe("blind monitor (binary_sensor.backup_overdue unreadable)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("first tick unavailable → below threshold, no createIssue", async () => {
    mockListStates.mockResolvedValue([makeOverdue("unavailable")]);

    await run();

    expect(mockCreateIssue).not.toHaveBeenCalled();
  });

  it("unavailable for 49h across two ticks → createIssue with BLIND_TITLE, Priority label, first tick's timestamp", async () => {
    vi.useFakeTimers();
    const t0 = new Date("2026-01-01T00:00:00.000Z");
    vi.setSystemTime(t0);

    mockListStates.mockResolvedValue([makeOverdue("unavailable"), makeLastSuccess("unknown")]);
    await run();
    expect(mockCreateIssue).not.toHaveBeenCalled();

    vi.setSystemTime(new Date(t0.getTime() + 49 * 60 * 60 * 1000));
    await run();

    expect(mockCreateIssue).toHaveBeenCalledOnce();
    const [repo, title, body, labels] = mockCreateIssue.mock.calls[0]!;
    expect(repo).toBe(REPO);
    expect(title).toBe(BLIND_TITLE);
    expect(labels).toContain("Priority");
    expect(body).toContain("sensor.backup_last_successful_automatic_backup");
    expect(body).toContain(t0.toISOString());
  });

  it("overdue entity entirely absent for >48h → alert body says entity absent", async () => {
    vi.useFakeTimers();
    const t0 = new Date("2026-01-01T00:00:00.000Z");
    vi.setSystemTime(t0);

    mockListStates.mockResolvedValue([]);
    await run();
    vi.setSystemTime(new Date(t0.getTime() + BLIND_THRESHOLD_MS + 60_000));
    await run();

    expect(mockCreateIssue).toHaveBeenCalledOnce();
    const [, title, body] = mockCreateIssue.mock.calls[0]!;
    expect(title).toBe(BLIND_TITLE);
    expect(body).toContain("entity absent");
  });

  it("blind alert open, sensor returns to off → closeIssue for BLIND_TITLE and record cleared", async () => {
    vi.useFakeTimers();
    const t0 = new Date("2026-01-01T00:00:00.000Z");
    vi.setSystemTime(t0);
    mockListStates.mockResolvedValue([makeOverdue("unavailable")]);
    await run();
    vi.setSystemTime(new Date(t0.getTime() + BLIND_THRESHOLD_MS + 60_000));
    await run();
    expect(mockCreateIssue).toHaveBeenCalledOnce();

    mockListOpenIssues.mockResolvedValue([{ number: 11, title: BLIND_TITLE, body: "", labels: [], author: { login: "claws" } }]);
    mockListStates.mockResolvedValue([makeOverdue("off")]);
    await run();

    expect(mockCloseIssue).toHaveBeenCalledWith(REPO, 11, "completed");

    // record cleared: a subsequent unavailable tick alerts only after another 48h
    mockCreateIssue.mockClear();
    mockListStates.mockResolvedValue([makeOverdue("unavailable")]);
    await run();
    expect(mockCreateIssue).not.toHaveBeenCalled();
  });

  it("while unavailable, closeIssue is never called for OVERDUE_TITLE", async () => {
    mockListStates.mockResolvedValue([makeOverdue("unavailable")]);
    mockListOpenIssues.mockResolvedValue([{ number: 9, title: OVERDUE_TITLE, body: "", labels: [], author: { login: "claws" } }]);

    await run();

    expect(mockCloseIssue).not.toHaveBeenCalledWith(REPO, 9, "completed");
    expect(mockCloseIssue).not.toHaveBeenCalled();
  });

  it("persistent blind state with byte-identical body → editIssue not called", async () => {
    vi.useFakeTimers();
    const t0 = new Date("2026-01-01T00:00:00.000Z");
    vi.setSystemTime(t0);
    mockListStates.mockResolvedValue([makeOverdue("unavailable")]);
    await run();
    vi.setSystemTime(new Date(t0.getTime() + BLIND_THRESHOLD_MS + 60_000));

    const identicalBody = buildBlindBody(t0.toISOString(), "unavailable", null);
    mockListOpenIssues.mockResolvedValue([{ number: 12, title: BLIND_TITLE, body: "", labels: [], author: { login: "claws" } }]);
    mockGetIssueBody.mockResolvedValue(identicalBody);

    await run();

    expect(mockEditIssue).not.toHaveBeenCalled();
  });
});

describe("buildFailedBody / buildOverdueBody", () => {
  it("buildFailedBody includes reason fallback", () => {
    const body = buildFailedBody({ eventType: "failed", timestamp: "ts", failedReason: null }, "2026-01-01T00:00:00.000Z");
    expect(body).toContain("no reason reported");
    expect(body).toContain("**Last checked (UTC):** 2026-01-01T00:00:00.000Z");
  });

  it("buildOverdueBody mentions 36 hours", () => {
    const body = buildOverdueBody("2026-01-01T00:00:00.000Z");
    expect(body).toContain("36 hours");
  });
});
