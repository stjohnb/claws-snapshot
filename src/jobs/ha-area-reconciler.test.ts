import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Hoisted mocks ──

const mockEnabled = vi.hoisted(() => ({ value: true }));
const mockHaConfigRepo = vi.hoisted(() => ({ value: "St-John-Software/home-assistant-config" as string | undefined }));

vi.mock("../config.js", () => ({
  get HOME_ASSISTANT_AREA_RECONCILER_ENABLED() { return mockEnabled.value; },
  get HOME_ASSISTANT_CONFIG_REPO() { return mockHaConfigRepo.value; },
  LABELS: { priority: "Priority" },
}));

const mockFetchRepoFileContent = vi.hoisted(() => vi.fn());
vi.mock("../github.js", () => ({
  fetchRepoFileContent: mockFetchRepoFileContent,
}));

const mockIsConfigured = vi.hoisted(() => vi.fn(() => true));
const mockWithHaWebSocket = vi.hoisted(() => vi.fn());
const mockListAreaRegistry = vi.hoisted(() => vi.fn());
const mockListEntityRegistry = vi.hoisted(() => vi.fn());
const mockSetEntityArea = vi.hoisted(() => vi.fn());
vi.mock("../home-assistant.js", () => ({
  isConfigured: mockIsConfigured,
  withHaWebSocket: mockWithHaWebSocket,
  listAreaRegistry: mockListAreaRegistry,
  listEntityRegistry: mockListEntityRegistry,
  setEntityArea: mockSetEntityArea,
}));

const mockEnsureAlertIssue = vi.hoisted(() => vi.fn());
const mockCloseAlertIssueIfResolved = vi.hoisted(() => vi.fn());
vi.mock("../occurrence-tracking.js", () => ({
  ensureAlertIssue: mockEnsureAlertIssue,
  closeAlertIssueIfResolved: mockCloseAlertIssueIfResolved,
}));

const mockNotify = vi.hoisted(() => vi.fn());
vi.mock("../slack.js", () => ({ notify: mockNotify }));

const mockSleep = vi.hoisted(() => vi.fn(() => Promise.resolve()));
vi.mock("../util.js", () => ({ sleep: mockSleep }));

const mockIsShuttingDown = vi.hoisted(() => vi.fn(() => false));
vi.mock("../shutdown.js", () => ({ isShuttingDown: mockIsShuttingDown }));

vi.mock("../log.js", () => ({
  info: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
  error: vi.fn(),
}));

import { run, parseAreaManifest, diffAreas, buildAlertBody } from "./ha-area-reconciler.js";
import type { HaAreaEntry, HaEntityRegistryEntry } from "../home-assistant.js";

function entry(entity_id: string, area_id: string | null, device_id: string | null = null): HaEntityRegistryEntry {
  return { entity_id, area_id, device_id };
}

const AREAS: HaAreaEntry[] = [
  { area_id: "hall", name: "Hall" },
  { area_id: "office", name: "Office" },
];

// Runs the real session callback against the mocked ha.* helpers.
function wireWebSocket(): void {
  mockWithHaWebSocket.mockImplementation(async (fn: (s: unknown) => Promise<unknown>) => fn({ request: vi.fn() }));
}

beforeEach(() => {
  vi.clearAllMocks();
  mockEnabled.value = true;
  mockHaConfigRepo.value = "St-John-Software/home-assistant-config";
  mockIsConfigured.mockReturnValue(true);
  mockIsShuttingDown.mockReturnValue(false);
  mockSleep.mockResolvedValue(undefined);
  mockListAreaRegistry.mockResolvedValue(AREAS);
  mockListEntityRegistry.mockResolvedValue([]);
  mockSetEntityArea.mockResolvedValue(undefined);
  mockEnsureAlertIssue.mockResolvedValue({ outcome: "created", issueNumber: 1 });
  mockCloseAlertIssueIfResolved.mockResolvedValue(null);
  mockNotify.mockResolvedValue(undefined);
  wireWebSocket();
});

