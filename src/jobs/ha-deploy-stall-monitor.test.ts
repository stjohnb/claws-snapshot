import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Hoisted mocks ──

const mockDeployStallMonitorEnabled = vi.hoisted(() => ({ value: true }));
const mockHaConfigRepo = vi.hoisted(() => ({ value: "St-John-Software/home-assistant-config" as string | undefined }));
const mockFleetInfraRepo = vi.hoisted(() => ({ value: undefined as string | undefined }));

vi.mock("../config.js", () => ({
  get HOME_ASSISTANT_DEPLOY_STALL_MONITOR_ENABLED() { return mockDeployStallMonitorEnabled.value; },
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
  readStalled,
  readAddonState,
  buildStallBody,
} from "./ha-deploy-stall-monitor.js";
import type { HAState } from "../home-assistant.js";

const ALERT_TITLE = "[ha-deploy-stall-monitor] Home Assistant deploy pipeline stalled — core_git_pull did not self-heal";
const REPO = "St-John-Software/home-assistant-config";

function makeStalled(state: string): HAState {
  return { entity_id: "binary_sensor.deploy_pipeline_stalled", state, attributes: {}, last_changed: "", last_updated: "" };
}

function makeAddonState(state: string): HAState {
  return { entity_id: "sensor.git_pull_addon_state", state, attributes: {}, last_changed: "", last_updated: "" };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockDeployStallMonitorEnabled.value = true;
  mockHaConfigRepo.value = REPO;
  mockFleetInfraRepo.value = undefined;
  mockIsConfigured.mockReturnValue(true);
  mockFindIssueByExactTitle.mockResolvedValue(null);
  mockCreateIssue.mockResolvedValue(undefined);
  mockGetIssueBody.mockResolvedValue("");
  mockEditIssue.mockResolvedValue(undefined);
  mockCloseIssue.mockResolvedValue(undefined);
});

describe("readStalled", () => {
  it("returns null when absent", () => {
    expect(readStalled([])).toBeNull();
  });

  it("returns null for unknown, unavailable, and empty string", () => {
    expect(readStalled([makeStalled("unknown")])).toBeNull();
    expect(readStalled([makeStalled("unavailable")])).toBeNull();
    expect(readStalled([makeStalled("")])).toBeNull();
  });

  it("returns on/off", () => {
    expect(readStalled([makeStalled("on")])).toBe("on");
    expect(readStalled([makeStalled("off")])).toBe("off");
  });
});

describe("readAddonState", () => {
  it("returns null when absent", () => {
    expect(readAddonState([])).toBeNull();
  });

  it("returns null when unavailable/unknown/empty", () => {
    expect(readAddonState([makeAddonState("unavailable")])).toBeNull();
    expect(readAddonState([makeAddonState("unknown")])).toBeNull();
    expect(readAddonState([makeAddonState("")])).toBeNull();
  });

  it("returns the state string otherwise", () => {
    expect(readAddonState([makeAddonState("error")])).toBe("error");
  });
});

describe("run()", () => {
  it("returns early when disabled", async () => {
    mockDeployStallMonitorEnabled.value = false;
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

  it("stalled on, no existing issue → createIssue with ALERT_TITLE and Priority label", async () => {
    mockListStates.mockResolvedValue([makeStalled("on"), makeAddonState("error")]);

    await run();

    expect(mockCreateIssue).toHaveBeenCalledOnce();
    const [repo, title, , labels] = mockCreateIssue.mock.calls[0]!;
    expect(repo).toBe(REPO);
    expect(title).toBe(ALERT_TITLE);
    expect(labels).toContain("Priority");
  });

  it("stalled on, existing issue with byte-identical body → no createIssue/editIssue", async () => {
    mockListStates.mockResolvedValue([makeStalled("on"), makeAddonState("error")]);
    mockFindIssueByExactTitle.mockResolvedValue({ number: 7, title: ALERT_TITLE });
    mockGetIssueBody.mockResolvedValue(buildStallBody("error"));

    await run();

    expect(mockCreateIssue).not.toHaveBeenCalled();
    expect(mockEditIssue).not.toHaveBeenCalled();
  });

  it("stalled on, existing issue with different stored body → editIssue(repo, 7, body)", async () => {
    mockListStates.mockResolvedValue([makeStalled("on"), makeAddonState("error")]);
    mockFindIssueByExactTitle.mockResolvedValue({ number: 7, title: ALERT_TITLE });
    mockGetIssueBody.mockResolvedValue("stale body");

    await run();

    expect(mockEditIssue).toHaveBeenCalledWith(REPO, 7, buildStallBody("error"));
  });

  it("stalled off, existing open issue → closeIssue(repo, 7, 'completed')", async () => {
    mockListStates.mockResolvedValue([makeStalled("off")]);
    mockFindIssueByExactTitle.mockResolvedValue({ number: 7, title: ALERT_TITLE });

    await run();

    expect(mockCloseIssue).toHaveBeenCalledWith(REPO, 7, "completed");
  });

  it("stalled off, no open issue → no GitHub writes", async () => {
    mockListStates.mockResolvedValue([makeStalled("off")]);

    await run();

    expect(mockCreateIssue).not.toHaveBeenCalled();
    expect(mockEditIssue).not.toHaveBeenCalled();
    expect(mockCloseIssue).not.toHaveBeenCalled();
  });

  it("unknown, unavailable, and absent → no GitHub calls at all in any case", async () => {
    for (const states of [[makeStalled("unknown")], [makeStalled("unavailable")], []]) {
      vi.clearAllMocks();
      mockFindIssueByExactTitle.mockResolvedValue(null);
      mockListStates.mockResolvedValue(states);

      await run();

      expect(mockFindIssueByExactTitle).not.toHaveBeenCalled();
      expect(mockCreateIssue).not.toHaveBeenCalled();
      expect(mockEditIssue).not.toHaveBeenCalled();
      expect(mockCloseIssue).not.toHaveBeenCalled();
    }
  });

  it("createIssue rejecting → run() resolves without throwing", async () => {
    mockListStates.mockResolvedValue([makeStalled("on")]);
    mockCreateIssue.mockRejectedValue(new Error("GitHub error"));

    await expect(run()).resolves.toBeUndefined();
  });
});

describe("buildStallBody", () => {
  it("contains the addon state and the runbook Permission denied line", () => {
    const body = buildStallBody("error");
    expect(body).toContain("`error`");
    expect(body).toContain("Permission denied (publickey)");
  });

  it("renders 'unknown' when addonState is null", () => {
    const body = buildStallBody(null);
    expect(body).toContain("`unknown`");
  });
});
