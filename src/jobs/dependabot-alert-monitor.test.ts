import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mockRepo } from "../test-helpers.js";

const mockAutoDismiss = vi.hoisted(() => ({ value: true }));
const mockAutoRemediate = vi.hoisted(() => ({ value: true }));
const mockIgnored = vi.hoisted(() => ({ value: new Set<string>() }));

vi.mock("../config.js", () => ({
  LABELS: { priority: "Priority", automerge: "Automerge" },
  SELF_REPO: "St-John-Software/claws",
  get DEPENDABOT_AUTO_DISMISS_STALE() {
    return mockAutoDismiss.value;
  },
  get DEPENDABOT_AUTO_REMEDIATE() {
    return mockAutoRemediate.value;
  },
  getIgnoredAdvisoriesForRepo: () => mockIgnored.value,
}));

vi.mock("../log.js", () => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock("../error-reporter.js", () => ({
  reportError: vi.fn(),
}));

vi.mock("../occurrence-tracking.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../occurrence-tracking.js")>()),
  ensureAlertIssue: vi.fn().mockResolvedValue({ outcome: "created", issueNumber: 1 }),
}));

const mockDb = vi.hoisted(() => ({ markRepoProcessedDaily: vi.fn() }));
vi.mock("../db.js", () => mockDb);
vi.mock("../smart-schedule.js", () => ({
  localDateString: () => "2026-07-06",
  withDailyRepoMarking: async (jobName: string, repoFullName: string, fn: () => Promise<unknown>, onError?: (err: unknown) => unknown) => {
    try {
      return await fn();
    } catch (err) {
      if (!onError) throw err;
      return onError(err);
    } finally {
      mockDb.markRepoProcessedDaily(jobName, repoFullName, "2026-07-06");
    }
  },
}));

// DependabotAlertsPermissionError must be a real class so instanceof checks work.
const { mockGh, PermissionError } = vi.hoisted(() => {
  class DependabotAlertsPermissionError extends Error {
    constructor(public readonly repo: string, message: string) {
      super(message);
      this.name = "DependabotAlertsPermissionError";
    }
  }
  const mockGh = {
    listOpenDependabotAlerts: vi.fn(),
    findIssueByExactTitle: vi.fn(),
    closeIssue: vi.fn(),
    fetchRepoSbomPackages: vi.fn(),
    fetchRepoFileContent: vi.fn(),
    dismissDependabotAlert: vi.fn(),
    addLabel: vi.fn(),
    removeLabel: vi.fn(),
    DependabotAlertsPermissionError,
  };
  return { mockGh, PermissionError: DependabotAlertsPermissionError };
});

vi.mock("../github.js", () => mockGh);

import { processRepo, buildBody, versionAtLeast, manifestSatisfiesPatch, parsePinnedRequirement, parseDeferredAdvisories, resetThrottleForTest, rangeUpperBound, isBreakingBump, classifyRemediation } from "./dependabot-alert-monitor.js";
import { ensureAlertIssue } from "../occurrence-tracking.js";
import { reportError } from "../error-reporter.js";

const ISSUE_TITLE = "Alert: open Dependabot security alerts";
const PERMISSION_ISSUE_TITLE =
  "Alert: Claws GitHub App lacks Dependabot alerts read permission";