describe("parseAreaManifest", () => {
  it("parses a valid manifest", () => {
    const { entities, errors } = parseAreaManifest(
      "entities:\n  sensor.daily_house_energy: hall\n  sensor.daily_office_energy: office\n",
    );
    expect(errors).toEqual([]);
    expect([...entities]).toEqual([
      ["sensor.daily_house_energy", "hall"],
      ["sensor.daily_office_energy", "office"],
    ]);
  });

  it("treats an empty entities mapping as valid and empty", () => {
    const { entities, errors } = parseAreaManifest("entities:\n");
    expect(errors).toEqual([]);
    expect(entities.size).toBe(0);
  });

  it("reports one error for malformed YAML", () => {
    const { entities, errors } = parseAreaManifest("entities:\n  - [unclosed\n");
    expect(errors).toHaveLength(1);
    expect(entities.size).toBe(0);
  });

  it("reports an error for a non-string value", () => {
    const { entities, errors } = parseAreaManifest("entities:\n  sensor.a: 42\n");
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("must be a string");
    expect(entities.size).toBe(0);
  });

  it("reports an error for an invalid entity_id", () => {
    const { entities, errors } = parseAreaManifest("entities:\n  Sensor.Bad-Id: hall\n");
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("not a valid entity_id");
    expect(entities.size).toBe(0);
  });

  it("reports an error for an invalid area id", () => {
    const { errors } = parseAreaManifest("entities:\n  sensor.a: Front Hall\n");
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("not a valid area id");
  });

  it("reports an error when the top level is not a mapping", () => {
    expect(parseAreaManifest("- a\n- b\n").errors).toHaveLength(1);
    expect(parseAreaManifest("").errors).toHaveLength(1);
  });

  it("keeps valid entries alongside a rejected one", () => {
    const { entities, errors } = parseAreaManifest("entities:\n  sensor.good: hall\n  bad-id: hall\n");
    expect(errors).toHaveLength(1);
    expect([...entities.keys()]).toEqual(["sensor.good"]);
  });
});

describe("diffAreas", () => {
  it("produces a change for a mismatched area", () => {
    const diff = diffAreas(new Map([["sensor.a", "hall"]]), [entry("sensor.a", "office")], AREAS);
    expect(diff.changes).toEqual([{ entityId: "sensor.a", from: "office", to: "hall" }]);
    expect(diff.okCount).toBe(0);
  });

  it("produces a change from a blank area", () => {
    const diff = diffAreas(new Map([["sensor.a", "hall"]]), [entry("sensor.a", null)], AREAS);
    expect(diff.changes).toEqual([{ entityId: "sensor.a", from: null, to: "hall" }]);
  });

  it("counts an already-correct entity as ok", () => {
    const diff = diffAreas(new Map([["sensor.a", "hall"]]), [entry("sensor.a", "hall")], AREAS);
    expect(diff.changes).toEqual([]);
    expect(diff.okCount).toBe(1);
  });

  it("reports an entity that is not in the registry", () => {
    const diff = diffAreas(new Map([["sensor.gone", "hall"]]), [entry("sensor.a", "hall")], AREAS);
    expect(diff.missingEntities).toEqual(["sensor.gone"]);
    expect(diff.changes).toEqual([]);
  });

  it("reports an unknown area and excludes it from changes", () => {
    const diff = diffAreas(new Map([["sensor.a", "attic"]]), [entry("sensor.a", "hall")], AREAS);
    expect(diff.unknownAreas).toEqual([{ entityId: "sensor.a", areaId: "attic" }]);
    expect(diff.changes).toEqual([]);
    expect(diff.okCount).toBe(0);
  });

  it("flags a device-backed change", () => {
    const diff = diffAreas(new Map([["sensor.a", "hall"]]), [entry("sensor.a", "office", "dev1")], AREAS);
    expect(diff.changes).toHaveLength(1);
    expect(diff.deviceBacked).toEqual(["sensor.a"]);
  });

  it("does not flag a device-backed entity that already matches", () => {
    const diff = diffAreas(new Map([["sensor.a", "hall"]]), [entry("sensor.a", "hall", "dev1")], AREAS);
    expect(diff.deviceBacked).toEqual([]);
  });
});

