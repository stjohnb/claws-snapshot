import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── Hoisted mocks ──

const mockUpgraderEnabled = vi.hoisted(() => ({ value: true }));
const mockExcludePatterns = vi.hoisted(() => ({ value: [] as string[] }));
const mockHaConfigRepo = vi.hoisted(() => ({ value: "St-John-Software/home-assistant-config" as string | undefined }));
const mockFleetInfraRepo = vi.hoisted(() => ({ value: "St-John-Software/fleet-infra" }));
vi.mock("../config.js", () => ({
  get HOME_ASSISTANT_UPGRADER_ENABLED() { return mockUpgraderEnabled.value; },
  get HOME_ASSISTANT_UPGRADER_EXCLUDE_PATTERNS() { return mockExcludePatterns.value; },
  get HOME_ASSISTANT_CONFIG_REPO() { return mockHaConfigRepo.value; },
  get FLEET_INFRA_REPO() { return mockFleetInfraRepo.value; },
  LABELS: { priority: "Priority" },
}));

const mockIsConfigured = vi.hoisted(() => vi.fn(() => true));
const mockListUpdateEntities = vi.hoisted(() => vi.fn());
const mockInstallUpdate = vi.hoisted(() => vi.fn());
vi.mock("../home-assistant.js", () => ({
  isConfigured: mockIsConfigured,
  listUpdateEntities: mockListUpdateEntities,
  installUpdate: mockInstallUpdate,
  UPDATE_BACKUP_FEATURE_BIT: 8,
}));

const mockFindIssueByExactTitle = vi.hoisted(() => vi.fn());
const mockCreateIssue = vi.hoisted(() => vi.fn());
vi.mock("../github.js", () => ({
  findIssueByExactTitle: mockFindIssueByExactTitle,
  createIssue: mockCreateIssue,
}));