describe("dependabot-alert-monitor", () => {
  const repo = mockRepo({ fullName: "test-org/test-repo" });

  beforeEach(() => {
    vi.clearAllMocks();
    resetThrottleForTest();
    mockAutoDismiss.value = true;
    mockAutoRemediate.value = true;
    mockIgnored.value = new Set();
    mockGh.findIssueByExactTitle.mockResolvedValue(null);
    mockGh.closeIssue.mockResolvedValue(undefined);
    mockGh.fetchRepoSbomPackages.mockResolvedValue([]);
    mockGh.fetchRepoFileContent.mockResolvedValue(null);
    mockGh.dismissDependabotAlert.mockResolvedValue(undefined);
    mockGh.addLabel.mockResolvedValue(undefined);
    mockGh.removeLabel.mockResolvedValue(true);
  });

  describe("processRepo", () => {
    it("files/updates alert issue when alerts are present", async () => {
      mockGh.listOpenDependabotAlerts.mockResolvedValue([
        {
          number: 1,
          severity: "high",
          packageName: "lodash",
          ecosystem: "npm",
          summary: "Prototype pollution",
          ghsaId: "GHSA-1234-5678-9abc",
          htmlUrl: "https://github.com/advisories/GHSA-1234-5678-9abc",
          manifestPath: "package.json",
          patchedVersion: "4.17.21",
          vulnerableVersionRange: "< 4.17.21",
        },
      ]);

      await processRepo(repo);

      expect(ensureAlertIssue).toHaveBeenCalledOnce();
      const opts = (ensureAlertIssue as ReturnType<typeof vi.fn>).mock.calls[0]![0];
      expect(opts.repo).toBe("test-org/test-repo");
      expect(opts.title).toBe(ISSUE_TITLE);
      expect(opts.labels).toEqual(["Automerge"]);
      expect(opts.refreshBody).toBe(true);
      expect(opts.body).toContain("lodash");
      expect(opts.body).toContain("https://github.com/test-org/test-repo/security/dependabot");
      expect(reportError).not.toHaveBeenCalled();
    });

    it("marks the repo processed in the smart-schedule ledger on success", async () => {
      mockGh.listOpenDependabotAlerts.mockResolvedValue([
        {
          number: 1,
          severity: "high",
          packageName: "lodash",
          ecosystem: "npm",
          summary: "Prototype pollution",
          ghsaId: "GHSA-1234-5678-9abc",
          htmlUrl: "https://github.com/advisories/GHSA-1234-5678-9abc",
          manifestPath: "package.json",
          patchedVersion: "4.17.21",
        },
      ]);

      await processRepo(repo);

      expect(mockDb.markRepoProcessedDaily).toHaveBeenCalledWith(
        "dependabot-alert-monitor",
        "test-org/test-repo",
        "2026-07-06",
      );
    });

    it("marks the repo processed in the ledger even when listing alerts fails", async () => {
      mockGh.listOpenDependabotAlerts.mockRejectedValue(new Error("network failure"));

      await processRepo(repo);

      expect(mockDb.markRepoProcessedDaily).toHaveBeenCalledWith(
        "dependabot-alert-monitor",
        "test-org/test-repo",
        "2026-07-06",
      );
    });

    it("files remediation issue on SELF_REPO when App lacks permission", async () => {
      mockGh.listOpenDependabotAlerts.mockRejectedValue(
        new PermissionError("test-org/test-repo", "Resource not accessible by integration"),
      );

      await processRepo(repo);

      expect(ensureAlertIssue).toHaveBeenCalledOnce();
      const opts = (ensureAlertIssue as ReturnType<typeof vi.fn>).mock.calls[0]![0];
      expect(opts.repo).toBe("St-John-Software/claws");
      expect(opts.title).toBe(PERMISSION_ISSUE_TITLE);
      expect(reportError).not.toHaveBeenCalled();
    });

    describe("throttling", () => {
      afterEach(() => {
        vi.useRealTimers();
        resetThrottleForTest();
      });

      it("throttles permission remediation: second repo in same cycle does not re-file", async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2099-01-01"));

        mockGh.listOpenDependabotAlerts.mockRejectedValue(
          new PermissionError("test-org/test-repo", "Resource not accessible by integration"),
        );

        await processRepo(repo);
        await processRepo(mockRepo({ fullName: "test-org/other-repo" }));

        // Only one ensureAlertIssue call despite two permission errors
        expect(ensureAlertIssue).toHaveBeenCalledOnce();
      });
    });

    it("calls reportError when ensureAlertIssue throws during permission remediation", async () => {
      mockGh.listOpenDependabotAlerts.mockRejectedValue(
        new PermissionError("test-org/test-repo", "Resource not accessible by integration"),
      );
      const permErr = new Error("network failure during remediation");
      (ensureAlertIssue as ReturnType<typeof vi.fn>).mockRejectedValueOnce(permErr);

      await expect(processRepo(repo)).resolves.toBeUndefined();

      expect(reportError).toHaveBeenCalledWith(
        "dependabot-alert-monitor:permission-remediation",
        "test-org/test-repo",
        permErr,
      );
    });

    it("closes existing alert issue when alerts reach zero", async () => {
      mockGh.listOpenDependabotAlerts.mockResolvedValue([]);
      mockGh.findIssueByExactTitle.mockResolvedValue({ number: 42, title: ISSUE_TITLE });

      await processRepo(repo);

      expect(mockGh.closeIssue).toHaveBeenCalledWith("test-org/test-repo", 42, "completed");
      expect(ensureAlertIssue).not.toHaveBeenCalled();
    });

    it("does nothing when alerts are zero and no existing issue", async () => {
      mockGh.listOpenDependabotAlerts.mockResolvedValue([]);
      mockGh.findIssueByExactTitle.mockResolvedValue(null);

      await processRepo(repo);

      expect(mockGh.closeIssue).not.toHaveBeenCalled();
      expect(ensureAlertIssue).not.toHaveBeenCalled();
    });

    it("calls reportError with correct fingerprint on generic list error", async () => {
      const err = new Error("network failure");
      mockGh.listOpenDependabotAlerts.mockRejectedValue(err);

      await processRepo(repo);

      expect(reportError).toHaveBeenCalledWith(
        "dependabot-alert-monitor:list-alerts",
        "test-org/test-repo",
        err,
      );
      expect(ensureAlertIssue).not.toHaveBeenCalled();
    });
  });

  describe("stale alert auto-dismissal", () => {
    const alert = (over: Record<string, unknown>) => ({
      number: 1,
      severity: "high",
      packageName: "pkg",
      ecosystem: "npm",
      summary: "Some vuln",
      ghsaId: "",
      htmlUrl: "",
      patchedVersion: "1.0.0",
      ...over,
    });

    it("dismisses a stale alert and closes the issue when no live alerts remain", async () => {
      mockGh.listOpenDependabotAlerts.mockResolvedValue([
        alert({ number: 30, packageName: "onnx", patchedVersion: "1.21.0" }),
      ]);
      mockGh.fetchRepoSbomPackages.mockResolvedValue([{ name: "onnx", version: "1.21.0" }]);
      mockGh.findIssueByExactTitle.mockResolvedValue({ number: 7, title: ISSUE_TITLE });

      await processRepo(repo);

      expect(mockGh.dismissDependabotAlert).toHaveBeenCalledWith(
        "test-org/test-repo",
        30,
        "inaccurate",
        expect.stringContaining("stale"),
      );
      expect(ensureAlertIssue).not.toHaveBeenCalled();
      expect(mockGh.closeIssue).toHaveBeenCalledWith("test-org/test-repo", 7, "completed");
    });

    it("keeps an alert open when the resolved version is below the patch", async () => {
      mockGh.listOpenDependabotAlerts.mockResolvedValue([
        alert({ number: 31, packageName: "lodash", patchedVersion: "8.21.0" }),
      ]);
      mockGh.fetchRepoSbomPackages.mockResolvedValue([{ name: "lodash", version: "8.20.0" }]);

      await processRepo(repo);

      expect(mockGh.dismissDependabotAlert).not.toHaveBeenCalled();
      expect(ensureAlertIssue).toHaveBeenCalledOnce();
      const opts = (ensureAlertIssue as ReturnType<typeof vi.fn>).mock.calls[0]![0];
      expect(opts.body).toContain("lodash");
    });

    it("keeps an alert open when any resolved instance is still vulnerable", async () => {
      mockGh.listOpenDependabotAlerts.mockResolvedValue([
        alert({ number: 32, packageName: "ws", patchedVersion: "8.21.0" }),
      ]);
      mockGh.fetchRepoSbomPackages.mockResolvedValue([
        { name: "ws", version: "8.21.0" },
        { name: "ws", version: "7.5.10" },
      ]);

      await processRepo(repo);

      expect(mockGh.dismissDependabotAlert).not.toHaveBeenCalled();
      expect(ensureAlertIssue).toHaveBeenCalledOnce();
    });

    it("never dismisses an alert with no patched version", async () => {
      mockGh.listOpenDependabotAlerts.mockResolvedValue([
        alert({ number: 33, packageName: "onnx", patchedVersion: undefined }),
      ]);
      mockGh.fetchRepoSbomPackages.mockResolvedValue([{ name: "onnx", version: "1.21.0" }]);

      await processRepo(repo);

      expect(mockGh.dismissDependabotAlert).not.toHaveBeenCalled();
      expect(ensureAlertIssue).toHaveBeenCalledOnce();
    });

    it("keeps an alert open when the patch version is non-numeric", async () => {
      mockGh.listOpenDependabotAlerts.mockResolvedValue([
        alert({ number: 34, packageName: "onnx", patchedVersion: "1.21.0rc1" }),
      ]);
      mockGh.fetchRepoSbomPackages.mockResolvedValue([{ name: "onnx", version: "1.21.0" }]);

      await processRepo(repo);

      expect(mockGh.dismissDependabotAlert).not.toHaveBeenCalled();
      expect(ensureAlertIssue).toHaveBeenCalledOnce();
    });

    it("keeps an alert open when the package is absent from the SBOM", async () => {
      mockGh.listOpenDependabotAlerts.mockResolvedValue([
        alert({ number: 35, packageName: "onnx", patchedVersion: "1.21.0" }),
      ]);
      mockGh.fetchRepoSbomPackages.mockResolvedValue([{ name: "torch", version: "2.12.0" }]);

      await processRepo(repo);

      expect(mockGh.dismissDependabotAlert).not.toHaveBeenCalled();
      expect(ensureAlertIssue).toHaveBeenCalledOnce();
    });

    it("does not touch the SBOM or dismiss anything when the flag is off", async () => {
      mockAutoDismiss.value = false;
      mockGh.listOpenDependabotAlerts.mockResolvedValue([
        alert({ number: 36, packageName: "onnx", patchedVersion: "1.21.0" }),
      ]);

      await processRepo(repo);

      expect(mockGh.fetchRepoSbomPackages).not.toHaveBeenCalled();
      expect(mockGh.dismissDependabotAlert).not.toHaveBeenCalled();
      expect(ensureAlertIssue).toHaveBeenCalledOnce();
    });

    it("files all alerts when the SBOM fetch throws (monitoring unbroken)", async () => {
      mockGh.listOpenDependabotAlerts.mockResolvedValue([
        alert({ number: 37, packageName: "onnx", patchedVersion: "1.21.0" }),
      ]);
      mockGh.fetchRepoSbomPackages.mockRejectedValue(new Error("graph unavailable"));

      await processRepo(repo);

      expect(mockGh.dismissDependabotAlert).not.toHaveBeenCalled();
      expect(reportError).not.toHaveBeenCalled();
      expect(ensureAlertIssue).toHaveBeenCalledOnce();
    });
  });

  describe("versionAtLeast", () => {
    it("returns true for equal versions", () => {
      expect(versionAtLeast("1.21.0", "1.21.0")).toBe(true);
    });
    it("returns true for a greater minor", () => {
      expect(versionAtLeast("8.21.0", "8.20.0")).toBe(true);
    });
    it("returns false when below the target", () => {
      expect(versionAtLeast("8.20.0", "8.21.0")).toBe(false);
    });
    it("compares segment lists of differing length numerically", () => {
      expect(versionAtLeast("2.12", "2.7.1")).toBe(true);
      expect(versionAtLeast("2.7.1", "2.12")).toBe(false);
    });
    it("returns false when either version has a non-numeric segment", () => {
      expect(versionAtLeast("1.21.0", "1.21.0rc1")).toBe(false);
      expect(versionAtLeast("8.0.0-beta", "8.0.0")).toBe(false);
    });
  });

  describe("parsePinnedRequirement", () => {
    it("extracts an exact == pin", () => {
      expect(parsePinnedRequirement("torch==2.12.0\nonnx==1.21.0\n", "torch")).toBe("2.12.0");
    });

    it("extracts pin for second package", () => {
      expect(parsePinnedRequirement("torch==2.12.0\nonnx==1.21.0\n", "onnx")).toBe("1.21.0");
    });

    it("returns null for >= constraint", () => {
      expect(parsePinnedRequirement("torch>=2.0.0\n", "torch")).toBeNull();
    });

    it("returns null for ~= constraint", () => {
      expect(parsePinnedRequirement("torch~=2.0\n", "torch")).toBeNull();
    });

    it("returns null when package is absent", () => {
      expect(parsePinnedRequirement("onnx==1.21.0\n", "torch")).toBeNull();
    });

    it("ignores comment lines", () => {
      expect(parsePinnedRequirement("# torch==1.0.0\ntorch==2.12.0\n", "torch")).toBe("2.12.0");
    });

    it("handles extras syntax", () => {
      expect(parsePinnedRequirement("torch[cpu]==2.12.0\n", "torch")).toBe("2.12.0");
    });

    it("normalises underscores and dots to dashes (PEP 503)", () => {
      expect(parsePinnedRequirement("onnx_runtime==1.26.0\n", "onnx-runtime")).toBe("1.26.0");
    });

    it("normalises uppercase to lowercase", () => {
      expect(parsePinnedRequirement("Torch==2.12.0\n", "torch")).toBe("2.12.0");
    });
  });

  describe("manifestSatisfiesPatch", () => {
    it("returns true when stable pin satisfies pre-release fix (torch rc)", () => {
      expect(manifestSatisfiesPatch("2.12.0", "2.7.1-rc1")).toBe(true);
    });

    it("returns true when stable pin satisfies rc1 suffix fix (onnx)", () => {
      expect(manifestSatisfiesPatch("1.21.0", "1.21.0rc1")).toBe(true);
    });

    it("returns false when pin is below the fix version", () => {
      expect(manifestSatisfiesPatch("2.6.0", "2.9.1")).toBe(false);
    });

    it("returns true for equal versions", () => {
      expect(manifestSatisfiesPatch("1.21.0", "1.21.0")).toBe(true);
    });

    it("returns false when pin has no numeric core", () => {
      expect(manifestSatisfiesPatch("", "1.0.0")).toBe(false);
    });
  });

  describe("pip manifest-pin dismissal pass (dismissAlreadyPinnedAlerts)", () => {
    const pipAlert = (over: Record<string, unknown>) => ({
      number: 100,
      severity: "high",
      packageName: "torch",
      ecosystem: "pip",
      summary: "Vuln in torch",
      ghsaId: "",
      htmlUrl: "",
      patchedVersion: "2.9.1",
      manifestPath: "training/requirements.txt",
      ...over,
    });

    it("dismisses a pip alert when manifest pins a satisfying version", async () => {
      mockGh.listOpenDependabotAlerts.mockResolvedValue([pipAlert({})]);
      mockGh.fetchRepoFileContent.mockResolvedValue("torch==2.12.0\nonnx==1.21.0\n");
      mockGh.findIssueByExactTitle.mockResolvedValue(null);

      await processRepo(repo);

      expect(mockGh.fetchRepoFileContent).toHaveBeenCalledWith(
        "test-org/test-repo",
        "training/requirements.txt",
      );
      expect(mockGh.dismissDependabotAlert).toHaveBeenCalledWith(
        "test-org/test-repo",
        100,
        "inaccurate",
        expect.stringContaining("training/requirements.txt"),
      );
      expect(ensureAlertIssue).not.toHaveBeenCalled();
    });

    it("closes an existing alert issue after all pip alerts are dismissed", async () => {
      mockGh.listOpenDependabotAlerts.mockResolvedValue([pipAlert({})]);
      mockGh.fetchRepoFileContent.mockResolvedValue("torch==2.12.0\n");
      mockGh.findIssueByExactTitle.mockResolvedValue({ number: 99, title: ISSUE_TITLE });

      await processRepo(repo);

      expect(mockGh.dismissDependabotAlert).toHaveBeenCalledOnce();
      expect(ensureAlertIssue).not.toHaveBeenCalled();
      expect(mockGh.closeIssue).toHaveBeenCalledWith("test-org/test-repo", 99, "completed");
    });

    it("keeps pip alert open when manifest pin is below the fix version", async () => {
      mockGh.listOpenDependabotAlerts.mockResolvedValue([
        pipAlert({ patchedVersion: "2.9.1" }),
      ]);
      mockGh.fetchRepoFileContent.mockResolvedValue("torch==2.6.0\n");

      await processRepo(repo);

      expect(mockGh.dismissDependabotAlert).not.toHaveBeenCalled();
      expect(ensureAlertIssue).toHaveBeenCalledOnce();
    });

    it("keeps pip alert open when manifest has no exact == pin for the package", async () => {
      mockGh.listOpenDependabotAlerts.mockResolvedValue([pipAlert({})]);
      mockGh.fetchRepoFileContent.mockResolvedValue("torch>=2.0.0\n");

      await processRepo(repo);

      expect(mockGh.dismissDependabotAlert).not.toHaveBeenCalled();
      expect(ensureAlertIssue).toHaveBeenCalledOnce();
    });

    it("keeps pip alert open when manifest file cannot be read (null)", async () => {
      mockGh.listOpenDependabotAlerts.mockResolvedValue([pipAlert({})]);
      mockGh.fetchRepoFileContent.mockResolvedValue(null);

      await processRepo(repo);

      expect(mockGh.dismissDependabotAlert).not.toHaveBeenCalled();
      expect(ensureAlertIssue).toHaveBeenCalledOnce();
    });

    it("keeps pip alert open when manifest fetch throws (fault tolerant)", async () => {
      mockGh.listOpenDependabotAlerts.mockResolvedValue([pipAlert({})]);
      mockGh.fetchRepoFileContent.mockRejectedValue(new Error("network error"));

      await processRepo(repo);

      expect(mockGh.dismissDependabotAlert).not.toHaveBeenCalled();
      expect(reportError).not.toHaveBeenCalled();
      expect(ensureAlertIssue).toHaveBeenCalledOnce();
    });

    it("does not call fetchRepoFileContent for pip manifest path on npm alerts", async () => {
      mockGh.listOpenDependabotAlerts.mockResolvedValue([
        pipAlert({ ecosystem: "npm", manifestPath: "package.json" }),
      ]);

      await processRepo(repo);

      // The deferrals path is always read when alerts are present, but no pip manifest fetch
      expect(mockGh.fetchRepoFileContent).toHaveBeenCalledWith("test-org/test-repo", ".claws/dependabot-deferrals.json");
      expect(mockGh.fetchRepoFileContent).not.toHaveBeenCalledWith("test-org/test-repo", "package.json");
    });

    it("fetches each manifest path only once when multiple alerts share it", async () => {
      mockGh.listOpenDependabotAlerts.mockResolvedValue([
        pipAlert({ number: 101, packageName: "torch", patchedVersion: "2.9.1" }),
        pipAlert({ number: 102, packageName: "onnx", patchedVersion: "1.21.0" }),
      ]);
      mockGh.fetchRepoFileContent.mockResolvedValue("torch==2.12.0\nonnx==1.21.0\n");
      mockGh.findIssueByExactTitle.mockResolvedValue(null);

      await processRepo(repo);

      // Both pip alerts dismissed before reaching deferral block, so only the manifest path is fetched
      expect(mockGh.fetchRepoFileContent).toHaveBeenCalledOnce();
      expect(mockGh.fetchRepoFileContent).toHaveBeenCalledWith("test-org/test-repo", "training/requirements.txt");
      expect(mockGh.dismissDependabotAlert).toHaveBeenCalledTimes(2);
      expect(ensureAlertIssue).not.toHaveBeenCalled();
    });
  });

  describe("acknowledged-advisory suppression", () => {
    const alert = (over: Record<string, unknown>) => ({
      number: 1,
      severity: "high",
      packageName: "webpack-dev-server",
      ecosystem: "npm",
      summary: "Vuln in webpack-dev-server",
      ghsaId: "GHSA-mx8g-39q3-5c79",
      htmlUrl: "https://github.com/advisories/GHSA-mx8g-39q3-5c79",
      patchedVersion: "5.2.0",
      ...over,
    });

    it("closes issue and files nothing when all alerts are acknowledged", async () => {
      mockIgnored.value = new Set(["ghsa-mx8g-39q3-5c79", "ghsa-79cf-xcqc-c78w"]);
      mockGh.listOpenDependabotAlerts.mockResolvedValue([
        alert({ number: 1, ghsaId: "GHSA-mx8g-39q3-5c79" }),
        alert({ number: 2, ghsaId: "GHSA-79cf-xcqc-c78w", packageName: "webpack-dev-server-2" }),
      ]);
      mockGh.findIssueByExactTitle.mockResolvedValue({ number: 7, title: ISSUE_TITLE });

      await processRepo(repo);

      expect(ensureAlertIssue).not.toHaveBeenCalled();
      expect(mockGh.closeIssue).toHaveBeenCalledWith("test-org/test-repo", 7, "completed");
    });

    it("files issue with only the un-acknowledged alert when alerts are mixed", async () => {
      mockIgnored.value = new Set(["ghsa-mx8g-39q3-5c79"]);
      mockGh.listOpenDependabotAlerts.mockResolvedValue([
        alert({ number: 1, ghsaId: "GHSA-mx8g-39q3-5c79", packageName: "webpack-dev-server" }),
        alert({ number: 2, ghsaId: "GHSA-other-1234-5678", packageName: "js-yaml", summary: "Vuln in js-yaml", patchedVersion: "4.1.0" }),
      ]);

      await processRepo(repo);

      expect(ensureAlertIssue).toHaveBeenCalledOnce();
      const opts = (ensureAlertIssue as ReturnType<typeof vi.fn>).mock.calls[0]![0];
      expect(opts.body).toContain("js-yaml");
      expect(opts.body).not.toContain("webpack-dev-server");
    });

    it("matches GHSA IDs case-insensitively", async () => {
      mockIgnored.value = new Set(["ghsa-abc-123"]);
      mockGh.listOpenDependabotAlerts.mockResolvedValue([
        alert({ number: 1, ghsaId: "GHSA-AbC-123" }),
      ]);
      mockGh.findIssueByExactTitle.mockResolvedValue(null);

      await processRepo(repo);

      expect(ensureAlertIssue).not.toHaveBeenCalled();
    });
  });

  describe("parseDeferredAdvisories", () => {
    it("parses array-of-strings shape and lowercases", () => {
      const result = parseDeferredAdvisories('["GHSA-aaaa-bbbb-cccc", "GHSA-1111-2222-3333"]');
      expect(result).toEqual(new Set(["ghsa-aaaa-bbbb-cccc", "ghsa-1111-2222-3333"]));
    });

    it("parses object with deferrals array using ghsa field", () => {
      const result = parseDeferredAdvisories(
        '{"deferrals":[{"ghsa":"GHSA-aaaa-bbbb-cccc","reason":"no safe fix","reviewAfter":"2026-09-01"}]}',
      );
      expect(result).toEqual(new Set(["ghsa-aaaa-bbbb-cccc"]));
    });

    it("accepts ghsaId alias in deferrals object", () => {
      const result = parseDeferredAdvisories(
        '{"deferrals":[{"ghsaId":"GHSA-aaaa-bbbb-cccc"}]}',
      );
      expect(result).toEqual(new Set(["ghsa-aaaa-bbbb-cccc"]));
    });

    it("returns empty set for null", () => {
      expect(parseDeferredAdvisories(null)).toEqual(new Set());
    });

    it("returns empty set for empty string", () => {
      expect(parseDeferredAdvisories("")).toEqual(new Set());
    });

    it("returns empty set for invalid JSON", () => {
      expect(parseDeferredAdvisories("not json")).toEqual(new Set());
    });

    it("returns empty set for unexpected shape (plain object without deferrals)", () => {
      expect(parseDeferredAdvisories("{}")).toEqual(new Set());
    });

    it("returns empty set for a number", () => {
      expect(parseDeferredAdvisories("42")).toEqual(new Set());
    });

    it("trims whitespace from GHSA IDs", () => {
      const result = parseDeferredAdvisories('[" GHSA-aaaa-bbbb-cccc "]');
      expect(result).toEqual(new Set(["ghsa-aaaa-bbbb-cccc"]));
    });
  });

  describe("repo-local deferral suppression", () => {
    const DEFERRALS_PATH = ".claws/dependabot-deferrals.json";
    const alert = (over: Record<string, unknown>) => ({
      number: 1,
      severity: "high",
      packageName: "webpack-dev-server",
      ecosystem: "npm",
      summary: "Vuln in webpack-dev-server",
      ghsaId: "GHSA-mx8g-39q3-5c79",
      htmlUrl: "https://github.com/advisories/GHSA-mx8g-39q3-5c79",
      patchedVersion: "5.2.0",
      ...over,
    });

    it("closes issue and files nothing when all alerts are deferred via manifest", async () => {
      mockGh.listOpenDependabotAlerts.mockResolvedValue([
        alert({ number: 1, ghsaId: "GHSA-mx8g-39q3-5c79" }),
      ]);
      mockGh.fetchRepoFileContent.mockImplementation((_repo: string, path: string) => {
        if (path === DEFERRALS_PATH) {
          return Promise.resolve('{"deferrals":[{"ghsa":"GHSA-mx8g-39q3-5c79","reason":"no safe fix"}]}');
        }
        return Promise.resolve(null);
      });
      mockGh.findIssueByExactTitle.mockResolvedValue({ number: 7, title: ISSUE_TITLE });

      await processRepo(repo);

      expect(ensureAlertIssue).not.toHaveBeenCalled();
      expect(mockGh.closeIssue).toHaveBeenCalledWith("test-org/test-repo", 7, "completed");
    });

    it("files issue with only the non-deferred alert when alerts are mixed", async () => {
      mockGh.listOpenDependabotAlerts.mockResolvedValue([
        alert({ number: 1, ghsaId: "GHSA-mx8g-39q3-5c79", packageName: "webpack-dev-server" }),
        alert({ number: 2, ghsaId: "GHSA-other-1234-5678", packageName: "js-yaml", summary: "Vuln in js-yaml", patchedVersion: "4.1.0" }),
      ]);
      mockGh.fetchRepoFileContent.mockImplementation((_repo: string, path: string) => {
        if (path === DEFERRALS_PATH) {
          return Promise.resolve('["GHSA-mx8g-39q3-5c79"]');
        }
        return Promise.resolve(null);
      });

      await processRepo(repo);

      expect(ensureAlertIssue).toHaveBeenCalledOnce();
      const opts = (ensureAlertIssue as ReturnType<typeof vi.fn>).mock.calls[0]![0];
      expect(opts.body).toContain("js-yaml");
      expect(opts.body).not.toContain("webpack-dev-server");
    });

    it("is non-fatal when deferrals file fetch rejects", async () => {
      mockGh.listOpenDependabotAlerts.mockResolvedValue([
        alert({ number: 1, ghsaId: "GHSA-mx8g-39q3-5c79" }),
      ]);
      mockGh.fetchRepoFileContent.mockRejectedValue(new Error("network failure"));

      await processRepo(repo);

      expect(reportError).not.toHaveBeenCalled();
      expect(ensureAlertIssue).toHaveBeenCalledOnce();
    });
  });

  describe("buildBody", () => {
    it("sorts alerts critical → low", () => {
      const alerts = [
        {
          number: 1,
          severity: "low",
          packageName: "pkg-low",
          ecosystem: "npm",
          summary: "Low issue",
          ghsaId: "",
          htmlUrl: "",
        },
        {
          number: 2,
          severity: "critical",
          packageName: "pkg-critical",
          ecosystem: "npm",
          summary: "Critical issue",
          ghsaId: "",
          htmlUrl: "",
        },
        {
          number: 3,
          severity: "high",
          packageName: "pkg-high",
          ecosystem: "npm",
          summary: "High issue",
          ghsaId: "",
          htmlUrl: "",
        },
      ];

      const body = buildBody("test-org/test-repo", alerts, { routine: true, blockers: [] });
      const critIdx = body.indexOf("pkg-critical");
      const highIdx = body.indexOf("pkg-high");
      const lowIdx = body.indexOf("pkg-low");
      expect(critIdx).toBeLessThan(highIdx);
      expect(highIdx).toBeLessThan(lowIdx);
    });

    it("renders 'no patched version yet' when patchedVersion is absent", () => {
      const alerts = [
        {
          number: 1,
          severity: "medium",
          packageName: "vuln-pkg",
          ecosystem: "npm",
          summary: "Some vuln",
          ghsaId: "",
          htmlUrl: "",
          patchedVersion: undefined,
        },
      ];
      const body = buildBody("test-org/test-repo", alerts, { routine: true, blockers: [] });
      expect(body).toContain("no patched version yet");
    });

    it("includes remediation guidance after the alert bullets and before the footer", () => {
      const alerts = [
        {
          number: 1,
          severity: "high",
          packageName: "vuln-pkg",
          ecosystem: "npm",
          summary: "Some vuln",
          ghsaId: "",
          htmlUrl: "",
          patchedVersion: "1.2.3",
        },
      ];
      const body = buildBody("test-org/test-repo", alerts, { routine: true, blockers: [] });
      expect(body).toContain("Remediation guidance");
      expect(body).toContain("NEVER exact pins");
      expect(body).toContain("Minimise dependencies first");
      expect(body.indexOf("vuln-pkg")).toBeLessThan(body.indexOf("Remediation guidance"));
      expect(body.indexOf("Remediation guidance")).toBeLessThan(body.indexOf("Automated by claws"));
    });

    it("renders GHSA advisory link when ghsaId is present", () => {
      const alerts = [
        {
          number: 1,
          severity: "high",
          packageName: "vuln-pkg",
          ecosystem: "npm",
          summary: "Prototype pollution",
          ghsaId: "GHSA-1234-5678-9abc",
          htmlUrl: "https://github.com/advisories/GHSA-1234-5678-9abc",
          patchedVersion: "1.2.3",
        },
      ];
      const body = buildBody("test-org/test-repo", alerts, { routine: true, blockers: [] });
      expect(body).toContain("[GHSA-1234-5678-9abc](https://github.com/advisories/GHSA-1234-5678-9abc)");
    });
  });

  describe("rangeUpperBound", () => {
    it("extracts the bound from a simple upper-bound range", () => {
      expect(rangeUpperBound("< 3.1.6")).toBe("3.1.6");
    });

    it("extracts the bound from a <= range", () => {
      expect(rangeUpperBound("<= 0.4.2")).toBe("0.4.2");
    });

    it("extracts the upper bound from a compound range", () => {
      expect(rangeUpperBound(">= 3.0.0, < 3.1.6")).toBe("3.1.6");
    });

    it("returns null for an empty string", () => {
      expect(rangeUpperBound("")).toBeNull();
    });

    it("returns null for undefined", () => {
      expect(rangeUpperBound(undefined)).toBeNull();
    });
  });

  describe("isBreakingBump", () => {
    it("is not breaking when the patch stays within the same major (< 3.1.6 → 3.1.6)", () => {
      expect(isBreakingBump("3.1.6", "3.1.6")).toBe(false);
    });

    it("is not breaking when the patch stays within the same major (<= 6.15.3 → 6.16.0)", () => {
      expect(isBreakingBump("6.15.3", "6.16.0")).toBe(false);
    });

    it("is breaking when a 0.x fix crosses a minor boundary (<= 0.4.2 → 0.5.0)", () => {
      expect(isBreakingBump("0.4.2", "0.5.0")).toBe(true);
    });

    it("is breaking when the patched version is unknown (<= 2.0.1 → undefined)", () => {
      expect(isBreakingBump("2.0.1", undefined)).toBe(true);
    });
  });

  describe("classifyRemediation", () => {
    const npmAlert = (over: Record<string, unknown>) => ({
      number: 1,
      severity: "high",
      packageName: "pkg",
      ecosystem: "npm",
      summary: "Some vuln",
      ghsaId: "GHSA-aaaa-bbbb-cccc",
      htmlUrl: "",
      patchedVersion: "1.2.3",
      vulnerableVersionRange: "< 1.2.3",
      ...over,
    });

    it("classifies an all-routine npm set as routine", () => {
      const result = classifyRemediation([npmAlert({})]);
      expect(result).toEqual({ routine: true, blockers: [] });
    });

    it("blocks when a patched version is unavailable", () => {
      const result = classifyRemediation([npmAlert({ patchedVersion: undefined })]);
      expect(result.routine).toBe(false);
      expect(result.blockers[0]).toContain("no patched version");
    });

    it("blocks when the ecosystem is not auto-remediable", () => {
      const result = classifyRemediation([npmAlert({ ecosystem: "pip" })]);
      expect(result.routine).toBe(false);
      expect(result.blockers[0]).toContain("pip");
    });

    it("blocks when the fix crosses a breaking version boundary", () => {
      const result = classifyRemediation([
        npmAlert({ vulnerableVersionRange: "<= 0.4.2", patchedVersion: "0.5.0" }),
      ]);
      expect(result.routine).toBe(false);
      expect(result.blockers[0]).toContain("breaking version boundary");
    });

    it("blocks when the alert count exceeds the routine cap", () => {
      const alerts = Array.from({ length: 11 }, (_, i) => npmAlert({ number: i + 1, packageName: `pkg-${i}` }));
      const result = classifyRemediation(alerts);
      expect(result.routine).toBe(false);
      expect(result.blockers.some((b) => b.includes("exceeds the 10-alert cap"))).toBe(true);
    });

    it("dedupes identical blockers from repeated packages", () => {
      const alerts = [
        npmAlert({ number: 1, packageName: "fast-uri", ecosystem: "pip" }),
        npmAlert({ number: 2, packageName: "fast-uri", ecosystem: "pip" }),
      ];
      const result = classifyRemediation(alerts);
      expect(result.blockers).toHaveLength(1);
    });
  });

  describe("Automerge label sync", () => {
    const npmAlert = (over: Record<string, unknown>) => ({
      number: 1,
      severity: "high",
      packageName: "pkg",
      ecosystem: "npm",
      summary: "Some vuln",
      ghsaId: "GHSA-aaaa-bbbb-cccc",
      htmlUrl: "",
      patchedVersion: "1.2.3",
      vulnerableVersionRange: "< 1.2.3",
      ...over,
    });

    it("passes Automerge label and refreshBody for a routine set", async () => {
      mockGh.listOpenDependabotAlerts.mockResolvedValue([npmAlert({})]);
      (ensureAlertIssue as ReturnType<typeof vi.fn>).mockResolvedValue({ outcome: "created", issueNumber: 5 });

      await processRepo(repo);

      const opts = (ensureAlertIssue as ReturnType<typeof vi.fn>).mock.calls[0]![0];
      expect(opts.labels).toContain("Automerge");
      expect(opts.refreshBody).toBe(true);
    });

    it("omits Automerge and explains blockers for a non-routine set", async () => {
      mockGh.listOpenDependabotAlerts.mockResolvedValue([npmAlert({ ecosystem: "pip" })]);
      (ensureAlertIssue as ReturnType<typeof vi.fn>).mockResolvedValue({ outcome: "created", issueNumber: 5 });

      await processRepo(repo);

      const opts = (ensureAlertIssue as ReturnType<typeof vi.fn>).mock.calls[0]![0];
      expect(opts.labels).not.toContain("Automerge");
      expect(opts.body).toContain("Remediation class: needs human review");
    });

    it("treats every set as non-routine when dependabotAutoRemediate is disabled", async () => {
      mockAutoRemediate.value = false;
      mockGh.listOpenDependabotAlerts.mockResolvedValue([npmAlert({})]);
      (ensureAlertIssue as ReturnType<typeof vi.fn>).mockResolvedValue({ outcome: "created", issueNumber: 5 });

      await processRepo(repo);

      const opts = (ensureAlertIssue as ReturnType<typeof vi.fn>).mock.calls[0]![0];
      expect(opts.labels).not.toContain("Automerge");
    });

    it("adds Automerge to an existing routine issue that lacks it", async () => {
      mockGh.listOpenDependabotAlerts.mockResolvedValue([npmAlert({})]);
      (ensureAlertIssue as ReturnType<typeof vi.fn>).mockResolvedValue({ outcome: "updated", issueNumber: 7 });
      mockGh.findIssueByExactTitle.mockResolvedValue({ number: 7, title: ISSUE_TITLE, labels: [] });

      await processRepo(repo);

      expect(mockGh.addLabel).toHaveBeenCalledWith("test-org/test-repo", 7, "Automerge");
      expect(mockGh.removeLabel).not.toHaveBeenCalled();
    });

    it("removes Automerge from an existing non-routine issue that has it", async () => {
      mockGh.listOpenDependabotAlerts.mockResolvedValue([npmAlert({ ecosystem: "pip" })]);
      (ensureAlertIssue as ReturnType<typeof vi.fn>).mockResolvedValue({ outcome: "updated", issueNumber: 7 });
      mockGh.findIssueByExactTitle.mockResolvedValue({ number: 7, title: ISSUE_TITLE, labels: ["Automerge"] });

      await processRepo(repo);

      expect(mockGh.removeLabel).toHaveBeenCalledWith("test-org/test-repo", 7, "Automerge");
      expect(mockGh.addLabel).not.toHaveBeenCalled();
    });

    it("does not sync the label when the issue was just created", async () => {
      mockGh.listOpenDependabotAlerts.mockResolvedValue([npmAlert({})]);
      (ensureAlertIssue as ReturnType<typeof vi.fn>).mockResolvedValue({ outcome: "created", issueNumber: 8 });

      await processRepo(repo);

      expect(mockGh.addLabel).not.toHaveBeenCalled();
      expect(mockGh.removeLabel).not.toHaveBeenCalled();
    });
  });
});
