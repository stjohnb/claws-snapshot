import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Hoisted mocks ──

const mockRepairsMonitorEnabled = vi.hoisted(() => ({ value: true }));
const mockHaConfigRepo = vi.hoisted(() => ({ value: "St-John-Software/home-assistant-config" as string | undefined }));
const mockFleetInfraRepo = vi.hoisted(() => ({ value: undefined as string | undefined }));
const mockRepairsIgnore = vi.hoisted(() => ({ value: [] as HaRepairIgnoreRule[] }));

vi.mock("../config.js", () => ({
  get HOME_ASSISTANT_REPAIRS_MONITOR_ENABLED() { return mockRepairsMonitorEnabled.value; },
  get HOME_ASSISTANT_CONFIG_REPO() { return mockHaConfigRepo.value; },
  get FLEET_INFRA_REPO() { return mockFleetInfraRepo.value; },
  get HOME_ASSISTANT_REPAIRS_IGNORE() { return mockRepairsIgnore.value; },
  LABELS: { priority: "Priority" },
}));

const mockIsConfigured = vi.hoisted(() => vi.fn(() => true));
const mockWithHaWebSocket = vi.hoisted(() => vi.fn());
const mockListRepairIssues = vi.hoisted(() => vi.fn());
const mockGetIssueTranslations = vi.hoisted(() => vi.fn());
vi.mock("../home-assistant.js", () => ({
  isConfigured: mockIsConfigured,
  withHaWebSocket: mockWithHaWebSocket,
  listRepairIssues: mockListRepairIssues,
  getIssueTranslations: mockGetIssueTranslations,
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

const mockNotify = vi.hoisted(() => vi.fn());
vi.mock("../slack.js", () => ({ notify: mockNotify }));

import {
  run,
  applyPlaceholders,
  renderRepairTitle,
  sortRepairs,
  buildBody,
  matchesIgnoreRule,
  partitionRepairs,
  describeSuppressed,
} from "./ha-repairs-monitor.js";
import type { HaRepairIssue } from "../home-assistant.js";
import type { HaRepairIgnoreRule } from "../config.js";

const ALERT_TITLE = "[ha-repairs-monitor] Home Assistant repairs need attention";
const REPO = "St-John-Software/home-assistant-config";

function makeIssue(over: Partial<HaRepairIssue> = {}): HaRepairIssue {
  return {
    issue_id: "disk_space",
    domain: "homeassistant",
    ...over,
  };
}

const NAS_REPAIR: HaRepairIssue = {
  domain: "hassio",
  issue_id: "85b68721a8b14c01a462a721da1dd036",
  translation_key: "issue_mount_mount_failed",
  translation_placeholders: { reference: "nas_backup" },
  severity: "warning",
  is_fixable: true,
  ignored: false,
  created: "2026-09-03T02:17:32.472229+00:00",
  learn_more_url: null,
};
const NAS_RULE: HaRepairIgnoreRule = {
  domain: "hassio",
  translationKey: "issue_mount_mount_failed",
  placeholders: { reference: "nas_backup" },
};

beforeEach(() => {
  vi.clearAllMocks();
  mockRepairsMonitorEnabled.value = true;
  mockHaConfigRepo.value = REPO;
  mockFleetInfraRepo.value = undefined;
  mockRepairsIgnore.value = [];
  mockIsConfigured.mockReturnValue(true);
  mockWithHaWebSocket.mockImplementation(async (fn: (s: unknown) => Promise<unknown>) => fn({ request: vi.fn() }));
  mockListRepairIssues.mockResolvedValue([]);
  mockGetIssueTranslations.mockResolvedValue({});
  mockFindIssueByExactTitle.mockResolvedValue(null);
  mockCreateIssue.mockResolvedValue(undefined);
  mockGetIssueBody.mockResolvedValue("");
  mockEditIssue.mockResolvedValue(undefined);
  mockCloseIssue.mockResolvedValue(undefined);
  mockNotify.mockResolvedValue(undefined);
});

describe("applyPlaceholders", () => {
  it("substitutes known placeholders", () => {
    expect(applyPlaceholders("Disk {name} is low", { name: "/data" })).toBe("Disk /data is low");
  });

  it("leaves unknown placeholders intact", () => {
    expect(applyPlaceholders("Disk {name} is low", {})).toBe("Disk {name} is low");
  });
});

describe("renderRepairTitle", () => {
  it("resolves the title from resources", () => {
    const issue = makeIssue({ translation_key: "disk_space" });
    const resources = { "component.homeassistant.issues.disk_space.title": "Data disk is running low" };
    expect(renderRepairTitle(issue, resources)).toBe("Data disk is running low");
  });

  it("fills placeholders from translation_placeholders", () => {
    const issue = makeIssue({ translation_key: "disk_space", translation_placeholders: { name: "/data" } });
    const resources = { "component.homeassistant.issues.disk_space.title": "Disk {name} is low" };
    expect(renderRepairTitle(issue, resources)).toBe("Disk /data is low");
  });

  it("falls back to the backticked translation_key when the resource is missing", () => {
    const issue = makeIssue({ translation_key: "disk_space" });
    expect(renderRepairTitle(issue, {})).toBe("`disk_space`");
  });

  it("falls back to the issue_id when there is no translation_key", () => {
    const issue = makeIssue({ issue_id: "abc123", translation_key: null });
    expect(renderRepairTitle(issue, {})).toBe("`abc123`");
  });
});

describe("sortRepairs", () => {
  it("orders critical, error, warning, unknown, then domain, then issue_id", () => {
    const issues = [
      makeIssue({ issue_id: "z", domain: "b", severity: "warning" }),
      makeIssue({ issue_id: "y", domain: "a", severity: undefined }),
      makeIssue({ issue_id: "x", domain: "a", severity: "critical" }),
      makeIssue({ issue_id: "w", domain: "a", severity: "error" }),
      makeIssue({ issue_id: "v", domain: "a", severity: "warning" }),
    ];
    const sorted = sortRepairs(issues).map((i) => i.issue_id);
    expect(sorted).toEqual(["x", "w", "v", "z", "y"]);
  });

  it("does not mutate the input array", () => {
    const issues = [makeIssue({ issue_id: "b" }), makeIssue({ issue_id: "a" })];
    const copy = [...issues];
    sortRepairs(issues);
    expect(issues).toEqual(copy);
  });
});

describe("matchesIgnoreRule", () => {
  it("matches on domain, translation_key, and placeholders", () => {
    expect(matchesIgnoreRule(NAS_REPAIR, NAS_RULE)).toBe(true);
  });

  it("does not match when a placeholder value differs", () => {
    const issue = { ...NAS_REPAIR, translation_placeholders: { reference: "media" } };
    expect(matchesIgnoreRule(issue, NAS_RULE)).toBe(false);
  });

  it("does not match when translation_placeholders is null", () => {
    const issue = { ...NAS_REPAIR, translation_placeholders: null };
    expect(matchesIgnoreRule(issue, NAS_RULE)).toBe(false);
  });

  it("does not match when the domain differs", () => {
    const issue = { ...NAS_REPAIR, domain: "homeassistant" };
    expect(matchesIgnoreRule(issue, NAS_RULE)).toBe(false);
  });

  it("a domain-only rule matches any repair in that domain", () => {
    expect(matchesIgnoreRule(NAS_REPAIR, { domain: "hassio" })).toBe(true);
    const otherHassio = makeIssue({ domain: "hassio", translation_key: "something_else" });
    expect(matchesIgnoreRule(otherHassio, { domain: "hassio" })).toBe(true);
  });
});

describe("partitionRepairs", () => {
  it("splits issues into active and suppressed without mutating the input", () => {
    const other = makeIssue();
    const input = [NAS_REPAIR, other];
    const copy = [...input];
    const result = partitionRepairs(input, [NAS_RULE]);
    expect(result.active).toEqual([other]);
    expect(result.suppressed).toEqual([NAS_REPAIR]);
    expect(input).toEqual(copy);
  });
});

describe("describeSuppressed", () => {
  it("describes a repair with sorted placeholders", () => {
    expect(describeSuppressed(NAS_REPAIR)).toBe("hassio / issue_mount_mount_failed (reference=nas_backup)");
  });
});

describe("buildBody", () => {
  it("escapes a pipe in a repair name", () => {
    const issue = makeIssue({ translation_key: "k" });
    const resources = { "component.homeassistant.issues.k.title": "Bad | Name" };
    const body = buildBody([issue], resources, REPO);
    expect(body).toContain("Bad \\| Name");
  });

  it("renders learn_more_url as a link only for https://", () => {
    const httpsIssue = makeIssue({ issue_id: "a", translation_key: "k", learn_more_url: "https://example.com" });
    const resources = { "component.homeassistant.issues.k.title": "Some repair" };
    const httpsBody = buildBody([httpsIssue], resources, REPO);
    expect(httpsBody).toContain("[Some repair](https://example.com)");

    const jsIssue = makeIssue({ issue_id: "b", translation_key: "k", learn_more_url: "javascript:alert(1)" });
    const jsBody = buildBody([jsIssue], resources, REPO);
    expect(jsBody).not.toContain("javascript:alert(1)]");
    expect(jsBody).toContain("Some repair");
  });

  it("produces byte-identical output for the same input called twice", () => {
    const issue = makeIssue({ translation_key: "k", severity: "warning", is_fixable: true, created: "2026-08-31T00:00:00Z" });
    const resources = { "component.homeassistant.issues.k.title": "Some repair" };
    expect(buildBody([issue], resources, REPO)).toBe(buildBody([issue], resources, REPO));
  });

  it("appends the breaks-in-HA-version note to the severity cell", () => {
    const issue = makeIssue({ translation_key: "k", severity: "warning", breaks_in_ha_version: "2026.9.0" });
    const resources = { "component.homeassistant.issues.k.title": "Some repair" };
    expect(buildBody([issue], resources, REPO)).toContain("warning — breaks in HA 2026.9.0");
  });

  it("omits the suppressed footer when no fourth argument is passed", () => {
    const body = buildBody([makeIssue()], {}, REPO);
    expect(body).not.toContain("Suppressed by Claws config");
  });

  it("produces byte-identical output regardless of placeholder key order", () => {
    const issueA = { ...NAS_REPAIR, translation_placeholders: { b: "2", a: "1" } };
    const issueB = { ...NAS_REPAIR, translation_placeholders: { a: "1", b: "2" } };
    const bodyA = buildBody([makeIssue()], {}, REPO, [issueA]);
    const bodyB = buildBody([makeIssue()], {}, REPO, [issueB]);
    expect(bodyA).toBe(bodyB);
  });
});

describe("run()", () => {
  it("returns early without opening a socket when the flag is false", async () => {
    mockRepairsMonitorEnabled.value = false;
    await run();
    expect(mockWithHaWebSocket).not.toHaveBeenCalled();
  });

  it("filters out ignored:true repairs — a list of only ignored repairs takes the close path", async () => {
    mockListRepairIssues.mockResolvedValue([makeIssue({ ignored: true })]);
    mockFindIssueByExactTitle.mockResolvedValue({ number: 7, title: ALERT_TITLE });

    await run();

    expect(mockCloseIssue).toHaveBeenCalledWith(REPO, 7, "completed");
    expect(mockCreateIssue).not.toHaveBeenCalled();
  });

  it("calls createIssue once with the Priority label when a repair is open", async () => {
    mockListRepairIssues.mockResolvedValue([makeIssue()]);
    mockFindIssueByExactTitle.mockResolvedValue(null);

    await run();

    expect(mockCreateIssue).toHaveBeenCalledOnce();
    const [repo, title, , labels] = mockCreateIssue.mock.calls[0]!;
    expect(repo).toBe(REPO);
    expect(title).toBe(ALERT_TITLE);
    expect(labels).toContain("Priority");
  });

  it("skips the editIssue when getIssueBody returns the identical body", async () => {
    const issue = makeIssue();
    mockListRepairIssues.mockResolvedValue([issue]);
    mockFindIssueByExactTitle.mockResolvedValue({ number: 7, title: ALERT_TITLE });
    mockGetIssueTranslations.mockResolvedValue({});
    const expectedBody = buildBody(sortRepairs([issue]), {}, REPO);
    mockGetIssueBody.mockResolvedValue(expectedBody);

    await run();

    expect(mockEditIssue).not.toHaveBeenCalled();
  });

  it("closes the issue when listRepairIssues returns []", async () => {
    mockListRepairIssues.mockResolvedValue([]);
    mockFindIssueByExactTitle.mockResolvedValue({ number: 7, title: ALERT_TITLE });

    await run();

    expect(mockCloseIssue).toHaveBeenCalledWith(REPO, 7, "completed");
  });

  it("makes no GitHub calls when withHaWebSocket rejects", async () => {
    mockWithHaWebSocket.mockRejectedValue(new Error("connect ECONNREFUSED"));

    await expect(run()).resolves.toBeUndefined();

    expect(mockFindIssueByExactTitle).not.toHaveBeenCalled();
    expect(mockCreateIssue).not.toHaveBeenCalled();
    expect(mockCloseIssue).not.toHaveBeenCalled();
  });

  it("suppresses a repair matching homeAssistantRepairsIgnore — a fully-suppressed list takes the close path", async () => {
    mockRepairsIgnore.value = [NAS_RULE];
    mockListRepairIssues.mockResolvedValue([NAS_REPAIR]);
    mockFindIssueByExactTitle.mockResolvedValue({ number: 7, title: ALERT_TITLE });

    await run();

    expect(mockCloseIssue).toHaveBeenCalledWith(REPO, 7, "completed");
    expect(mockCreateIssue).not.toHaveBeenCalled();
  });

  it("lists a suppressed repair in the alert footer when another repair is open", async () => {
    mockRepairsIgnore.value = [NAS_RULE];
    mockListRepairIssues.mockResolvedValue([NAS_REPAIR, makeIssue()]);
    mockFindIssueByExactTitle.mockResolvedValue(null);

    await run();

    expect(mockCreateIssue).toHaveBeenCalledOnce();
    const body = mockCreateIssue.mock.calls[0]![2] as string;
    const dataRows = body
      .split("\n")
      .filter((l) => l.startsWith("| ") && l !== "| Repair | Domain | Severity | Fixable in HA | Raised |" && l !== "| --- | --- | --- | --- | --- |");
    expect(dataRows).toHaveLength(1);
    expect(body).toContain("Suppressed by Claws config");
    expect(body).toContain("hassio");
    expect(body).toContain("issue_mount_mount_failed");
    expect(body).toContain("reference=nas_backup");
  });

  it("still files with fallback titles when getIssueTranslations rejects but the list succeeded", async () => {
    mockListRepairIssues.mockResolvedValue([makeIssue({ translation_key: "disk_space" })]);
    mockGetIssueTranslations.mockRejectedValue(new Error("unknown command"));
    mockFindIssueByExactTitle.mockResolvedValue(null);

    await run();

    expect(mockCreateIssue).toHaveBeenCalledOnce();
    const body = mockCreateIssue.mock.calls[0]![2] as string;
    expect(body).toContain("`disk_space`");
  });
});
