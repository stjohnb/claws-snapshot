import { describe, it, expect, vi, beforeEach } from "vitest";
import { mockRepo } from "../test-helpers.js";

const mockConfig = vi.hoisted(() => ({ scheduleCheckEnabled: true }));
vi.mock("../config.js", () => ({
  WORK_DIR: "/home/testuser/.claws",
  LABELS: { priority: "Priority" },
  FLEET_INFRA_REPO: "St-John-Software/fleet-infra",
  get DEPENDENCY_SCHEDULE_CHECK_ENABLED() {
    return mockConfig.scheduleCheckEnabled;
  },
}));

vi.mock("../log.js", () => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock("../error-reporter.js", () => ({
  reportError: vi.fn(),
}));

const { mockFs, mockGh, mockClaude } = vi.hoisted(() => ({
  mockFs: {
    existsSync: vi.fn(),
    readdirSync: vi.fn(),
    readFileSync: vi.fn(),
  },
  mockGh: {
    findIssueByExactTitle: vi.fn(),
    createIssue: vi.fn(),
  },
  mockClaude: {
    ensureClone: vi.fn(),
    repoDir: vi.fn((repo: { owner: string; name: string }) => `/home/testuser/.claws/repos/${repo.owner}/${repo.name}`),
  },
}));

vi.mock("node:fs", () => ({ default: mockFs }));
vi.mock("../github.js", () => mockGh);
vi.mock("../claude.js", () => mockClaude);

import {
  run,
  detectEcosystems,
  normalizeDir,
  parseCoverage,
  renderUpdateEntries,
  cronJobScheduleProblems,
  recommendedCronJobSchedule,
  minutesInRange,
  utcOffsetsAcrossYear,
  type ExternalRenovate,
} from "./dependabot-config-scanner.js";
import * as log from "../log.js";

const REPO_DIR = "/home/testuser/.claws/repos/test-org/test-repo";
const FLEET_INFRA_DIR = "/home/testuser/.claws/repos/St-John-Software/fleet-infra";

/** Builds an fs fixture from repo root -> (repo-relative path -> file content), wiring
 *  existsSync/readdirSync/readFileSync consistently across every root. The scanner walks
 *  recursively, so a bare mockReturnValue won't do. */
function mockTrees(trees: Record<string, Record<string, string>>): void {
  const dirs = new Map<string, Map<string, boolean>>();
  const ensureDir = (d: string): Map<string, boolean> => {
    let entries = dirs.get(d);
    if (!entries) {
      entries = new Map();
      dirs.set(d, entries);
    }
    return entries;
  };

  const filePaths = new Set<string>();

  for (const [root, files] of Object.entries(trees)) {
    ensureDir(root);
    for (const relPath of Object.keys(files)) {
      const parts = relPath.split("/");
      let cur = root;
      for (const part of parts.slice(0, -1)) {
        ensureDir(cur).set(part, true);
        cur = `${cur}/${part}`;
        ensureDir(cur);
      }
      ensureDir(cur).set(parts[parts.length - 1]!, false);
      filePaths.add(`${root}/${relPath}`);
    }
  }

  mockFs.readdirSync.mockImplementation((p: string) => {
    const entries = dirs.get(p);
    if (!entries) throw Object.assign(new Error(`ENOENT: ${p}`), { code: "ENOENT" });
    return [...entries].map(([name, isDir]) => ({
      name,
      isDirectory: () => isDir,
      isFile: () => !isDir,
    }));
  });
  mockFs.existsSync.mockImplementation((p: string) => filePaths.has(p) || dirs.has(p));
  mockFs.readFileSync.mockImplementation((p: string) => {
    for (const [root, files] of Object.entries(trees)) {
      if (!p.startsWith(`${root}/`)) continue;
      const content = files[p.slice(root.length + 1)];
      if (content !== undefined) return content;
    }
    throw Object.assign(new Error(`ENOENT: ${p}`), { code: "ENOENT" });
  });
}

/** Single-root convenience wrapper over `mockTrees` for the common case of one repo clone. */
function mockTree(files: Record<string, string>): void {
  mockTrees({ [REPO_DIR]: files });
}

/** `apps/renovate/{configmap,cronjob}.yaml` as they'd read from fleet-infra's clone: `repos` are
 *  the configmap's `repositories` list (already `owner/name`), `schedule`/`timeZone` the CronJob's
 *  `spec` fields (omitted from the YAML entirely when null). */
function fleetInfraRenovateFiles(repos: string[], schedule: string | null, timeZone: string | null): Record<string, string> {
  const cronjobLines = ["spec:"];
  if (schedule !== null) cronjobLines.push(`  schedule: "${schedule}"`);
  if (timeZone !== null) cronjobLines.push(`  timeZone: ${timeZone}`);

  return {
    "apps/renovate/configmap.yaml": `data:\n  config.json: |\n    ${JSON.stringify({ repositories: repos })}\n`,
    "apps/renovate/cronjob.yaml": `${cronjobLines.join("\n")}\n`,
  };
}

/** bonkus's real shape: root npm workspace + a separate npm project at apps/mobile with its own
 *  lockfile, workspace members without lockfiles, pip, docker and workflows. */
const BONKUS_TREE: Record<string, string> = {
  "package.json": '{"workspaces":["packages/*"]}',
  "package-lock.json": "{}",
  "apps/mobile/package.json": "{}",
  "apps/mobile/package-lock.json": "{}",
  "packages/game-client/package.json": "{}",
  "packages/game-core/package.json": "{}",
  "training/requirements.txt": "flask==2.0.0\n",
  "Dockerfile": "FROM node:20\n",
  "Dockerfile.migrate": "FROM node:20\n",
  ".github/workflows/ci.yml": "name: ci\n",
};

const SCHEDULE_0300 = ["    schedule:", "      interval: weekly", '      time: "03:00"', "      timezone: Europe/London"];

const COMPLIANT_RENOVATE = JSON.stringify({ timezone: "Europe/London", schedule: ["after 7pm"] });

/** A single-ecosystem repo (github-actions at /) with the given dependabot.yml schedule lines. */
function actionsRepoWithSchedule(schedule: string[]): Record<string, string> {
  return {
    ".github/workflows/ci.yml": "name: ci\n",
    ".github/dependabot.yml": ["version: 2", "updates:", "  - package-ecosystem: github-actions", "    directory: /", ...schedule, ""].join("\n"),
  };
}

function toObject(map: Map<string, Set<string>>): Record<string, string[]> {
  return Object.fromEntries([...map].map(([k, v]) => [k, [...v].sort()]));
}

describe("dependabot-config-scanner", () => {
  const repo = mockRepo();

  beforeEach(() => {
    vi.clearAllMocks();
    mockConfig.scheduleCheckEnabled = true;
    mockGh.findIssueByExactTitle.mockResolvedValue(null);
    mockGh.createIssue.mockResolvedValue(1);
    mockClaude.ensureClone.mockResolvedValue(REPO_DIR);
  });

  describe("minutesInRange", () => {
    it("wraps midnight when start > end", () => {
      expect(minutesInRange(23 * 60, 22 * 60, 7 * 60)).toBe(true);
      expect(minutesInRange(3 * 60, 22 * 60, 7 * 60)).toBe(true);
      expect(minutesInRange(7 * 60, 22 * 60, 7 * 60)).toBe(false);
      expect(minutesInRange(12 * 60, 22 * 60, 7 * 60)).toBe(false);
      expect(minutesInRange(22 * 60, 22 * 60, 7 * 60)).toBe(true);
    });

    it("handles a same-day range", () => {
      expect(minutesInRange(9 * 60, 8 * 60, 18 * 60)).toBe(true);
      expect(minutesInRange(18 * 60, 8 * 60, 18 * 60)).toBe(false);
    });
  });

  describe("utcOffsetsAcrossYear", () => {
    it("returns winter and summer offsets in minutes", () => {
      expect(utcOffsetsAcrossYear("Europe/London", 2026)).toEqual({ january: 0, july: 60 });
      expect(utcOffsetsAcrossYear("UTC", 2026)).toEqual({ january: 0, july: 0 });
    });
  });

  describe("normalizeDir", () => {
    it("collapses every root spelling to /", () => {
      for (const input of ["", ".", "./", "/", "//"]) expect(normalizeDir(input)).toBe("/");
    });

    it("adds a leading slash and strips trailing slashes and ./ prefixes", () => {
      expect(normalizeDir("apps/mobile")).toBe("/apps/mobile");
      expect(normalizeDir("./apps/mobile/")).toBe("/apps/mobile");
      expect(normalizeDir(" /apps/mobile ")).toBe("/apps/mobile");
    });
  });

  describe("detectEcosystems", () => {
    it("anchors npm on lockfiles, dropping workspace members covered by the root", () => {
      mockTree(BONKUS_TREE);

      expect(toObject(detectEcosystems(REPO_DIR))).toEqual({
        npm: ["/", "/apps/mobile"],
        pip: ["/training"],
        docker: ["/"],
        "github-actions": ["/"],
      });
    });

    it("registers github-actions at / rather than /.github/workflows", () => {
      mockTree({ ".github/workflows/ci.yml": "name: ci\n" });

      expect(toObject(detectEcosystems(REPO_DIR))).toEqual({ "github-actions": ["/"] });
    });

    it("ignores manifests inside node_modules", () => {
      mockTree({ "node_modules/left-pad/package.json": "{}" });

      expect(detectEcosystems(REPO_DIR).size).toBe(0);
    });

    it("collapses multiple manifests of one ecosystem in a directory", () => {
      mockTree({ "Dockerfile": "", "Dockerfile.migrate": "" });

      expect(toObject(detectEcosystems(REPO_DIR))).toEqual({ docker: ["/"] });
    });

    it("keeps a nested npm project that owns a lockfile", () => {
      mockTree({
        "package.json": "{}",
        "package-lock.json": "{}",
        "sub/package.json": "{}",
        "sub/pnpm-lock.yaml": "",
      });

      expect(toObject(detectEcosystems(REPO_DIR)).npm).toEqual(["/", "/sub"]);
    });
  });

  describe("parseCoverage", () => {
    it("returns null when the document is not a readable dependabot config", () => {
      expect(parseCoverage("updates:\n  - [unclosed")).toBeNull();
      expect(parseCoverage("version: 2\nupdates: nope")).toBeNull();
    });

    it("treats an entry using directories: as covering the ecosystem everywhere", () => {
      const coverage = parseCoverage('version: 2\nupdates:\n  - package-ecosystem: npm\n    directories: ["/apps/*"]\n');

      expect(coverage!.get("npm")!.glob).toBe(true);
    });

    it("normalizes parsed directories", () => {
      const coverage = parseCoverage("version: 2\nupdates:\n  - package-ecosystem: npm\n    directory: apps/mobile/\n");

      expect([...coverage!.get("npm")!.dirs]).toEqual(["/apps/mobile"]);
    });
  });

  describe("renderUpdateEntries", () => {
    it("emits valid, sorted entries with root first", () => {
      const yaml = renderUpdateEntries(new Map([["npm", new Set(["/apps/mobile", "/"])]]));

      expect(yaml.indexOf("directory: /\n")).toBeLessThan(yaml.indexOf("directory: /apps/mobile"));
      expect(yaml).toContain("interval: weekly");
      expect(yaml).toContain("open-pull-requests-limit: 5");
      expect(yaml).toContain("all-dependencies:");
      expect(yaml).toContain('time: "19:00"');
      expect(yaml).toContain("timezone: Europe/London");
    });
  });

  describe("cronJobScheduleProblems", () => {
    const compliant: ExternalRenovate = { repos: new Set(), schedule: "0 23 * * 0", timeZone: "Europe/London" };

    it("accepts evening and overnight schedules", () => {
      expect(cronJobScheduleProblems(compliant)).toEqual([]);
      expect(cronJobScheduleProblems({ ...compliant, schedule: "0 19 * * 0" })).toEqual([]);
      expect(cronJobScheduleProblems({ ...compliant, schedule: "0 18 * * 0" })).toEqual([]);
    });

    it("flags a schedule inside office hours", () => {
      expect(cronJobScheduleProblems({ ...compliant, schedule: "0 10 * * 1" })).toEqual([
        "`apps/renovate/cronjob.yaml`: schedule `0 10 * * 1` (Europe/London) starts Renovate at 10:00, inside office hours",
      ]);
    });

    it("flags an unset timeZone", () => {
      expect(cronJobScheduleProblems({ ...compliant, timeZone: null })).toEqual([
        expect.stringContaining("`timeZone` is unset"),
      ]);
    });

    it("flags a timeZone other than Europe/London", () => {
      expect(cronJobScheduleProblems({ ...compliant, timeZone: "America/New_York" })).toEqual([
        expect.stringContaining("America/New_York"),
      ]);
    });

    it("flags an unset schedule", () => {
      expect(cronJobScheduleProblems({ ...compliant, schedule: null })).toEqual([
        expect.stringContaining("`schedule` is unset"),
      ]);
    });

    it("warns and skips the time check for a non-integer hour field", () => {
      expect(cronJobScheduleProblems({ ...compliant, schedule: "0 */2 * * 0" })).toEqual([]);
      expect(vi.mocked(log.warn)).toHaveBeenCalledWith(expect.stringContaining("unparseable"));
    });
  });

  describe("recommendedCronJobSchedule", () => {
    it("keeps the day-of-week and moves the time to 19:00", () => {
      expect(recommendedCronJobSchedule("0 10 * * 1")).toBe("0 19 * * 1");
    });

    it("defaults the day-of-week to * when the original has none", () => {
      expect(recommendedCronJobSchedule("0 10")).toBe("0 19 * * *");
    });
  });

  describe("scan", () => {
    it("skips repos without a local clone", async () => {
      mockFs.existsSync.mockReturnValue(false);

      await run([repo]);

      expect(mockClaude.ensureClone).not.toHaveBeenCalled();
      expect(mockGh.createIssue).not.toHaveBeenCalled();
    });

    it("files no issue for a repo with no dependency manifests", async () => {
      mockTree({ "README.md": "# hi\n" });

      await run([repo]);

      expect(mockGh.createIssue).not.toHaveBeenCalled();
    });

    it("files an issue listing every detected pair when no mechanism exists", async () => {
      mockTree(BONKUS_TREE);

      await run([repo]);

      expect(mockGh.createIssue).toHaveBeenCalledTimes(1);
      const [fullName, title, body, labels] = mockGh.createIssue.mock.calls[0]!;
      expect(fullName).toBe(repo.fullName);
      expect(title).toBe("Alert: missing dependency-update configuration");
      expect(labels).toEqual([]);
      expect(body).toContain("directory: /apps/mobile");
      expect(body).toContain("package-ecosystem: pip");
      expect(body).toContain("directory: /training");
      expect(body).toContain("package-ecosystem: docker");
      expect(body).toContain("package-ecosystem: github-actions");
      expect(body).not.toContain("/packages/game-core");
      expect(body).not.toContain("/packages/game-client");
    });

    it("reports a directory the existing config misses, even when its ecosystem is covered elsewhere", async () => {
      mockTree({
        ...BONKUS_TREE,
        ".github/dependabot.yml": "version: 2\nupdates:\n  - package-ecosystem: npm\n    directory: /\n",
      });

      await run([repo]);

      expect(mockGh.createIssue).toHaveBeenCalledTimes(1);
      const body = mockGh.createIssue.mock.calls[0]![2] as string;
      expect(body).toContain("`npm` at `/apps/mobile`");
      expect(body).toContain("without altering the existing entries");
      // npm at / is already covered — only the uncovered directory may be re-emitted.
      expect(body.match(/ {2}- package-ecosystem: npm\n {4}directory: \S+/g)).toEqual([
        "  - package-ecosystem: npm\n    directory: /apps/mobile",
      ]);
    });

    it("treats an ecosystem covered by a directories glob as fully covered", async () => {
      mockTree({
        "apps/mobile/package.json": "{}",
        "apps/mobile/package-lock.json": "{}",
        ".github/dependabot.yml": ["version: 2", "updates:", "  - package-ecosystem: npm", '    directories: ["/apps/*"]', ...SCHEDULE_0300, ""].join("\n"),
      });

      await run([repo]);

      expect(mockGh.createIssue).not.toHaveBeenCalled();
    });

    it("files no issue when the existing config covers every pair", async () => {
      mockTree({
        ...BONKUS_TREE,
        ".github/dependabot.yml": [
          "version: 2",
          "updates:",
          ...["npm /", "npm /apps/mobile", "pip /training", "docker /", "github-actions /"].flatMap((pair) => {
            const [eco, dir] = pair.split(" ");
            return [`  - package-ecosystem: ${eco}`, `    directory: ${dir}`, ...SCHEDULE_0300];
          }),
          "",
        ].join("\n"),
      });

      await run([repo]);

      expect(mockGh.createIssue).not.toHaveBeenCalled();
    });

    it("does not check coverage for repos using Renovate", async () => {
      mockTree({ ...BONKUS_TREE, "renovate.json": COMPLIANT_RENOVATE });

      await run([repo]);

      expect(mockGh.createIssue).not.toHaveBeenCalled();
    });

    it("respects the committed opt-out marker", async () => {
      mockTree({ ...BONKUS_TREE, ".claws/dependency-updates-optout": "" });

      await run([repo]);

      expect(mockGh.createIssue).not.toHaveBeenCalled();
    });

    it("warns instead of filing an alert when dependabot.yml cannot be parsed", async () => {
      mockTree({ ...BONKUS_TREE, ".github/dependabot.yml": "updates:\n  - [unclosed" });

      await run([repo]);

      expect(mockGh.createIssue).not.toHaveBeenCalled();
      expect(vi.mocked(log.warn)).toHaveBeenCalledWith(
        expect.stringContaining("unparseable .github/dependabot.yml"),
      );
    });

    describe("schedule check", () => {
      it("files a schedule alert for a dependabot entry at 11:00, recommending 19:00", async () => {
        mockTree(actionsRepoWithSchedule(["    schedule:", "      interval: weekly", "      day: monday", '      time: "11:00"', "      timezone: Europe/London"]));

        await run([repo]);

        expect(mockGh.createIssue).toHaveBeenCalledTimes(1);
        const [, title, body] = mockGh.createIssue.mock.calls[0]!;
        expect(title).toBe("Alert: missing dependency-update configuration");
        expect(body).toContain('`github-actions` at `/` — time "11:00" Europe/London');
        expect(body).toContain('    schedule:\n      interval: weekly\n      day: monday\n      time: "19:00"\n      timezone: Europe/London');
        expect(body).toContain("office hours (08:00–18:00 Europe/London)");
        expect(body).toContain('"dependencyScheduleCheckEnabled": false');
      });

      it.each(["03:00", "07:59", "18:00", "19:00", "22:00"])("treats %s Europe/London as compliant", async (time) => {
        mockTree(actionsRepoWithSchedule(["    schedule:", "      interval: weekly", `      time: "${time}"`, "      timezone: Europe/London"]));

        await run([repo]);

        expect(mockGh.createIssue).not.toHaveBeenCalled();
      });

      it("flags 08:00 Europe/London", async () => {
        mockTree(actionsRepoWithSchedule(["    schedule:", "      interval: weekly", '      time: "08:00"', "      timezone: Europe/London"]));

        await run([repo]);

        expect(mockGh.createIssue).toHaveBeenCalledTimes(1);
        expect(mockGh.createIssue.mock.calls[0]![2]).toContain('`github-actions` at `/` — time "08:00" Europe/London');
      });

      it("flags an entry with a timezone but no time", async () => {
        mockTree(actionsRepoWithSchedule(["    schedule:", "      interval: weekly", "      timezone: Europe/London"]));

        await run([repo]);

        expect(mockGh.createIssue.mock.calls[0]![2]).toContain("`github-actions` at `/` — no time Europe/London");
      });

      it("flags an entry with no time or timezone", async () => {
        mockTree(actionsRepoWithSchedule(["    schedule:", "      interval: daily"]));

        await run([repo]);

        const body = mockGh.createIssue.mock.calls[0]![2] as string;
        expect(body).toContain("`github-actions` at `/` — no time no timezone");
      });

      it("flags 03:00 in the wrong timezone", async () => {
        mockTree(actionsRepoWithSchedule(["    schedule:", "      interval: weekly", '      time: "03:00"', "      timezone: America/New_York"]));

        await run([repo]);

        expect(mockGh.createIssue).toHaveBeenCalledTimes(1);
      });

      it("files an alert for a Renovate config without a schedule", async () => {
        mockTree({ ...BONKUS_TREE, "renovate.json": JSON.stringify({ timezone: "Europe/London" }) });

        await run([repo]);

        const body = mockGh.createIssue.mock.calls[0]![2] as string;
        expect(body).toContain('`"schedule"` is unset');
        expect(body).toContain('"schedule": ["after 7pm"]');
        expect(body).toContain('"timezone": "Europe/London"');
      });

      it("does not alert on a Renovate config that extends a schedule preset", async () => {
        mockTree({ ...BONKUS_TREE, "renovate.json": JSON.stringify({ extends: ["schedule:nonOfficeHours"] }) });

        await run([repo]);

        expect(mockGh.createIssue).not.toHaveBeenCalled();
        expect(vi.mocked(log.warn)).toHaveBeenCalledWith(
          expect.stringContaining('extends `"schedule:nonOfficeHours"`'),
        );
      });

      it("flags an overnight Renovate schedule that runs into office hours", async () => {
        mockTree({ ...BONKUS_TREE, "renovate.json": JSON.stringify({ timezone: "Europe/London", schedule: ["after 10pm and before 9am"] }) });

        await run([repo]);

        expect(mockGh.createIssue.mock.calls[0]![2]).toContain('"after 10pm and before 9am"` falls inside office hours');
      });

      it.each([[["after 10pm", "before 7am"]], [["after 7pm"]], [["after 10pm and before 7am"]]])(
        "treats the schedule %j as compliant",
        async (schedule) => {
          mockTree({ ...BONKUS_TREE, "renovate.json": JSON.stringify({ timezone: "Europe/London", schedule }) });

          await run([repo]);

          expect(mockGh.createIssue).not.toHaveBeenCalled();
          expect(vi.mocked(log.warn)).not.toHaveBeenCalledWith(expect.stringContaining("unparseable Renovate schedule"));
        },
      );

      it("flags a daytime Renovate schedule", async () => {
        mockTree({ ...BONKUS_TREE, "renovate.json": JSON.stringify({ timezone: "Europe/London", schedule: ["after 9am and before 5pm"] }) });

        await run([repo]);

        const [, , body] = mockGh.createIssue.mock.calls[0]!;
        expect(body).toContain('"after 9am and before 5pm"` falls inside office hours');
        expect(body).toContain('"schedule": ["after 7pm"]');
      });

      it("flags a Renovate schedule of at any time", async () => {
        mockTree({ ...BONKUS_TREE, "renovate.json": JSON.stringify({ timezone: "Europe/London", schedule: "at any time" }) });

        await run([repo]);

        expect(mockGh.createIssue.mock.calls[0]![2]).toContain('"at any time"` allows any time');
      });

      it("flags a before entry within a split schedule that reaches office hours", async () => {
        mockTree({ ...BONKUS_TREE, "renovate.json": JSON.stringify({ timezone: "Europe/London", schedule: ["after 10pm", "before 9am"] }) });

        await run([repo]);

        expect(mockGh.createIssue.mock.calls[0]![2]).toContain('"before 9am"` falls inside office hours');
      });

      it("flags a daytime split schedule even though each entry parses on its own", async () => {
        mockTree({ ...BONKUS_TREE, "renovate.json": JSON.stringify({ timezone: "Europe/London", schedule: ["after 9am", "before 5pm"] }) });

        await run([repo]);

        const body = mockGh.createIssue.mock.calls[0]![2] as string;
        expect(body).toContain('"after 9am"` falls inside office hours');
        expect(body).toContain('"before 5pm"` falls inside office hours');
        expect(vi.mocked(log.warn)).not.toHaveBeenCalledWith(expect.stringContaining("unparseable Renovate schedule"));
      });

      it("alerts on a renovate.yml cron of 0 12 * * *", async () => {
        mockTree({
          ...BONKUS_TREE,
          "renovate.json": COMPLIANT_RENOVATE,
          ".github/workflows/renovate.yml": "on:\n  schedule:\n    - cron: '0 12 * * *'\n  workflow_dispatch: {}\n",
        });

        await run([repo]);

        const body = mockGh.createIssue.mock.calls[0]![2] as string;
        expect(body).toContain("cron `0 12 * * *`");
        expect(body).toContain("`0 19 * * *`");
        expect(body).not.toContain("```json");
      });

      // 07:00 UTC is 07:00 GMT (compliant) but 08:00 BST (office hours), so only the summer offset catches it.
      it("alerts on a renovate.yml cron of 0 7 * * *, which is inside office hours only in summer", async () => {
        mockTree({
          ...BONKUS_TREE,
          "renovate.json": COMPLIANT_RENOVATE,
          ".github/workflows/renovate.yml": "on:\n  schedule:\n    - cron: '0 7 * * *'\n",
        });

        await run([repo]);

        expect(mockGh.createIssue).toHaveBeenCalledTimes(1);
        expect(mockGh.createIssue.mock.calls[0]![2]).toContain("cron `0 7 * * *`");
      });

      it.each(["0 23 * * *", "0 19 * * *", "0 18 * * *"])("accepts a renovate.yml cron of %s", async (cron) => {
        mockTree({
          ...BONKUS_TREE,
          "renovate.json": COMPLIANT_RENOVATE,
          ".github/workflows/renovate.yml": `on:\n  schedule:\n    - cron: '${cron}'\n`,
        });

        await run([repo]);

        expect(mockGh.createIssue).not.toHaveBeenCalled();
      });

      it("warns and treats an unparseable Renovate config as compliant", async () => {
        mockTree({ ...BONKUS_TREE, "renovate.json5": "{ // json5\n schedule: [] }" });

        await run([repo]);

        expect(mockGh.createIssue).not.toHaveBeenCalled();
        expect(vi.mocked(log.warn)).toHaveBeenCalledWith(expect.stringContaining("unparseable renovate.json5"));
      });

      it("is suppressed for Dependabot by dependencyScheduleCheckEnabled: false", async () => {
        mockConfig.scheduleCheckEnabled = false;
        mockTree(actionsRepoWithSchedule(["    schedule:", "      interval: weekly", '      time: "11:00"', "      timezone: Europe/London"]));

        await run([repo]);

        expect(mockGh.createIssue).not.toHaveBeenCalled();
      });

      it("is suppressed for Renovate by dependencyScheduleCheckEnabled: false", async () => {
        mockConfig.scheduleCheckEnabled = false;
        mockTree({ ...BONKUS_TREE, "renovate.json": "{}" });

        await run([repo]);

        expect(mockGh.createIssue).not.toHaveBeenCalled();
      });

      it("still reports missing coverage ahead of schedule problems", async () => {
        mockTree({
          ...BONKUS_TREE,
          ".github/dependabot.yml": "version: 2\nupdates:\n  - package-ecosystem: npm\n    directory: /\n    schedule:\n      interval: weekly\n      time: \"11:00\"\n",
        });

        await run([repo]);

        const body = mockGh.createIssue.mock.calls[0]![2] as string;
        expect(body).toContain("without altering the existing entries");
        expect(body).not.toContain("Replace each listed entry");
      });
    });

    it("skips issue creation when a matching open issue already exists", async () => {
      mockTree(BONKUS_TREE);
      mockGh.findIssueByExactTitle.mockResolvedValue({ number: 42, title: "Alert: missing dependency-update configuration" });

      await run([repo]);

      expect(mockGh.createIssue).not.toHaveBeenCalled();
    });

    describe("external Renovate CronJob (fleet-infra)", () => {
      const fleetInfra = mockRepo({
        owner: "St-John-Software",
        name: "fleet-infra",
        fullName: "St-John-Software/fleet-infra",
      });

      it("flags the CronJob schedule even with a compliant renovate.json, naming the current and recommended cron", async () => {
        mockTrees({
          [FLEET_INFRA_DIR]: {
            ...BONKUS_TREE,
            "renovate.json": COMPLIANT_RENOVATE,
            ...fleetInfraRenovateFiles(["st-john-software/other-repo"], "0 10 * * 1", "Europe/London"),
          },
        });

        await run([fleetInfra]);

        expect(mockGh.createIssue).toHaveBeenCalledTimes(1);
        const [fullName, , body] = mockGh.createIssue.mock.calls[0]!;
        expect(fullName).toBe("St-John-Software/fleet-infra");
        expect(body).toContain("0 10 * * 1");
        expect(body).toContain("0 19 * * 1");
      });

      it("checks fleet-infra's CronJob even when fleet-infra is listed in the ConfigMap's repositories", async () => {
        mockTrees({
          [FLEET_INFRA_DIR]: {
            ...BONKUS_TREE,
            "renovate.json": COMPLIANT_RENOVATE,
            ...fleetInfraRenovateFiles(["st-john-software/fleet-infra", "st-john-software/other-repo"], "0 10 * * 1", "Europe/London"),
          },
        });

        await run([fleetInfra]);

        expect(mockGh.createIssue).toHaveBeenCalledTimes(1);
        const [fullName, , body] = mockGh.createIssue.mock.calls[0]!;
        expect(fullName).toBe("St-John-Software/fleet-infra");
        expect(body).toContain("0 19 * * 1");
      });

      it("files nothing for a listed fleet-infra whose CronJob runs at 19:00", async () => {
        mockTrees({
          [FLEET_INFRA_DIR]: {
            ...BONKUS_TREE,
            ...fleetInfraRenovateFiles(["st-john-software/fleet-infra"], "0 19 * * 0", "Europe/London"),
          },
        });

        await run([fleetInfra]);

        expect(mockGh.createIssue).not.toHaveBeenCalled();
      });

      it("flags a listed fleet-infra whose renovate.json schedule excludes the CronJob's 19:00 run", async () => {
        mockTrees({
          [FLEET_INFRA_DIR]: {
            ...BONKUS_TREE,
            "renovate.json": JSON.stringify({ timezone: "Europe/London", schedule: ["after 10pm and before 7am"] }),
            ...fleetInfraRenovateFiles(["st-john-software/fleet-infra"], "0 19 * * 0", "Europe/London"),
          },
        });

        await run([fleetInfra]);

        expect(mockGh.createIssue).toHaveBeenCalledTimes(1);
        const [fullName, , body] = mockGh.createIssue.mock.calls[0]!;
        expect(fullName).toBe("St-John-Software/fleet-infra");
        expect(body).toContain('`["after 10pm and before 7am"]` excludes the shared St-John-Software/fleet-infra CronJob\'s 19:00 run');
        expect(body).toContain('"schedule": ["after 7pm"]');
      });

      it("flags a listed fleet-infra whose renovate.json has a daytime schedule", async () => {
        mockTrees({
          [FLEET_INFRA_DIR]: {
            ...BONKUS_TREE,
            "renovate.json": JSON.stringify({ timezone: "Europe/London", schedule: ["after 9am and before 5pm"] }),
            ...fleetInfraRenovateFiles(["st-john-software/fleet-infra"], "0 19 * * 0", "Europe/London"),
          },
        });

        await run([fleetInfra]);

        expect(mockGh.createIssue).toHaveBeenCalledTimes(1);
        expect(mockGh.createIssue.mock.calls[0]![2]).toContain('"after 9am and before 5pm"` falls inside office hours');
      });

      it("files nothing for a listed fleet-infra whose renovate.json schedule admits the CronJob's 19:00 run", async () => {
        mockTrees({
          [FLEET_INFRA_DIR]: {
            ...BONKUS_TREE,
            "renovate.json": COMPLIANT_RENOVATE,
            ...fleetInfraRenovateFiles(["st-john-software/fleet-infra"], "0 19 * * 0", "Europe/London"),
          },
        });

        await run([fleetInfra]);

        expect(mockGh.createIssue).not.toHaveBeenCalled();
      });

      it("flags another listed repo's Renovate overlay with a daytime schedule, on that repo", async () => {
        mockTrees({
          [REPO_DIR]: { ...BONKUS_TREE, "renovate.json": JSON.stringify({ schedule: ["after 9am and before 5pm"] }) },
          [FLEET_INFRA_DIR]: fleetInfraRenovateFiles([repo.fullName.toLowerCase()], "0 19 * * 0", "Europe/London"),
        });

        await run([repo]);

        expect(mockGh.createIssue).toHaveBeenCalledTimes(1);
        const [fullName, , body] = mockGh.createIssue.mock.calls[0]!;
        expect(fullName).toBe(repo.fullName);
        expect(body).toContain('"after 9am and before 5pm"` falls inside office hours');
        expect(body).toContain("excludes the shared St-John-Software/fleet-infra CronJob's 19:00 run");
        expect(body).not.toContain("apps/renovate/cronjob.yaml");
      });

      it("files nothing for a listed repo's Renovate overlay with no schedule or timezone of its own", async () => {
        mockTrees({
          [REPO_DIR]: { ...BONKUS_TREE, "renovate.json": JSON.stringify({ extends: ["config:recommended"] }) },
          [FLEET_INFRA_DIR]: fleetInfraRenovateFiles([repo.fullName.toLowerCase()], "0 19 * * 0", "Europe/London"),
        });

        await run([repo]);

        expect(mockGh.createIssue).not.toHaveBeenCalled();
      });

      it("logs that the schedule check is disabled rather than claiming a report", async () => {
        mockConfig.scheduleCheckEnabled = false;
        mockTrees({
          [REPO_DIR]: BONKUS_TREE,
          [FLEET_INFRA_DIR]: fleetInfraRenovateFiles([repo.fullName.toLowerCase()], "0 10 * * 1", "Europe/London"),
        });

        await run([repo]);

        expect(mockGh.createIssue).not.toHaveBeenCalled();
        expect(vi.mocked(log.info)).toHaveBeenCalledWith(expect.stringContaining("inside office hours; schedule check disabled"));
        expect(vi.mocked(log.info)).not.toHaveBeenCalledWith(expect.stringContaining("reported on"));
      });

      it("does not report a daytime CronJob on another repo the CronJob covers", async () => {
        mockTrees({
          [REPO_DIR]: BONKUS_TREE,
          [FLEET_INFRA_DIR]: fleetInfraRenovateFiles([repo.fullName.toLowerCase()], "0 10 * * 1", "Europe/London"),
        });

        await run([repo]);

        expect(mockGh.createIssue).not.toHaveBeenCalled();
        expect(vi.mocked(log.info)).toHaveBeenCalledWith(expect.stringContaining("inside office hours; reported on St-John-Software/fleet-infra"));
      });

      it("files nothing when the CronJob schedule is already outside office hours", async () => {
        mockTrees({
          [FLEET_INFRA_DIR]: {
            ...BONKUS_TREE,
            "renovate.json": COMPLIANT_RENOVATE,
            ...fleetInfraRenovateFiles(["st-john-software/other-repo"], "0 23 * * 0", "Europe/London"),
          },
        });

        await run([fleetInfra]);

        expect(mockGh.createIssue).not.toHaveBeenCalled();
      });

      it("names timeZone in the body when the CronJob's timeZone is unset", async () => {
        mockTrees({
          [FLEET_INFRA_DIR]: {
            ...BONKUS_TREE,
            "renovate.json": COMPLIANT_RENOVATE,
            ...fleetInfraRenovateFiles(["st-john-software/other-repo"], "0 23 * * 0", null),
          },
        });

        await run([fleetInfra]);

        expect(mockGh.createIssue).toHaveBeenCalledTimes(1);
        const body = mockGh.createIssue.mock.calls[0]![2] as string;
        expect(body).toContain("timeZone");
      });

      it("files an issue for fleet-infra's own CronJob schedule when it carries no renovate.json", async () => {
        mockTrees({
          [FLEET_INFRA_DIR]: {
            ...BONKUS_TREE,
            ...fleetInfraRenovateFiles(["st-john-software/other-repo"], "0 10 * * 1", "Europe/London"),
          },
        });

        await run([fleetInfra]);

        expect(mockGh.createIssue).toHaveBeenCalledTimes(1);
        const body = mockGh.createIssue.mock.calls[0]![2] as string;
        expect(body).toContain("0 10 * * 1");
      });

      it("logs and skips a repo the CronJob covers, even with no update mechanism of its own", async () => {
        mockTrees({
          [REPO_DIR]: { "README.md": "# hi\n" },
          [FLEET_INFRA_DIR]: fleetInfraRenovateFiles([repo.fullName.toLowerCase()], "0 23 * * 0", "Europe/London"),
        });

        await run([repo]);

        expect(mockGh.createIssue).not.toHaveBeenCalled();
        expect(vi.mocked(log.info)).toHaveBeenCalledWith(expect.stringContaining("scheduled externally"));
      });

      it("still logs and skips an externally scheduled repo that also carries the opt-out marker", async () => {
        mockTrees({
          [REPO_DIR]: { ...BONKUS_TREE, ".claws/dependency-updates-optout": "" },
          [FLEET_INFRA_DIR]: fleetInfraRenovateFiles([repo.fullName.toLowerCase()], "0 23 * * 0", "Europe/London"),
        });

        await run([repo]);

        expect(mockGh.createIssue).not.toHaveBeenCalled();
        expect(vi.mocked(log.info)).toHaveBeenCalledWith(expect.stringContaining("scheduled externally"));
      });

      it("still files the full coverage alert for a repo the CronJob does not cover", async () => {
        mockTrees({
          [REPO_DIR]: BONKUS_TREE,
          [FLEET_INFRA_DIR]: fleetInfraRenovateFiles(["st-john-software/other-repo"], "0 23 * * 0", "Europe/London"),
        });

        await run([repo]);

        expect(mockGh.createIssue).toHaveBeenCalledTimes(1);
        const [, title] = mockGh.createIssue.mock.calls[0]!;
        expect(title).toBe("Alert: missing dependency-update configuration");
      });

      it("behaves as before and logs when fleet-infra's clone has no Renovate manifests", async () => {
        mockTree(BONKUS_TREE);

        await run([repo]);

        expect(mockGh.createIssue).toHaveBeenCalledTimes(1);
        expect(vi.mocked(log.info)).toHaveBeenCalledWith(expect.stringContaining("no self-hosted Renovate manifests"));
      });

      it("warns and behaves as before when fleet-infra's Renovate manifests are unparseable", async () => {
        mockTrees({
          [REPO_DIR]: BONKUS_TREE,
          [FLEET_INFRA_DIR]: {
            "apps/renovate/configmap.yaml": "data:\n  config.json: |\n    { not json\n",
            "apps/renovate/cronjob.yaml": 'spec:\n  schedule: "0 23 * * 0"\n  timeZone: Europe/London\n',
          },
        });

        await run([repo]);

        expect(mockGh.createIssue).toHaveBeenCalledTimes(1);
        expect(vi.mocked(log.warn)).toHaveBeenCalledWith(expect.stringContaining("unreadable or unparseable"));
      });

      it("does not file a CronJob-only issue when the schedule check is disabled", async () => {
        mockConfig.scheduleCheckEnabled = false;
        mockTrees({
          [FLEET_INFRA_DIR]: {
            ...BONKUS_TREE,
            ".github/dependabot.yml": [
              "version: 2",
              "updates:",
              ...["npm /", "npm /apps/mobile", "pip /training", "docker /", "github-actions /"].flatMap((pair) => {
                const [eco, dir] = pair.split(" ");
                return [`  - package-ecosystem: ${eco}`, `    directory: ${dir}`, ...SCHEDULE_0300];
              }),
              "",
            ].join("\n"),
            ...fleetInfraRenovateFiles(["st-john-software/fleet-infra"], "0 10 * * 1", "Europe/London"),
          },
        });

        await run([fleetInfra]);

        expect(mockGh.createIssue).not.toHaveBeenCalled();
      });
    });
  });
});
