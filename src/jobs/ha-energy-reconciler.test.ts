import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Hoisted mocks ──

const mockEnabled = vi.hoisted(() => ({ value: true }));
const mockHaConfigRepo = vi.hoisted(() => ({ value: "St-John-Software/home-assistant-config" as string | undefined }));

vi.mock("../config.js", () => ({
  get HOME_ASSISTANT_ENERGY_RECONCILER_ENABLED() { return mockEnabled.value; },
  get HOME_ASSISTANT_CONFIG_REPO() { return mockHaConfigRepo.value; },
  LABELS: { priority: "Priority" },
}));

const mockFetchRepoFileContent = vi.hoisted(() => vi.fn());
vi.mock("../github.js", () => ({
  fetchRepoFileContent: mockFetchRepoFileContent,
}));

const mockIsConfigured = vi.hoisted(() => vi.fn(() => true));
const mockWithHaWebSocket = vi.hoisted(() => vi.fn());
const mockGetEnergyPrefs = vi.hoisted(() => vi.fn());
const mockSaveEnergyPrefs = vi.hoisted(() => vi.fn());
vi.mock("../home-assistant.js", () => ({
  ENTITY_ID_RE: /^[a-z_]+\.[a-z0-9_]+$/,
  isConfigured: mockIsConfigured,
  withHaWebSocket: mockWithHaWebSocket,
  getEnergyPrefs: mockGetEnergyPrefs,
  saveEnergyPrefs: mockSaveEnergyPrefs,
}));

const mockUpsertAlertIssue = vi.hoisted(() => vi.fn());
const mockCloseAlertIssueIfResolved = vi.hoisted(() => vi.fn());
vi.mock("../occurrence-tracking.js", () => ({
  upsertAlertIssue: mockUpsertAlertIssue,
  closeAlertIssueIfResolved: mockCloseAlertIssueIfResolved,
}));

const mockNotify = vi.hoisted(() => vi.fn());
vi.mock("../slack.js", () => ({ notify: mockNotify }));

vi.mock("../log.js", () => ({
  info: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
  error: vi.fn(),
}));

import { run, parseEnergyManifest, prefsEqual, summariseDiff, buildGuardBody } from "./ha-energy-reconciler.js";
import type { HaEnergyPrefs } from "../home-assistant.js";

const GUARD_TITLE = "[ha-energy-reconciler] registry/energy.yaml would wipe the Energy dashboard";

const LIVE_PREFS: HaEnergyPrefs = {
  energy_sources: [
    {
      type: "grid",
      stat_energy_from: "sensor.shellyem_3494547bb086_channel_1_energy",
      number_energy_price: 0.3062,
      cost_adjustment_day: 0.0,
      stat_cost: null,
    },
    { type: "water", stat_energy_from: "sensor.wm_water_meter_total", stat_cost: null },
  ],
  device_consumption: [
    {
      name: "Washing machine",
      stat_consumption: "sensor.think_centre_switch_0_energy",
      stat_rate: "sensor.think_centre_switch_0_power",
    },
  ],
  device_consumption_water: [],
};

const MATCHING_MANIFEST = `
energy_sources:
  - type: grid
    stat_energy_from: sensor.shellyem_3494547bb086_channel_1_energy
    number_energy_price: 0.3062
    cost_adjustment_day: 0
    stat_cost: null
  - type: water
    stat_energy_from: sensor.wm_water_meter_total
device_consumption:
  - name: Washing machine
    stat_consumption: sensor.think_centre_switch_0_energy
    stat_rate: sensor.think_centre_switch_0_power
device_consumption_water: []
`;

beforeEach(() => {
  vi.clearAllMocks();
  mockEnabled.value = true;
  mockHaConfigRepo.value = "St-John-Software/home-assistant-config";
  mockIsConfigured.mockReturnValue(true);
  mockWithHaWebSocket.mockImplementation((fn: (s: unknown) => Promise<unknown>) => fn({}));
  mockGetEnergyPrefs.mockResolvedValue(structuredClone(LIVE_PREFS));
  mockSaveEnergyPrefs.mockResolvedValue(undefined);
  mockUpsertAlertIssue.mockResolvedValue("created");
  mockCloseAlertIssueIfResolved.mockResolvedValue(null);
  mockNotify.mockResolvedValue(undefined);
});