vi.mock("../log.js", () => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

const mockNotify = vi.hoisted(() => vi.fn());
vi.mock("../slack.js", () => ({
  notify: mockNotify,
}));

const mockReportError = vi.hoisted(() => vi.fn());
vi.mock("../error-reporter.js", () => ({
  reportError: mockReportError,
}));

// ── DB mock ──

const haStateStore = vi.hoisted(() => new Map<string, { entity_id: string; version: string; first_seen_at: number; attempted_at: number; failure_count: number }>());
vi.mock("../db.js", () => ({
  getHaUpgraderState: vi.fn((id: string) => haStateStore.get(id) ?? null),
  upsertHaUpgraderFirstSeen: vi.fn((id: string, version: string, now: number) => {
    const existing = haStateStore.get(id);
    if (existing && existing.version === version) return existing;
    const row = { entity_id: id, version, first_seen_at: now, attempted_at: 0, failure_count: 0 };
    haStateStore.set(id, row);
    return row;
  }),
  recordHaUpgraderAttempt: vi.fn((id: string, version: string, attemptedAt: number, failureCount: number) => {
    const row = haStateStore.get(id);
    if (row && row.version === version) { row.attempted_at = attemptedAt; row.failure_count = failureCount; }
  }),
  clearHaUpgraderStateForTests: vi.fn(() => haStateStore.clear()),
}));

import { run, _resetCooldownForTests } from "./ha-upgrader.js";

const HOUR_MS = 60 * 60 * 1000;

// ── Helpers ──

function makeUpdate(overrides: Record<string, unknown> = {}): object {
  return {
    entity_id: "update.test_device_firmware",
    state: "on",
    attributes: {
      title: "Test Device",
      installed_version: "1.0.0",
      latest_version: "1.1.0",
      auto_update: false,
      in_progress: false,
      skipped_version: null,
      supported_features: 1,
      release_url: "https://example.com/release/1.1.0",
      release_summary: "Bug fixes",
    },
    last_changed: "2024-01-01T00:00:00Z",
    last_updated: "2024-01-01T00:00:00Z",
    ...overrides,
  };
}

function makeCoreUpdate(overrides: Record<string, unknown> = {}): object {
  return {
    entity_id: "update.home_assistant_core_update",
    state: "on",
    attributes: {
      title: "Home Assistant Core",
      installed_version: "2024.1.0",
      latest_version: "2024.2.0",
      auto_update: false,
      in_progress: false,
      skipped_version: null,
      supported_features: 9,
      release_url: "https://github.com/home-assistant/core/releases/tag/2024.2.0",
      release_summary: "New features",
    },
    last_changed: "2024-01-01T00:00:00Z",
    last_updated: "2024-01-01T00:00:00Z",
    ...overrides,
  };
}

// ── Tests ──

describe("ha-upgrader", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    vi.clearAllMocks();
    haStateStore.clear();
    _resetCooldownForTests();
    mockUpgraderEnabled.value = true;
    mockExcludePatterns.value = [];
    mockHaConfigRepo.value = "St-John-Software/home-assistant-config";
    mockIsConfigured.mockReturnValue(true);
    mockListUpdateEntities.mockResolvedValue([]);
    mockInstallUpdate.mockResolvedValue(undefined);
    mockFindIssueByExactTitle.mockResolvedValue(null);
    mockCreateIssue.mockResolvedValue(1);
    mockNotify.mockResolvedValue(undefined);
    mockReportError.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("skips when disabled", async () => {
    mockUpgraderEnabled.value = false;
    await run();
    expect(mockListUpdateEntities).not.toHaveBeenCalled();
    expect(mockInstallUpdate).not.toHaveBeenCalled();
  });

  it("skips when HA is not configured", async () => {
    mockIsConfigured.mockReturnValue(false);
    await run();
    expect(mockListUpdateEntities).not.toHaveBeenCalled();
    expect(mockInstallUpdate).not.toHaveBeenCalled();
  });

  it("installs a device update and notifies Slack", async () => {
    const update = makeUpdate();
    mockListUpdateEntities.mockResolvedValue([update]);

    // First run records first-seen
    await run();
    expect(mockInstallUpdate).not.toHaveBeenCalled();

    // Advance past 24h dwell window
    vi.advanceTimersByTime(24 * HOUR_MS + 1);

    // Second run installs
    await run();
    expect(mockInstallUpdate).toHaveBeenCalledWith("update.test_device_firmware", { backup: false });
    expect(mockNotify).toHaveBeenCalledWith(expect.stringContaining("Installed 1 device update(s)"));
  });

  it("does NOT install when auto_update is true", async () => {
    const update = makeUpdate({ attributes: { ...((makeUpdate() as { attributes: Record<string, unknown> }).attributes), auto_update: true } });
    mockListUpdateEntities.mockResolvedValue([update]);

    await run();

    expect(mockInstallUpdate).not.toHaveBeenCalled();
    expect(mockNotify).not.toHaveBeenCalled();
  });

  it("does NOT install when in_progress is true", async () => {
    const base = (makeUpdate() as { attributes: Record<string, unknown> }).attributes;
    const update = makeUpdate({ attributes: { ...base, in_progress: true } });
    mockListUpdateEntities.mockResolvedValue([update]);

    await run();

    expect(mockInstallUpdate).not.toHaveBeenCalled();
    expect(mockNotify).not.toHaveBeenCalled();
  });

  it("does NOT install when state is off", async () => {
    const update = makeUpdate({ state: "off" });
    mockListUpdateEntities.mockResolvedValue([update]);

    await run();

    expect(mockInstallUpdate).not.toHaveBeenCalled();
    expect(mockNotify).not.toHaveBeenCalled();
  });

  it("does NOT install when state is unavailable", async () => {
    const update = makeUpdate({ state: "unavailable" });
    mockListUpdateEntities.mockResolvedValue([update]);

    await run();

    expect(mockInstallUpdate).not.toHaveBeenCalled();
    expect(mockNotify).not.toHaveBeenCalled();
  });

  it("skips when latest_version equals skipped_version", async () => {
    const base = (makeUpdate() as { attributes: Record<string, unknown> }).attributes;
    const update = makeUpdate({ attributes: { ...base, skipped_version: "1.1.0" } });
    mockListUpdateEntities.mockResolvedValue([update]);

    await run();

    expect(mockInstallUpdate).not.toHaveBeenCalled();
    expect(mockNotify).not.toHaveBeenCalled();
  });

  it("auto-installs home_assistant_core_update with backup: true when BACKUP feature is supported", async () => {
    const update = makeCoreUpdate(); // supported_features: 9 (INSTALL=1 | BACKUP=8)
    mockListUpdateEntities.mockResolvedValue([update]);

    // First run seeds first-seen
    await run();
    expect(mockInstallUpdate).not.toHaveBeenCalled();

    // Advance past 48h dwell window
    vi.advanceTimersByTime(48 * HOUR_MS + 1);

    // Second run installs with backup
    await run();
    expect(mockInstallUpdate).toHaveBeenCalledWith("update.home_assistant_core_update", { backup: true });
    expect(mockCreateIssue).not.toHaveBeenCalled();
    expect(mockNotify).toHaveBeenCalledWith(expect.stringContaining("[ha-upgrader] Installing high-risk update with pre-install backup"));
    const summaryCall = mockNotify.mock.calls.find((c: unknown[]) => (c[0] as string).includes("Installed 1 high-risk update(s)"));
    expect(summaryCall).toBeDefined();
    expect(summaryCall![0]).toContain("with pre-install backup");
  });

  it("auto-installs home_assistant_core_update without backup when BACKUP feature missing", async () => {
    const update = makeCoreUpdate({ attributes: { ...(makeCoreUpdate() as { attributes: Record<string, unknown> }).attributes, supported_features: 1 } });
    mockListUpdateEntities.mockResolvedValue([update]);

    // First run seeds first-seen
    await run();
    expect(mockInstallUpdate).not.toHaveBeenCalled();

    vi.advanceTimersByTime(48 * HOUR_MS + 1);

    await run();
    expect(mockInstallUpdate).toHaveBeenCalledWith("update.home_assistant_core_update", { backup: false });
    expect(mockNotify).toHaveBeenCalledWith(expect.stringContaining("without pre-install backup"));
  });

  it("raises a GitHub issue for an entity matching an exclude pattern", async () => {
    mockExcludePatterns.value = ["update\\.zwavejs_"];
    const update = makeUpdate({ entity_id: "update.zwavejs_firmware_1234" });
    mockListUpdateEntities.mockResolvedValue([update]);

    await run();

    expect(mockInstallUpdate).not.toHaveBeenCalled();
    expect(mockCreateIssue).toHaveBeenCalled();
  });

  it("does not create a duplicate issue on the second run", async () => {
    mockExcludePatterns.value = ["update\\.zwavejs_"];
    const update = makeUpdate({ entity_id: "update.zwavejs_firmware_x" });
    mockListUpdateEntities.mockResolvedValue([update]);

    // First run: no existing issue
    mockFindIssueByExactTitle.mockResolvedValue(null);
    await run();
    expect(mockCreateIssue).toHaveBeenCalledTimes(1);

    vi.clearAllMocks();
    mockListUpdateEntities.mockResolvedValue([update]);
    mockNotify.mockResolvedValue(undefined);
    mockCreateIssue.mockResolvedValue(1);

    // Second run: existing issue found — dedup by title
    const existingTitle = `[HA] Upgrade available: Test Device → 1.1.0`;
    mockFindIssueByExactTitle.mockResolvedValue({ number: 42, title: existingTitle });
    await run();

    expect(mockCreateIssue).not.toHaveBeenCalled();
    expect(mockNotify).not.toHaveBeenCalled();
  });

  it("raises an issue on the third consecutive failure", async () => {
    const update = makeUpdate();
    mockListUpdateEntities.mockResolvedValue([update]);
    mockInstallUpdate.mockRejectedValue(new Error("HA unreachable"));

    // Seed first-seen
    await run();
    vi.advanceTimersByTime(24 * HOUR_MS + 1);

    // First failure
    await run();
    expect(mockCreateIssue).not.toHaveBeenCalled();

    // Advance past cooldown so retry is allowed
    vi.advanceTimersByTime(6 * HOUR_MS + 1);

    // Second failure
    await run();
    expect(mockCreateIssue).not.toHaveBeenCalled();

    vi.advanceTimersByTime(6 * HOUR_MS + 1);

    // Third failure — issue is raised
    await run();
    expect(mockCreateIssue).toHaveBeenCalledWith(
      "St-John-Software/home-assistant-config",
      expect.stringContaining("Test Device"),
      expect.any(String),
      ["Priority"],
    );
  });

  it("raises an issue on the third consecutive failure for a high-risk update", async () => {
    const update = makeCoreUpdate();
    mockListUpdateEntities.mockResolvedValue([update]);
    mockInstallUpdate.mockRejectedValue(new Error("HA unreachable"));

    // Seed first-seen
    await run();
    vi.advanceTimersByTime(48 * HOUR_MS + 1);

    // First failure
    await run();
    expect(mockCreateIssue).not.toHaveBeenCalled();

    // Advance past cooldown so retry is allowed
    vi.advanceTimersByTime(6 * HOUR_MS + 1);

    // Second failure
    await run();
    expect(mockCreateIssue).not.toHaveBeenCalled();

    vi.advanceTimersByTime(6 * HOUR_MS + 1);

    // Third failure — issue is raised
    await run();
    expect(mockCreateIssue).toHaveBeenCalledWith(
      "St-John-Software/home-assistant-config",
      expect.stringContaining("Home Assistant Core"),
      expect.any(String),
      ["Priority"],
    );
  });

  it("caps auto-installs at 5 per run when 7 are eligible", async () => {
    const updates = Array.from({ length: 7 }, (_, i) =>
      makeUpdate({
        entity_id: `update.device_firmware_${i}`,
        attributes: {
          title: `Device ${i}`,
          installed_version: "1.0.0",
          latest_version: "1.1.0",
          auto_update: false,
          in_progress: false,
          skipped_version: null,
          supported_features: 1,
        },
      }),
    );
    mockListUpdateEntities.mockResolvedValue(updates);

    // Seed first-seen
    await run();
    vi.advanceTimersByTime(24 * HOUR_MS + 1);

    // Second run — capped at 5
    await run();
    expect(mockInstallUpdate).toHaveBeenCalledTimes(5);
  });

  it("stays silent on Slack when there is nothing to do", async () => {
    mockListUpdateEntities.mockResolvedValue([
      makeUpdate({ state: "off" }),
      makeUpdate({ state: "unavailable" }),
    ]);

    await run();

    expect(mockNotify).not.toHaveBeenCalled();
  });

  it("defers high-risk install until 48h availability window has elapsed", async () => {
    const update = makeCoreUpdate();
    mockListUpdateEntities.mockResolvedValue([update]);

    // First run: seeds first-seen, no install, no Slack notify (dwell-only is silent)
    await run();
    expect(mockInstallUpdate).not.toHaveBeenCalled();
    expect(mockNotify).not.toHaveBeenCalled();

    vi.clearAllMocks();
    mockListUpdateEntities.mockResolvedValue([update]);
    mockInstallUpdate.mockResolvedValue(undefined);
    mockNotify.mockResolvedValue(undefined);

    // Advance 47h — still in dwell window
    vi.advanceTimersByTime(47 * HOUR_MS);
    await run();
    expect(mockInstallUpdate).not.toHaveBeenCalled();

    vi.clearAllMocks();
    mockListUpdateEntities.mockResolvedValue([update]);
    mockInstallUpdate.mockResolvedValue(undefined);
    mockNotify.mockResolvedValue(undefined);

    // Advance 2 more hours — past 48h
    vi.advanceTimersByTime(2 * HOUR_MS);
    await run();
    expect(mockInstallUpdate).toHaveBeenCalledWith("update.home_assistant_core_update", { backup: true });
  });

  it("defers device-firmware install until 24h availability window has elapsed", async () => {
    const update = makeUpdate();
    mockListUpdateEntities.mockResolvedValue([update]);

    // First run: seeds, no install, no Slack notify (dwell-only is silent)
    await run();
    expect(mockInstallUpdate).not.toHaveBeenCalled();
    expect(mockNotify).not.toHaveBeenCalled();

    vi.clearAllMocks();
    mockListUpdateEntities.mockResolvedValue([update]);
    mockInstallUpdate.mockResolvedValue(undefined);
    mockNotify.mockResolvedValue(undefined);

    // Advance 23h — still in dwell window
    vi.advanceTimersByTime(23 * HOUR_MS);
    await run();
    expect(mockInstallUpdate).not.toHaveBeenCalled();

    vi.clearAllMocks();
    mockListUpdateEntities.mockResolvedValue([update]);
    mockInstallUpdate.mockResolvedValue(undefined);
    mockNotify.mockResolvedValue(undefined);

    // Advance 2 more hours — past 24h
    vi.advanceTimersByTime(2 * HOUR_MS);
    await run();
    expect(mockInstallUpdate).toHaveBeenCalledWith("update.test_device_firmware", { backup: false });
  });

  it("does not Slack-notify when only dwell-deferred entries exist on repeat runs", async () => {
    const highRisk = makeCoreUpdate();
    const device = makeUpdate();
    mockListUpdateEntities.mockResolvedValue([highRisk, device]);

    // First run: seeds first_seen for both, neither installs (dwell not elapsed)
    await run();
    expect(mockInstallUpdate).not.toHaveBeenCalled();
    expect(mockNotify).not.toHaveBeenCalled();

    vi.clearAllMocks();
    mockListUpdateEntities.mockResolvedValue([highRisk, device]);

    // Advance 1h — still within both dwell windows
    vi.advanceTimersByTime(HOUR_MS);
    await run();
    expect(mockInstallUpdate).not.toHaveBeenCalled();
    expect(mockNotify).not.toHaveBeenCalled();
  });

  it("user exclude wins over Core auto-install", async () => {
    mockExcludePatterns.value = ["home_assistant_core"];
    const update = makeCoreUpdate();
    mockListUpdateEntities.mockResolvedValue([update]);

    await run();

    expect(mockInstallUpdate).not.toHaveBeenCalled();
    expect(mockCreateIssue).toHaveBeenCalled();
  });

  it("caps high-risk auto-installs at 1 per run and prioritises supervisor", async () => {
    const coreUpdate = makeCoreUpdate();
    const supervisorUpdate = makeCoreUpdate({
      entity_id: "update.home_assistant_supervisor_update",
      attributes: {
        ...(makeCoreUpdate() as { attributes: Record<string, unknown> }).attributes,
        title: "Supervisor",
        supported_features: 9,
      },
    });
    mockListUpdateEntities.mockResolvedValue([coreUpdate, supervisorUpdate]);

    // Seed first-seen
    await run();
    expect(mockInstallUpdate).not.toHaveBeenCalled();

    vi.advanceTimersByTime(48 * HOUR_MS + 1);

    // Second run: should install supervisor (higher priority), not core
    await run();
    expect(mockInstallUpdate).toHaveBeenCalledTimes(1);
    expect(mockInstallUpdate).toHaveBeenCalledWith("update.home_assistant_supervisor_update", { backup: true });

    // Summary should mention 1 high-risk deferred
    const summaryCall = mockNotify.mock.calls.find((c: unknown[]) => (c[0] as string).includes("high-risk update(s) deferred to next run"));
    expect(summaryCall).toBeDefined();
  });
});
