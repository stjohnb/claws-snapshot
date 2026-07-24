import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── Hoisted mocks ──

const mockBatteryMonitorEnabled = vi.hoisted(() => ({ value: true }));
const mockBatteryThresholdPercent = vi.hoisted(() => ({ value: 10 }));
const mockHaConfigRepo = vi.hoisted(() => ({ value: "St-John-Software/home-assistant-config" as string | undefined }));
const mockFleetInfraRepo = vi.hoisted(() => ({ value: undefined as string | undefined }));

vi.mock("../config.js", () => ({
  get HOME_ASSISTANT_BATTERY_MONITOR_ENABLED() { return mockBatteryMonitorEnabled.value; },
  get HOME_ASSISTANT_BATTERY_THRESHOLD_PERCENT() { return mockBatteryThresholdPercent.value; },
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

const mockFindIssueByExactTitle = vi.hoisted(() => vi.fn());
const mockCreateIssue = vi.hoisted(() => vi.fn());
const mockGetIssueBody = vi.hoisted(() => vi.fn());
const mockEditIssue = vi.hoisted(() => vi.fn());
const mockCloseIssue = vi.hoisted(() => vi.fn());
vi.mock("../github.js", () => ({
  findIssueByExactTitle: mockFindIssueByExactTitle,
  createIssue: mockCreateIssue,
  getIssueBody: mockGetIssueBody,
  editIssue: mockEditIssue,
  closeIssue: mockCloseIssue,
}));

vi.mock("../log.js", () => ({
  info: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
  error: vi.fn(),
}));

import {
  run,
  isBatterySensor,
  findLowBatteries,
  buildBody,
} from "./ha-battery-monitor.js";
import type { HAState } from "../home-assistant.js";

function makeState(
  entity_id: string,
  state: string,
  deviceClass?: string,
  unit?: string,
  friendly_name?: string,
): HAState {
  const attributes: Record<string, unknown> = {};
  if (deviceClass !== undefined) attributes["device_class"] = deviceClass;
  if (unit !== undefined) attributes["unit_of_measurement"] = unit;
  if (friendly_name !== undefined) attributes["friendly_name"] = friendly_name;
  return { entity_id, state, attributes, last_changed: "", last_updated: "" };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockBatteryMonitorEnabled.value = true;
  mockBatteryThresholdPercent.value = 10;
  mockHaConfigRepo.value = "St-John-Software/home-assistant-config";
  mockFleetInfraRepo.value = undefined;
  mockIsConfigured.mockReturnValue(true);
  mockFindIssueByExactTitle.mockResolvedValue(null);
  mockCreateIssue.mockResolvedValue(undefined);
  mockGetIssueBody.mockResolvedValue("");
  mockEditIssue.mockResolvedValue(undefined);
  mockCloseIssue.mockResolvedValue(undefined);
});

describe("isBatterySensor", () => {
  it("returns true for device_class:battery + unit:%", () => {
    expect(isBatterySensor(makeState("s1", "50", "battery", "%"))).toBe(true);
  });

  it("returns false for battery_state (no % unit)", () => {
    expect(isBatterySensor(makeState("sensor.foo_battery_state", "discharging", "battery", undefined))).toBe(false);
  });

  it("returns false for battery_type (no % unit)", () => {
    expect(isBatterySensor(makeState("sensor.foo_battery_type", "AAA", "battery", "AAA"))).toBe(false);
  });

  it("returns false for battery_voltage (wrong unit)", () => {
    expect(isBatterySensor(makeState("sensor.foo_battery_voltage", "2.5", "battery", "V"))).toBe(false);
  });

  it("returns false when device_class is not battery", () => {
    expect(isBatterySensor(makeState("s1", "50", "temperature", "%"))).toBe(false);
  });

  it("returns false when attributes are missing", () => {
    const s: HAState = { entity_id: "s1", state: "50", attributes: {}, last_changed: "", last_updated: "" };
    expect(isBatterySensor(s)).toBe(false);
  });
});

describe("findLowBatteries", () => {
  it("includes only battery sensors at or below threshold", () => {
    const states: HAState[] = [
      makeState("sensor.a", "10", "battery", "%", "Device A"),
      makeState("sensor.b", "11", "battery", "%", "Device B"),
      makeState("sensor.c", "5", "battery", "%", "Device C"),
      makeState("sensor.d", "50", "temperature", "%"),
    ];
    const result = findLowBatteries(states, 10);
    expect(result.map((d) => d.entityId)).toEqual(["sensor.c", "sensor.a"]);
  });

  it("skips unavailable and unknown states", () => {
    const states: HAState[] = [
      makeState("sensor.x", "unavailable", "battery", "%"),
      makeState("sensor.y", "unknown", "battery", "%"),
      makeState("sensor.z", "8", "battery", "%", "Low Z"),
    ];
    const result = findLowBatteries(states, 10);
    expect(result).toHaveLength(1);
    expect(result[0]!.entityId).toBe("sensor.z");
  });

  it("sorts ascending by level (most urgent first)", () => {
    const states: HAState[] = [
      makeState("sensor.b", "8", "battery", "%", "B"),
      makeState("sensor.a", "3", "battery", "%", "A"),
      makeState("sensor.c", "10", "battery", "%", "C"),
    ];
    const result = findLowBatteries(states, 10);
    expect(result.map((d) => d.level)).toEqual([3, 8, 10]);
  });

  it("uses entity_id as name when friendly_name is absent", () => {
    const states: HAState[] = [makeState("sensor.radiator", "5", "battery", "%")];
    const result = findLowBatteries(states, 10);
    expect(result[0]!.name).toBe("sensor.radiator");
  });

  it("excludes sensors above threshold", () => {
    const states: HAState[] = [makeState("sensor.ok", "50", "battery", "%", "OK")];
    expect(findLowBatteries(states, 10)).toHaveLength(0);
  });

  it("handles decimal state values", () => {
    const states: HAState[] = [makeState("sensor.r", "10.0", "battery", "%", "Radiator")];
    const result = findLowBatteries(states, 10);
    expect(result).toHaveLength(1);
    expect(result[0]!.level).toBe(10);
  });
});

describe("run()", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns early when disabled", async () => {
    mockBatteryMonitorEnabled.value = false;
    await run();
    expect(mockListStates).not.toHaveBeenCalled();
    expect(mockFindIssueByExactTitle).not.toHaveBeenCalled();
  });

  it("returns early when not configured", async () => {
    mockIsConfigured.mockReturnValue(false);
    await run();
    expect(mockListStates).not.toHaveBeenCalled();
    expect(mockFindIssueByExactTitle).not.toHaveBeenCalled();
  });

  it("returns early when no repo configured", async () => {
    mockHaConfigRepo.value = undefined;
    mockFleetInfraRepo.value = undefined;
    await run();
    expect(mockListStates).not.toHaveBeenCalled();
    expect(mockFindIssueByExactTitle).not.toHaveBeenCalled();
  });

  it("low devices + no existing issue → createIssue called with LABELS.priority", async () => {
    mockListStates.mockResolvedValue([
      makeState("sensor.a", "5", "battery", "%", "Device A"),
      makeState("sensor.b", "10", "battery", "%", "Device B"),
    ]);
    mockFindIssueByExactTitle.mockResolvedValue(null);

    await run();

    expect(mockCreateIssue).toHaveBeenCalledOnce();
    const [repo, title, body, labels] = mockCreateIssue.mock.calls[0]!;
    expect(repo).toBe("St-John-Software/home-assistant-config");
    expect(title).toBe("[ha-battery-monitor] Devices with low battery");
    expect(body).toContain("Device A");
    expect(body).toContain("Device B");
    expect(labels).toContain("Priority");
    expect(mockCloseIssue).not.toHaveBeenCalled();
  });

  it("low devices + existing issue with different body → editIssue called", async () => {
    const staleBody = "old body content";
    mockListStates.mockResolvedValue([
      makeState("sensor.a", "5", "battery", "%", "Device A"),
    ]);
    mockFindIssueByExactTitle.mockResolvedValue({ number: 42, title: "[ha-battery-monitor] Devices with low battery" });
    mockGetIssueBody.mockResolvedValue(staleBody);

    await run();

    expect(mockEditIssue).toHaveBeenCalledOnce();
    const [, issueNumber, newBody] = mockEditIssue.mock.calls[0]!;
    expect(issueNumber).toBe(42);
    expect(newBody).toContain("Device A");
    expect(mockCreateIssue).not.toHaveBeenCalled();
  });

  it("low devices + existing issue with identical body → editIssue NOT called", async () => {
    vi.useFakeTimers();
    const fixedTime = new Date("2026-01-01T00:00:00.000Z");
    vi.setSystemTime(fixedTime);

    const low = [{ entityId: "sensor.a", name: "Device A", level: 5 }];
    const identicalBody = buildBody(low, fixedTime.toISOString(), 10);

    mockListStates.mockResolvedValue([
      makeState("sensor.a", "5", "battery", "%", "Device A"),
    ]);
    mockFindIssueByExactTitle.mockResolvedValue({ number: 42, title: "[ha-battery-monitor] Devices with low battery" });
    mockGetIssueBody.mockResolvedValue(identicalBody);

    await run();

    expect(mockEditIssue).not.toHaveBeenCalled();
  });

  it("no low devices + existing open issue → closeIssue(repo, n, 'completed')", async () => {
    mockListStates.mockResolvedValue([
      makeState("sensor.ok", "80", "battery", "%", "OK Device"),
    ]);
    mockFindIssueByExactTitle.mockResolvedValue({ number: 7, title: "[ha-battery-monitor] Devices with low battery" });

    await run();

    expect(mockCloseIssue).toHaveBeenCalledWith("St-John-Software/home-assistant-config", 7, "completed");
    expect(mockCreateIssue).not.toHaveBeenCalled();
    expect(mockEditIssue).not.toHaveBeenCalled();
  });

  it("no low devices + no existing issue → no GitHub writes", async () => {
    mockListStates.mockResolvedValue([
      makeState("sensor.ok", "80", "battery", "%", "OK Device"),
    ]);
    mockFindIssueByExactTitle.mockResolvedValue(null);

    await run();

    expect(mockCreateIssue).not.toHaveBeenCalled();
    expect(mockEditIssue).not.toHaveBeenCalled();
    expect(mockCloseIssue).not.toHaveBeenCalled();
  });

  it("listStates throwing does not propagate out of run()", async () => {
    mockListStates.mockRejectedValue(new Error("HA unreachable"));
    await expect(run()).resolves.toBeUndefined();
    expect(mockFindIssueByExactTitle).not.toHaveBeenCalled();
  });

  it("GitHub API failure does not propagate out of run()", async () => {
    mockListStates.mockResolvedValue([
      makeState("sensor.a", "5", "battery", "%", "Device A"),
    ]);
    mockFindIssueByExactTitle.mockRejectedValue(new Error("GitHub error"));
    await expect(run()).resolves.toBeUndefined();
    expect(mockCreateIssue).not.toHaveBeenCalled();
  });
});
