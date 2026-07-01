import { describe, it, expect, vi, beforeEach } from "vitest";

const mockHaConfigRepo = vi.hoisted(() => ({ value: undefined as string | undefined }));
const mockFleetInfraRepo = vi.hoisted(() => ({ value: undefined as string | undefined }));

vi.mock("../config.js", () => ({
  get HOME_ASSISTANT_CONFIG_REPO() { return mockHaConfigRepo.value; },
  get FLEET_INFRA_REPO() { return mockFleetInfraRepo.value; },
}));

const mockIsConfigured = vi.hoisted(() => vi.fn(() => true));
const mockListStates = vi.hoisted(() => vi.fn());
vi.mock("../home-assistant.js", () => ({
  isConfigured: mockIsConfigured,
  listStates: mockListStates,
}));

vi.mock("../log.js", () => ({
  debug: vi.fn(),
  warn: vi.fn(),
}));

import { resolveHaMonitorContext } from "./ha-monitor-common.js";
import * as log from "../log.js";
import type { HAState } from "../home-assistant.js";

const LOG_PREFIX = "test-monitor";

beforeEach(() => {
  vi.clearAllMocks();
  mockHaConfigRepo.value = "St-John-Software/home-assistant-config";
  mockFleetInfraRepo.value = undefined;
  mockIsConfigured.mockReturnValue(true);
});

describe("resolveHaMonitorContext", () => {
  it("returns null and logs debug when disabled", async () => {
    const result = await resolveHaMonitorContext(false, LOG_PREFIX);

    expect(result).toBeNull();
    expect(log.debug).toHaveBeenCalledWith(`[${LOG_PREFIX}] Disabled — skipping`);
    expect(mockListStates).not.toHaveBeenCalled();
  });

  it("returns null and logs debug when HA is not configured", async () => {
    mockIsConfigured.mockReturnValue(false);

    const result = await resolveHaMonitorContext(true, LOG_PREFIX);

    expect(result).toBeNull();
    expect(log.debug).toHaveBeenCalledWith(`[${LOG_PREFIX}] HA token/URL not configured — skipping`);
    expect(mockListStates).not.toHaveBeenCalled();
  });

  it("returns null and logs warn when no repo is configured", async () => {
    mockHaConfigRepo.value = undefined;
    mockFleetInfraRepo.value = undefined;

    const result = await resolveHaMonitorContext(true, LOG_PREFIX);

    expect(result).toBeNull();
    expect(log.warn).toHaveBeenCalledWith(
      `[${LOG_PREFIX}] No repo configured (homeAssistantConfigRepo or fleetInfraRepo) — skipping`,
    );
    expect(mockListStates).not.toHaveBeenCalled();
  });

  it("returns repo and states on the happy path", async () => {
    const states: HAState[] = [
      { entity_id: "sensor.a", state: "1", attributes: {}, last_changed: "", last_updated: "" },
    ];
    mockListStates.mockResolvedValue(states);

    const result = await resolveHaMonitorContext(true, LOG_PREFIX);

    expect(result).toEqual({ repo: "St-John-Software/home-assistant-config", states });
  });

  it("falls back to FLEET_INFRA_REPO when HOME_ASSISTANT_CONFIG_REPO is empty", async () => {
    mockHaConfigRepo.value = "";
    mockFleetInfraRepo.value = "org/fleet";
    mockListStates.mockResolvedValue([]);

    const result = await resolveHaMonitorContext(true, LOG_PREFIX);

    expect(result?.repo).toBe("org/fleet");
  });

  it("returns null and logs warn when listStates throws", async () => {
    mockListStates.mockRejectedValue(new Error("HA unreachable"));

    const result = await resolveHaMonitorContext(true, LOG_PREFIX);

    expect(result).toBeNull();
    expect(log.warn).toHaveBeenCalledWith(`[${LOG_PREFIX}] Could not fetch HA states: HA unreachable`);
  });
});
