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
  info: vi.fn(),
}));

const mockFindIssueByExactTitle = vi.hoisted(() => vi.fn());
const mockCreateIssue = vi.hoisted(() => vi.fn());
const mockGetIssueBody = vi.hoisted(() => vi.fn());
const mockEditIssue = vi.hoisted(() => vi.fn());
vi.mock("../github.js", () => ({
  findIssueByExactTitle: mockFindIssueByExactTitle,
  createIssue: mockCreateIssue,
  getIssueBody: mockGetIssueBody,
  editIssue: mockEditIssue,
}));

import { resolveHaMonitorContext } from "./ha-monitor-common.js";
import { upsertAlertIssue } from "../occurrence-tracking.js";
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

describe("upsertAlertIssue", () => {
  const repo = "St-John-Software/home-assistant-config";
  const title = "[test-monitor] Something is wrong";
  const body = "the body";

  it("creates an issue when none exists", async () => {
    mockFindIssueByExactTitle.mockResolvedValue(null);

    const result = await upsertAlertIssue({ repo, title, body, labels: ["Priority"], logPrefix: LOG_PREFIX });

    expect(mockCreateIssue).toHaveBeenCalledWith(repo, title, body, ["Priority"]);
    expect(mockGetIssueBody).not.toHaveBeenCalled();
    expect(mockEditIssue).not.toHaveBeenCalled();
    expect(result).toBe("created");
  });

  it("edits the issue when the body changed", async () => {
    mockFindIssueByExactTitle.mockResolvedValue({ number: 7 });
    mockGetIssueBody.mockResolvedValue("old body");

    const result = await upsertAlertIssue({ repo, title, body, labels: ["Priority"], logPrefix: LOG_PREFIX });

    expect(mockFindIssueByExactTitle).toHaveBeenCalledWith(repo, title);
    expect(mockEditIssue).toHaveBeenCalledWith(repo, 7, body);
    expect(mockCreateIssue).not.toHaveBeenCalled();
    expect(result).toBe("updated");
  });

  it("skips the edit when the body is byte-identical", async () => {
    mockFindIssueByExactTitle.mockResolvedValue({ number: 7 });
    mockGetIssueBody.mockResolvedValue(body);

    const result = await upsertAlertIssue({ repo, title, body, labels: ["Priority"], logPrefix: LOG_PREFIX });

    expect(mockEditIssue).not.toHaveBeenCalled();
    expect(result).toBe("unchanged");
  });

  it("treats a null current body and empty new body as identical", async () => {
    mockFindIssueByExactTitle.mockResolvedValue({ number: 7 });
    mockGetIssueBody.mockResolvedValue(null as never);

    const result = await upsertAlertIssue({ repo, title, body: "", labels: ["Priority"], logPrefix: LOG_PREFIX });

    expect(mockEditIssue).not.toHaveBeenCalled();
    expect(result).toBe("unchanged");
  });

  it("appends createdDetail to the create log line when supplied", async () => {
    mockFindIssueByExactTitle.mockResolvedValue(null);

    await upsertAlertIssue({ repo, title, body, labels: ["Priority"], logPrefix: LOG_PREFIX, createdDetail: "3 device(s) low" });

    expect(log.info).toHaveBeenCalledWith(expect.stringContaining("3 device(s) low"));
  });

  it("ends the create log line with the title when createdDetail is omitted", async () => {
    mockFindIssueByExactTitle.mockResolvedValue(null);

    await upsertAlertIssue({ repo, title, body, labels: ["Priority"], logPrefix: LOG_PREFIX });

    const message = vi.mocked(log.info).mock.calls[0][0];
    expect(message.endsWith(title)).toBe(true);
  });
});