describe("parseEnergyManifest", () => {
  it("parses a valid three-key file", () => {
    const { prefs, errors } = parseEnergyManifest(MATCHING_MANIFEST);
    expect(errors).toEqual([]);
    expect(prefs).not.toBeNull();
    expect(Object.keys(prefs!).sort()).toEqual(["device_consumption", "device_consumption_water", "energy_sources"]);
  });

  it("omits a key the file does not declare", () => {
    const { prefs, errors } = parseEnergyManifest("energy_sources:\n  - type: grid\n");
    expect(errors).toEqual([]);
    expect(Object.keys(prefs!)).toEqual(["energy_sources"]);
  });

  it("rejects an unknown top-level key", () => {
    const { prefs, errors } = parseEnergyManifest("energy_sources: []\nbogus_key: 1\n");
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("unknown top-level key");
    expect(prefs).toBeNull();
  });

  it("rejects a non-array value for a declared key", () => {
    const { prefs, errors } = parseEnergyManifest("device_consumption: nope\n");
    expect(errors.length).toBeGreaterThan(0);
    expect(prefs).toBeNull();
  });

  it("reports a parse error for broken YAML", () => {
    const { prefs, errors } = parseEnergyManifest("energy_sources: [\n");
    expect(errors).toHaveLength(1);
    expect(prefs).toBeNull();
  });
});

describe("prefsEqual", () => {
  it("returns true for identical prefs", () => {
    expect(
      prefsEqual(LIVE_PREFS, {
        energy_sources: LIVE_PREFS["energy_sources"] as unknown[],
        device_consumption: LIVE_PREFS["device_consumption"] as unknown[],
        device_consumption_water: LIVE_PREFS["device_consumption_water"] as unknown[],
      }),
    ).toBe(true);
  });

  it("treats an omitted key as equal to an explicit null value", () => {
    const live: HaEnergyPrefs = { energy_sources: [{ stat_energy_from: "sensor.a", stat_cost: null }] };
    const want = { energy_sources: [{ stat_energy_from: "sensor.a" }] };
    expect(prefsEqual(live, want)).toBe(true);
  });

  it("treats an empty array as equal to an omitted key", () => {
    const live: HaEnergyPrefs = { energy_sources: [], device_consumption_water: [] };
    const want = { energy_sources: [] as unknown[] };
    expect(prefsEqual(live, want)).toBe(true);
  });

  it("is order-sensitive", () => {
    const live: HaEnergyPrefs = {
      device_consumption: [{ stat_consumption: "sensor.a" }, { stat_consumption: "sensor.b" }],
    };
    const want = {
      device_consumption: [{ stat_consumption: "sensor.b" }, { stat_consumption: "sensor.a" }],
    };
    expect(prefsEqual(live, want)).toBe(false);
  });

  it("detects an added field on an existing entry", () => {
    const live: HaEnergyPrefs = { device_consumption: [{ stat_consumption: "sensor.a" }] };
    const want = { device_consumption: [{ stat_consumption: "sensor.a", included_in_stat: "sensor.grid" }] };
    expect(prefsEqual(live, want)).toBe(false);
  });

  it("treats 0 and 0.0 as equal", () => {
    const live: HaEnergyPrefs = { energy_sources: [{ stat_energy_from: "sensor.a", cost_adjustment_day: 0.0 }] };
    const want = { energy_sources: [{ stat_energy_from: "sensor.a", cost_adjustment_day: 0 }] };
    expect(prefsEqual(live, want)).toBe(true);
  });
});

describe("summariseDiff", () => {
  it("reports an added device", () => {
    const live: HaEnergyPrefs = { device_consumption: [] };
    const want = { device_consumption: [{ name: "Tumble Dryer", stat_consumption: "sensor.dryer" }] };
    expect(summariseDiff(live, want)).toContain("+Tumble Dryer");
  });

  it("reports a renamed device as changed", () => {
    const live: HaEnergyPrefs = { device_consumption: [{ name: "Old Name", stat_consumption: "sensor.a" }] };
    const want = { device_consumption: [{ name: "New Name", stat_consumption: "sensor.a" }] };
    expect(summariseDiff(live, want)).toContain("~New Name");
  });

  it("reports a removed device", () => {
    const live: HaEnergyPrefs = { device_consumption: [{ name: "Old Device", stat_consumption: "sensor.a" }] };
    const want = { device_consumption: [] as unknown[] };
    expect(summariseDiff(live, want)).toContain("-Old Device");
  });

  it("sanitises a name containing a backtick or newline", () => {
    const live: HaEnergyPrefs = { device_consumption: [] };
    const want = {
      device_consumption: [{ name: "Weird`Name\nHere", stat_consumption: "sensor.a" }],
    };
    const summary = summariseDiff(live, want);
    expect(summary).not.toContain("`");
    expect(summary).not.toContain("\n");
  });
});

describe("buildGuardBody", () => {
  it("lists entity-id-shaped source ids and masks anything else", () => {
    const body = buildGuardBody(["sensor.shellyem_3494547bb086_channel_1_energy", "not an entity id"]);
    expect(body).toContain("`sensor.shellyem_3494547bb086_channel_1_energy`");
    expect(body).toContain("(non-entity source)");
    expect(body).not.toContain("not an entity id");
  });
});

