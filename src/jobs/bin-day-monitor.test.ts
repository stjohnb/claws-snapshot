import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Hoisted mocks ──

const mockBinDayMonitorEnabled = vi.hoisted(() => ({ value: true }));
const mockBinDaySensorPrefix = vi.hoisted(() => ({ value: "sensor.bin_scraper_" }));
const mockHaConfigRepo = vi.hoisted(() => ({ value: "St-John-Software/home-assistant-config" as string | undefined }));
const mockFleetInfraRepo = vi.hoisted(() => ({ value: undefined as string | undefined }));

vi.mock("../config.js", () => ({
  get HOME_ASSISTANT_BIN_DAY_MONITOR_ENABLED() { return mockBinDayMonitorEnabled.value; },
  get HOME_ASSISTANT_BIN_DAY_SENSOR_PREFIX() { return mockBinDaySensorPrefix.value; },
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
  pickBinSensors,
  findMissing,
  parsePrevStatus,
  extractHistoryRows,
  buildBody,
} from "./bin-day-monitor.js";
import type { HAState } from "../home-assistant.js";

function makeState(entity_id: string, state: string, friendly_name?: string): HAState {
  return {
    entity_id,
    state,
    attributes: friendly_name ? { friendly_name } : {},
    last_changed: "",
    last_updated: "",
  };
}

const HEALTHY_SENSORS: HAState[] = [
  makeState("sensor.bin_scraper_general_waste_next_collection", "2026-06-29T00:00:00+00:00", "General Waste Next Collection"),
  makeState("sensor.bin_scraper_recycling_next_collection", "2026-07-06T00:00:00+00:00", "Recycling Next Collection"),
  makeState("sensor.bin_scraper_compost_next_collection", "2026-06-29T00:00:00+00:00", "Compost Next Collection"),
];

const MISSING_SENSORS: HAState[] = [
  makeState("sensor.bin_scraper_general_waste_next_collection", "unavailable", "General Waste Next Collection"),
  makeState("sensor.bin_scraper_recycling_next_collection", "unknown", "Recycling Next Collection"),
  makeState("sensor.bin_scraper_compost_next_collection", "", "Compost Next Collection"),
  makeState("sensor.bin_scraper_glass_recycling_next_collection", "Glass recycling", "Glass Recycling Next Collection"),
];

beforeEach(() => {
  vi.clearAllMocks();
  mockBinDayMonitorEnabled.value = true;
  mockBinDaySensorPrefix.value = "sensor.bin_scraper_";
  mockHaConfigRepo.value = "St-John-Software/home-assistant-config";
  mockFleetInfraRepo.value = undefined;
  mockIsConfigured.mockReturnValue(true);
  mockFindIssueByExactTitle.mockResolvedValue(null);
  mockCreateIssue.mockResolvedValue(undefined);
  mockGetIssueBody.mockResolvedValue("");
  mockEditIssue.mockResolvedValue(undefined);
});

describe("pickBinSensors", () => {
  it("returns only sensors with matching prefix", () => {
    const states: HAState[] = [
      makeState("sensor.bin_scraper_foo", "ok"),
      makeState("sensor.other_thing", "ok"),
      makeState("binary_sensor.bin_scraper_nope", "on"),
    ];
    const result = pickBinSensors(states, "sensor.bin_scraper_");
    expect(result).toHaveLength(1);
    expect(result[0]!.entity_id).toBe("sensor.bin_scraper_foo");
  });

  it("returns empty array when no match", () => {
    expect(pickBinSensors([], "sensor.bin_scraper_")).toEqual([]);
  });
});

describe("findMissing", () => {
  it("flags unavailable, unknown, and empty state", () => {
    const sensors: HAState[] = [
      makeState("s1", "unavailable"),
      makeState("s2", "unknown"),
      makeState("s3", ""),
      makeState("s4", "  "),
    ];
    const result = findMissing(sensors);
    expect(result.map((s) => s.entity_id)).toEqual(["s1", "s2", "s3", "s4"]);
  });

  it("ignores valid date and name states", () => {
    const sensors: HAState[] = [
      makeState("s1", "2026-06-29T00:00:00+00:00"),
      makeState("s2", "Glass recycling"),
    ];
    expect(findMissing(sensors)).toHaveLength(0);
  });
});

describe("parsePrevStatus", () => {
  it("returns MISSING from a body with that status", () => {
    const body = buildBody("MISSING", "2026-01-01T00:00:00.000Z", [], true, "sensor.bin_scraper_", []);
    expect(parsePrevStatus(body)).toBe("MISSING");
  });

  it("returns HEALTHY from a body with that status", () => {
    const body = buildBody("HEALTHY", "2026-01-01T00:00:00.000Z", [], false, "sensor.bin_scraper_", []);
    expect(parsePrevStatus(body)).toBe("HEALTHY");
  });

  it("returns null from an empty body", () => {
    expect(parsePrevStatus("")).toBeNull();
  });
});

describe("extractHistoryRows", () => {
  it("returns prior rows from a built body", () => {
    const rows = ["| 2026-01-01T00:00:00.000Z | MISSING | 1 sensor(s) missing |"];
    const body = buildBody("MISSING", "2026-01-02T00:00:00.000Z", [], false, "sensor.bin_scraper_", rows);
    const extracted = extractHistoryRows(body);
    expect(extracted).toEqual(rows);
  });

  it("returns empty array from empty body", () => {
    expect(extractHistoryRows("")).toEqual([]);
  });

  it("returns multiple rows preserving order", () => {
    const rows = [
      "| 2026-01-01T00:00:00.000Z | MISSING | 1 sensor(s) missing |",
      "| 2026-01-02T00:00:00.000Z | HEALTHY | all 3 sensors reporting |",
    ];
    const body = buildBody("HEALTHY", "2026-01-03T00:00:00.000Z", [], false, "sensor.bin_scraper_", rows);
    expect(extractHistoryRows(body)).toEqual(rows);
  });
});

describe("run()", () => {
  it("returns early without GitHub calls when no repo is configured", async () => {
    mockHaConfigRepo.value = undefined;
    mockFleetInfraRepo.value = undefined;
    mockListStates.mockResolvedValue(MISSING_SENSORS);

    await run();

    expect(mockFindIssueByExactTitle).not.toHaveBeenCalled();
    expect(mockCreateIssue).not.toHaveBeenCalled();
  });

  it("returns early without GitHub calls when disabled", async () => {
    mockBinDayMonitorEnabled.value = false;
    await run();
    expect(mockFindIssueByExactTitle).not.toHaveBeenCalled();
    expect(mockCreateIssue).not.toHaveBeenCalled();
    expect(mockEditIssue).not.toHaveBeenCalled();
  });

  it("returns early without GitHub calls when isConfigured() is false", async () => {
    mockIsConfigured.mockReturnValue(false);
    await run();
    expect(mockFindIssueByExactTitle).not.toHaveBeenCalled();
  });

  it("creates issue when sensor is missing and no existing issue", async () => {
    mockListStates.mockResolvedValue(MISSING_SENSORS);
    mockFindIssueByExactTitle.mockResolvedValue(null);

    await run();

    expect(mockCreateIssue).toHaveBeenCalledOnce();
    const [, title, body, labels] = mockCreateIssue.mock.calls[0]!;
    expect(title).toBe("[bin-day-monitor] Bin day sensors missing values");
    expect(body).toContain("**Current status:** MISSING");
    expect(labels).toContain("Priority");
    expect(mockCloseIssue).not.toHaveBeenCalled();
  });

  it("does not create issue when healthy and no existing issue", async () => {
    mockListStates.mockResolvedValue(HEALTHY_SENSORS);
    mockFindIssueByExactTitle.mockResolvedValue(null);

    await run();

    expect(mockCreateIssue).not.toHaveBeenCalled();
    expect(mockEditIssue).not.toHaveBeenCalled();
  });

  it("recovery: edits existing issue with HEALTHY status and two history rows, never closes", async () => {
    const existingRow = "| 2026-01-01T00:00:00.000Z | MISSING | 1 sensor(s) missing: sensor.bin_scraper_general_waste_next_collection |";
    const existingBody = buildBody(
      "MISSING",
      "2026-01-01T00:00:00.000Z",
      [makeState("sensor.bin_scraper_general_waste_next_collection", "unavailable")],
      false,
      "sensor.bin_scraper_",
      [existingRow],
    );

    mockListStates.mockResolvedValue(HEALTHY_SENSORS);
    mockFindIssueByExactTitle.mockResolvedValue({ number: 7, title: "[bin-day-monitor] Bin day sensors missing values" });
    mockGetIssueBody.mockResolvedValue(existingBody);

    await run();

    expect(mockEditIssue).toHaveBeenCalledOnce();
    const [, issueNumber, newBody] = mockEditIssue.mock.calls[0]!;
    expect(issueNumber).toBe(7);
    expect(newBody).toContain("**Current status:** HEALTHY");
    const rows = extractHistoryRows(newBody);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toBe(existingRow);
    expect(rows[1]).toContain("HEALTHY");
    expect(mockCloseIssue).not.toHaveBeenCalled();
  });

  it("existing MISSING issue, still MISSING — edits body but does not append a history row", async () => {
    const existingRow = "| 2026-01-01T00:00:00.000Z | MISSING | 1 sensor(s) missing: sensor.bin_scraper_general_waste_next_collection |";
    const existingBody = buildBody("MISSING", "2026-01-01T00:00:00.000Z", [], false, "sensor.bin_scraper_", [existingRow]);

    mockListStates.mockResolvedValue(MISSING_SENSORS);
    mockFindIssueByExactTitle.mockResolvedValue({ number: 7, title: "[bin-day-monitor] Bin day sensors missing values" });
    mockGetIssueBody.mockResolvedValue(existingBody);

    await run();

    expect(mockEditIssue).toHaveBeenCalledOnce();
    const [, , newBody] = mockEditIssue.mock.calls[0]!;
    expect(newBody).toContain("**Current status:** MISSING");
    const rows = extractHistoryRows(newBody);
    expect(rows).toHaveLength(1); // no new row appended
    expect(mockCloseIssue).not.toHaveBeenCalled();
  });

  it("zero sensors match prefix → creates MISSING issue with noneFound detail", async () => {
    mockListStates.mockResolvedValue([makeState("sensor.something_else", "ok")]);
    mockFindIssueByExactTitle.mockResolvedValue(null);

    await run();

    expect(mockCreateIssue).toHaveBeenCalledOnce();
    const [, , body] = mockCreateIssue.mock.calls[0]!;
    expect(body).toContain("**Current status:** MISSING");
    expect(body).toContain("No entities matched prefix");
  });

  it("steady-state HEALTHY: edits existing HEALTHY issue without appending a history row", async () => {
    const existingBody = buildBody("HEALTHY", "2026-01-01T00:00:00.000Z", [], false, "sensor.bin_scraper_", []);
    mockListStates.mockResolvedValue(HEALTHY_SENSORS);
    mockFindIssueByExactTitle.mockResolvedValue({ number: 7, title: "[bin-day-monitor] Bin day sensors missing values" });
    mockGetIssueBody.mockResolvedValue(existingBody);

    await run();

    expect(mockEditIssue).toHaveBeenCalledOnce();
    const [, , newBody] = mockEditIssue.mock.calls[0]!;
    expect(newBody).toContain("**Current status:** HEALTHY");
    expect(extractHistoryRows(newBody)).toHaveLength(0);
    expect(mockCloseIssue).not.toHaveBeenCalled();
  });

  it("listStates throwing does not throw out of run(), no GitHub calls", async () => {
    mockListStates.mockRejectedValue(new Error("HA unreachable"));

    await expect(run()).resolves.toBeUndefined();
    expect(mockFindIssueByExactTitle).not.toHaveBeenCalled();
  });

  it("findIssueByExactTitle rejection does not throw out of run()", async () => {
    mockListStates.mockResolvedValue(MISSING_SENSORS);
    mockFindIssueByExactTitle.mockRejectedValue(new Error("GitHub API error"));

    await expect(run()).resolves.toBeUndefined();
    expect(mockCreateIssue).not.toHaveBeenCalled();
  });

  it("editIssue rejection does not throw out of run()", async () => {
    const existingBody = buildBody("MISSING", "2026-01-01T00:00:00.000Z", [], true, "sensor.bin_scraper_", []);
    mockListStates.mockResolvedValue(HEALTHY_SENSORS);
    mockFindIssueByExactTitle.mockResolvedValue({ number: 7, title: "[bin-day-monitor] Bin day sensors missing values" });
    mockGetIssueBody.mockResolvedValue(existingBody);
    mockEditIssue.mockRejectedValue(new Error("edit failed"));

    await expect(run()).resolves.toBeUndefined();
  });
});