describe("buildAlertBody", () => {
  it("lists missing entities, unknown areas and the valid area ids", () => {
    const body = buildAlertBody(
      {
        parseErrors: [],
        missingEntities: ["sensor.gone"],
        unknownAreas: [{ entityId: "sensor.a", areaId: "attic" }],
        validAreaIds: ["hall", "office"],
      },
      "2026-08-10T00:00:00.000Z",
    );
    expect(body).toContain("**As of (UTC):** 2026-08-10T00:00:00.000Z");
    expect(body).toContain("sensor.gone");
    expect(body).toContain("`sensor.a` → `attic`");
    expect(body).toContain("`hall`, `office`");
    expect(body).not.toContain("Manifest could not be read");
  });

  it("includes a parse-error section only when there are parse errors", () => {
    const body = buildAlertBody(
      { parseErrors: ["YAML parse error: boom"], missingEntities: [], unknownAreas: [], validAreaIds: [] },
      "2026-08-10T00:00:00.000Z",
    );
    expect(body).toContain("Manifest could not be read");
    expect(body).toContain("boom");
    expect(body).not.toContain("Unknown area ids");
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

  it("no-ops without alerting when the manifest is absent", async () => {
    mockFetchRepoFileContent.mockResolvedValue(null);
    await run();
    expect(mockWithHaWebSocket).not.toHaveBeenCalled();
    expect(mockEnsureAlertIssue).not.toHaveBeenCalled();
    expect(mockCloseAlertIssueIfResolved).not.toHaveBeenCalled();
  });

  it("raises an alert issue for a malformed manifest without touching HA", async () => {
    mockFetchRepoFileContent.mockResolvedValue("entities:\n  sensor.a: 42\n");
    await run();
    expect(mockWithHaWebSocket).not.toHaveBeenCalled();
    expect(mockEnsureAlertIssue).toHaveBeenCalledOnce();
    const opts = mockEnsureAlertIssue.mock.calls[0]![0];
    expect(opts.repo).toBe("St-John-Software/home-assistant-config");
    expect(opts.refreshBody).toBe(true);
    expect(opts.labels).toContain("Priority");
    expect(opts.body).toContain("Manifest could not be read");
  });

  it("applies a change, notifies Slack once and closes the alert issue", async () => {
    mockFetchRepoFileContent.mockResolvedValue("entities:\n  sensor.a: hall\n");
    mockListEntityRegistry.mockResolvedValue([entry("sensor.a", "office")]);

    await run();

    expect(mockSetEntityArea).toHaveBeenCalledOnce();
    expect(mockSetEntityArea.mock.calls[0]!.slice(1)).toEqual(["sensor.a", "hall"]);
    expect(mockNotify).toHaveBeenCalledOnce();
    expect(mockNotify.mock.calls[0]![0]).toContain("sensor.a");
    expect(mockCloseAlertIssueIfResolved).toHaveBeenCalledOnce();
    expect(mockEnsureAlertIssue).not.toHaveBeenCalled();
  });

  it("stays silent on Slack when nothing needed changing", async () => {
    mockFetchRepoFileContent.mockResolvedValue("entities:\n  sensor.a: hall\n");
    mockListEntityRegistry.mockResolvedValue([entry("sensor.a", "hall")]);

    await run();

    expect(mockSetEntityArea).not.toHaveBeenCalled();
    expect(mockNotify).not.toHaveBeenCalled();
    expect(mockCloseAlertIssueIfResolved).toHaveBeenCalledOnce();
  });

  it("retries then alerts when a manifest entity never appears", async () => {
    mockFetchRepoFileContent.mockResolvedValue("entities:\n  sensor.gone: hall\n");
    mockListEntityRegistry.mockResolvedValue([entry("sensor.a", "hall")]);

    await run();

    expect(mockWithHaWebSocket).toHaveBeenCalledTimes(3);
    expect(mockSleep).toHaveBeenCalledTimes(2);
    expect(mockEnsureAlertIssue).toHaveBeenCalledOnce();
    expect(mockEnsureAlertIssue.mock.calls[0]![0].body).toContain("sensor.gone");
    expect(mockCloseAlertIssueIfResolved).not.toHaveBeenCalled();
  });

  it("stops retrying once the entity appears", async () => {
    mockFetchRepoFileContent.mockResolvedValue("entities:\n  sensor.a: hall\n");
    mockListEntityRegistry
      .mockResolvedValueOnce([])
      .mockResolvedValue([entry("sensor.a", null)]);

    await run();

    expect(mockWithHaWebSocket).toHaveBeenCalledTimes(2);
    expect(mockSetEntityArea).toHaveBeenCalledOnce();
    expect(mockEnsureAlertIssue).not.toHaveBeenCalled();
  });

  it("does not sleep for a missing entity while shutting down", async () => {
    mockFetchRepoFileContent.mockResolvedValue("entities:\n  sensor.gone: hall\n");
    mockIsShuttingDown.mockReturnValue(true);

    await run();

    expect(mockWithHaWebSocket).toHaveBeenCalledOnce();
    expect(mockSleep).not.toHaveBeenCalled();
    expect(mockEnsureAlertIssue).toHaveBeenCalledOnce();
  });

  it("alerts for an unknown area id", async () => {
    mockFetchRepoFileContent.mockResolvedValue("entities:\n  sensor.a: attic\n");
    mockListEntityRegistry.mockResolvedValue([entry("sensor.a", "hall")]);

    await run();

    expect(mockSetEntityArea).not.toHaveBeenCalled();
    expect(mockEnsureAlertIssue).toHaveBeenCalledOnce();
    const body = mockEnsureAlertIssue.mock.calls[0]![0].body;
    expect(body).toContain("Unknown area ids");
    expect(body).toContain("`hall`, `office`");
  });

  it("warns without alerting when Home Assistant is unreachable", async () => {
    mockFetchRepoFileContent.mockResolvedValue("entities:\n  sensor.a: hall\n");
    mockWithHaWebSocket.mockRejectedValue(new Error("connect ECONNREFUSED"));

    await expect(run()).resolves.toBeUndefined();

    expect(mockWithHaWebSocket).toHaveBeenCalledTimes(3);
    expect(mockEnsureAlertIssue).not.toHaveBeenCalled();
    expect(mockCloseAlertIssueIfResolved).not.toHaveBeenCalled();
    expect(mockNotify).not.toHaveBeenCalled();
  });

  it("continues past a per-entity update failure", async () => {
    mockFetchRepoFileContent.mockResolvedValue("entities:\n  sensor.a: hall\n  sensor.b: hall\n");
    mockListEntityRegistry.mockResolvedValue([entry("sensor.a", null), entry("sensor.b", null)]);
    mockSetEntityArea.mockRejectedValueOnce(new Error("not_found"));

    await run();

    expect(mockSetEntityArea).toHaveBeenCalledTimes(2);
    expect(mockNotify).toHaveBeenCalledOnce();
    expect(mockNotify.mock.calls[0]![0]).toContain("sensor.b");
    expect(mockNotify.mock.calls[0]![0]).not.toContain("sensor.a");
  });

  it("does not swallow a GitHub error from fetchRepoFileContent", async () => {
    mockFetchRepoFileContent.mockRejectedValue(new Error("HTTP 500"));
    await expect(run()).rejects.toThrow("HTTP 500");
  });
});