describe("run()", () => {
  it("returns early when disabled", async () => {
    mockEnabled.value = false;
    await run();
    expect(mockFetchRepoFileContent).not.toHaveBeenCalled();
    expect(mockWithHaWebSocket).not.toHaveBeenCalled();
  });

  it("returns early when HA is not configured", async () => {
    mockIsConfigured.mockReturnValue(false);
    await run();
    expect(mockFetchRepoFileContent).not.toHaveBeenCalled();
  });

  it("no-ops when the manifest is absent", async () => {
    mockFetchRepoFileContent.mockResolvedValue(null);
    await run();
    expect(mockWithHaWebSocket).not.toHaveBeenCalled();
    expect(mockUpsertAlertIssue).not.toHaveBeenCalled();
  });

  it("skips without touching HA when the manifest fails to parse", async () => {
    mockFetchRepoFileContent.mockResolvedValue("device_consumption: nope\n");
    await run();
    expect(mockWithHaWebSocket).not.toHaveBeenCalled();
    expect(mockSaveEnergyPrefs).not.toHaveBeenCalled();
    expect(mockUpsertAlertIssue).not.toHaveBeenCalled();
  });

  it("does not save or notify when prefs already match", async () => {
    mockFetchRepoFileContent.mockResolvedValue(MATCHING_MANIFEST);
    await run();
    expect(mockSaveEnergyPrefs).not.toHaveBeenCalled();
    expect(mockNotify).not.toHaveBeenCalled();
  });

  it("saves and notifies when a device is added", async () => {
    const manifestWithNewDevice = `
energy_sources:
  - type: grid
    stat_energy_from: sensor.shellyem_3494547bb086_channel_1_energy
    number_energy_price: 0.3062
    cost_adjustment_day: 0
    stat_cost: null
  - type: water
    stat_energy_from: sensor.wm_water_meter_total
device_consumption:
  - name: Washing machine
    stat_consumption: sensor.think_centre_switch_0_energy
    stat_rate: sensor.think_centre_switch_0_power
  - name: Tumble Dryer
    stat_consumption: sensor.dryer
device_consumption_water: []
`;
    mockFetchRepoFileContent.mockResolvedValue(manifestWithNewDevice);
    await run();

    expect(mockSaveEnergyPrefs).toHaveBeenCalledOnce();
    const saved = mockSaveEnergyPrefs.mock.calls[0]![1] as Record<string, unknown[]>;
    expect(saved["device_consumption"]).toContainEqual(
      expect.objectContaining({ name: "Tumble Dryer", stat_consumption: "sensor.dryer" }),
    );
    expect(mockNotify).toHaveBeenCalledOnce();
    expect(mockNotify.mock.calls[0]![0]).toContain("Tumble Dryer");
  });

  it("refuses and alerts on an empty energy_sources guard, without saving", async () => {
    mockFetchRepoFileContent.mockResolvedValue("energy_sources: []\n");
    await run();

    expect(mockSaveEnergyPrefs).not.toHaveBeenCalled();
    expect(mockUpsertAlertIssue).toHaveBeenCalledOnce();
    const opts = mockUpsertAlertIssue.mock.calls[0]![0];
    expect(opts.title).toBe(GUARD_TITLE);
    expect(opts.labels).toContain("Priority");
    expect(mockCloseAlertIssueIfResolved).not.toHaveBeenCalled();
  });

  it("closes the guard alert when sources are present", async () => {
    mockFetchRepoFileContent.mockResolvedValue(MATCHING_MANIFEST);
    await run();

    expect(mockCloseAlertIssueIfResolved).toHaveBeenCalledOnce();
    expect(mockCloseAlertIssueIfResolved.mock.calls[0]![0].title).toBe(GUARD_TITLE);
  });

  it("warns without throwing when Home Assistant is unreachable", async () => {
    mockFetchRepoFileContent.mockResolvedValue(MATCHING_MANIFEST);
    mockWithHaWebSocket.mockRejectedValue(new Error("connect ECONNREFUSED"));

    await expect(run()).resolves.toBeUndefined();
    expect(mockSaveEnergyPrefs).not.toHaveBeenCalled();
  });

  it("warns without throwing when saving Energy prefs fails", async () => {
    const manifestWithNewDevice = `
energy_sources:
  - type: grid
    stat_energy_from: sensor.shellyem_3494547bb086_channel_1_energy
    number_energy_price: 0.3062
    cost_adjustment_day: 0
    stat_cost: null
  - type: water
    stat_energy_from: sensor.wm_water_meter_total
device_consumption:
  - name: Washing machine
    stat_consumption: sensor.think_centre_switch_0_energy
    stat_rate: sensor.think_centre_switch_0_power
  - name: Tumble Dryer
    stat_consumption: sensor.dryer
device_consumption_water: []
`;
    mockFetchRepoFileContent.mockResolvedValue(manifestWithNewDevice);
    mockSaveEnergyPrefs.mockRejectedValue(new Error("save failed"));

    await expect(run()).resolves.toBeUndefined();
    expect(mockNotify).not.toHaveBeenCalled();
  });
});
