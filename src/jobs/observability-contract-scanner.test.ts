import { describe, it, expect, vi, beforeEach } from "vitest";
import { mockRepo } from "../test-helpers.js";

vi.mock("../config.js", () => ({
  WORK_DIR: "/home/testuser/.claws",
  SELF_REPO: "St-John-Software/claws",
}));

vi.mock("../log.js", () => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock("../error-reporter.js", () => ({
  reportError: vi.fn(),
}));

const { mockFs, mockGh, mockClaude, mockClawsIssues } = vi.hoisted(() => ({
  mockFs: {
    existsSync: vi.fn(),
    readdirSync: vi.fn(),
    readFileSync: vi.fn(),
  },
  mockGh: {
    findIssueByExactTitle: vi.fn(),
    createIssue: vi.fn(),
    editIssue: vi.fn(),
    editIssueTitle: vi.fn(),
  },
  mockClaude: {
    ensureClone: vi.fn(),
    repoDir: vi.fn((repo: { owner: string; name: string }) => `/home/testuser/.claws/repos/${repo.owner}/${repo.name}`),
  },
  mockClawsIssues: {
    CLAWS_NATIVE_LOGIN: "claws",
    findOpenIssueByDedupeKey: vi.fn(),
    findRecentlyClosedIssueByDedupeKey: vi.fn(),
    createIssue: vi.fn(),
    editIssue: vi.fn(),
  },
}));

vi.mock("node:fs", () => ({ default: mockFs }));
vi.mock("../github.js", () => mockGh);
vi.mock("../claude.js", () => mockClaude);
vi.mock("../claws-issues.js", () => mockClawsIssues);

import { KNOWN_GAPS_DEDUPE_KEY, KNOWN_GAPS_ISSUE_TITLE, run } from "./observability-contract-scanner.js";
import { KNOWN_GAPS_HEADING, LOGGING_CONTRACT_MARKDOWN, NO_TELEMETRY_SENTENCE, OBSERVABILITY_CONTRACT_MARKDOWN, OBSERVABILITY_PLACEHOLDER } from "../observability-contract.js";

const REPO_DIR = "/home/testuser/.claws/repos/test-org/test-repo";
const ISSUE_TITLE = "chore: declare this repo's observability policy";
const LEGACY_ISSUE_TITLE = "chore: adopt the structured logging contract";
const NON_SERVICE_HINT = "No runnable service detected";
const SERVICE_HINT = "Runnable service detected";
const FILLED_POLICY = OBSERVABILITY_CONTRACT_MARKDOWN.replaceAll(`${OBSERVABILITY_PLACEHOLDER} `, "");

function filedBody(): string {
  expect(mockGh.createIssue).toHaveBeenCalledTimes(1);
  return mockGh.createIssue.mock.calls[0]![2] as string;
}

/** Builds an fs fixture from repo-relative path -> file content, wiring existsSync/readdirSync/
 *  readFileSync consistently. The scanner walks recursively, so a bare mockReturnValue won't do. */
function mockTree(files: Record<string, string>): void {
  const dirs = new Map<string, Map<string, boolean>>();
  const ensureDir = (d: string): Map<string, boolean> => {
    let entries = dirs.get(d);
    if (!entries) {
      entries = new Map();
      dirs.set(d, entries);
    }
    return entries;
  };

  ensureDir(REPO_DIR);
  for (const relPath of Object.keys(files)) {
    const parts = relPath.split("/");
    let cur = REPO_DIR;
    for (const part of parts.slice(0, -1)) {
      ensureDir(cur).set(part, true);
      cur = `${cur}/${part}`;
      ensureDir(cur);
    }
    ensureDir(cur).set(parts[parts.length - 1]!, false);
  }

  const filePaths = new Set(Object.keys(files).map((f) => `${REPO_DIR}/${f}`));

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
    const rel = p.startsWith(`${REPO_DIR}/`) ? p.slice(REPO_DIR.length + 1) : null;
    const content = rel === null ? undefined : files[rel];
    if (content === undefined) throw Object.assign(new Error(`ENOENT: ${p}`), { code: "ENOENT" });
    return content;
  });
}

describe("observability-contract-scanner", () => {
  const repo = mockRepo();

  beforeEach(() => {
    vi.clearAllMocks();
    mockGh.findIssueByExactTitle.mockResolvedValue(null);
    mockGh.createIssue.mockResolvedValue(1);
    mockClaude.ensureClone.mockResolvedValue(REPO_DIR);
    mockClawsIssues.findOpenIssueByDedupeKey.mockResolvedValue(undefined);
    mockClawsIssues.findRecentlyClosedIssueByDedupeKey.mockResolvedValue(undefined);
    mockClawsIssues.createIssue.mockResolvedValue("clw_new");
  });

  it("files an issue for an express repo with console.log and no policy", async () => {
    mockTree({
      "package.json": JSON.stringify({ dependencies: { express: "^4.0.0" } }),
      "src/server.ts": "console.log('listening');\nconsole.error(err);\n",
      "src/server.test.ts": "console.log('ignored');\n",
      "AGENTS.md": "# Repo\n\n## Build\n\nRun npm test.",
    });

    await run([repo]);

    expect(mockGh.createIssue).toHaveBeenCalledTimes(1);
    const [fullName, title, body, labels] = mockGh.createIssue.mock.calls[0]!;
    expect(fullName).toBe(repo.fullName);
    expect(title).toBe(ISSUE_TITLE);
    expect(labels).toEqual([]);
    expect(body).toContain("`src/server.ts`");
    expect(body).not.toContain("server.test.ts");
    expect(body).toContain("2 direct `console.*` call site(s)");
    expect(body).toContain("No structured logger dependency");
    expect(body).toContain("`AGENTS.md` exists but has no observability or logging section");
    expect(body).toContain("- No `docs/observability.md` and no `docs/logging.md`");
    expect(body).not.toContain("No `AGENTS.md`");
    expect(body).toContain("`express` with no structured logger");
    expect(body).toContain(SERVICE_HINT);
    expect(body).toContain("server dependency `express`");
    expect(body).toContain("**Logging rules:**");
    expect(body).toContain("One JSON object per line on stdout");
    expect(body).toContain("**Observability sections:**");
    expect(body).toContain("Latency budgets, SLOs or uptime targets");
    expect(body).toContain("Add a shared logger module");
    expect(body).toContain(`\`\`\`\`markdown\n${OBSERVABILITY_CONTRACT_MARKDOWN}\n\`\`\`\``);
    expect(body).toContain("docs/observability-contract.md");
    expect(body).toContain("`observability-contract-scanner` job-disable config");
  });

  it("flags a repo whose AGENTS.md has only the logging contract for observability sections alone", async () => {
    mockTree({
      "package.json": JSON.stringify({ dependencies: { express: "^4.0.0" } }),
      "src/server.ts": "console.log('still migrating');\n",
      "AGENTS.md": `# Repo\n\n${LOGGING_CONTRACT_MARKDOWN}\n\n## Build\n\nRun npm test.\n`,
    });

    await run([repo]);

    const body = filedBody();
    expect(body).toContain("Logging already satisfied");
    expect(body).not.toContain("One JSON object per line on stdout\n");
    expect(body).not.toContain("Add a shared logger module");
    expect(body).toContain("Metrics: endpoint or analytics");
    expect(body).toContain("`AGENTS.md` has an observability policy, but it is incomplete");
  });

  const OBS_ONLY = [
    "## Observability",
    "",
    "Scope: one Deployment.",
    "Metrics: Prometheus at /metrics.",
    "Traces: none.",
    "Latency budgets: p95 under 300ms.",
    "Dashboards and alerts live in Grafana.",
    "What every change adds: instrument each new route and background job.",
    "",
    KNOWN_GAPS_HEADING,
    "",
    "None.",
    "",
  ].join("\n");

  it("skips a repo with the logging block and a separate observability section in AGENTS.md", async () => {
    mockTree({
      "package.json": JSON.stringify({ dependencies: { express: "^4.0.0" } }),
      "AGENTS.md": `# Repo\n\n${LOGGING_CONTRACT_MARKDOWN}\n\n${OBS_ONLY}\n## Build\n`,
    });
    await run([repo]);
    expect(mockGh.createIssue).not.toHaveBeenCalled();
  });

  it("skips a repo with docs/logging.md and an AGENTS.md observability section", async () => {
    mockTree({
      "package.json": JSON.stringify({ dependencies: { express: "^4.0.0" } }),
      "docs/logging.md": `# Logging\n\n${LOGGING_CONTRACT_MARKDOWN}\n`,
      "AGENTS.md": `# Repo\n\n${OBS_ONLY}\n## Build\n`,
    });
    await run([repo]);
    expect(mockGh.createIssue).not.toHaveBeenCalled();
  });

  it("skips a repo whose AGENTS.md carries a filled-in observability section", async () => {
    mockTree({
      "package.json": JSON.stringify({ dependencies: { express: "^4.0.0" } }),
      "AGENTS.md": `# Repo\n\n${FILLED_POLICY}\n\n## Build\n\nRun npm test.\n`,
    });

    await run([repo]);

    expect(mockGh.createIssue).not.toHaveBeenCalled();
  });

  it("skips a repo whose docs/observability.md covers every rule as a whole document", async () => {
    mockTree({
      Dockerfile: "FROM node:22",
      "docs/observability.md": [
        "# Observability",
        "",
        "Scope: one Deployment.",
        "Logs: one JSON object per line on stdout, lowercase level, err objects, no secrets.",
        "Metrics: Prometheus. Traces: none. Latency budget: p95 300 ms.",
        "Dashboards and alerts live in fleet-infra. Instrument every new route and background job.",
        "",
        "## Known gaps",
        "",
        "None.",
      ].join("\n"),
    });

    await run([repo]);

    expect(mockGh.createIssue).not.toHaveBeenCalled();
    expect(mockClawsIssues.createIssue).not.toHaveBeenCalled();
  });

  it("files the declare issue with the verification paragraph for a complete policy without Known gaps", async () => {
    mockTree({
      Dockerfile: "FROM node:22",
      "docs/observability.md": [
        "# Observability",
        "",
        "Scope: one Deployment.",
        "Logs: one JSON object per line on stdout, lowercase level, err objects, no secrets.",
        "Metrics: Prometheus. Traces: none. Latency budget: p95 300 ms.",
        "Dashboards and alerts live in fleet-infra. Instrument every new route and background job.",
      ].join("\n"),
    });

    await run([repo]);

    const body = filedBody();
    expect(body).toContain("`docs/observability.md` has an observability policy, but it is incomplete");
    expect(body).toContain("**Check the policy against the code.**");
    expect(body).toContain("correct any the code does not support");
    expect(body).toContain("Known gaps: where existing code falls short of the contract, or None");
    expect(body).toContain(`add a \`${KNOWN_GAPS_HEADING}\` section`);
    expect(body).toContain(KNOWN_GAPS_ISSUE_TITLE);
    expect(body).toContain(KNOWN_GAPS_DEDUPE_KEY);
  });

  it("flags a repo that pasted the starter template without filling it in", async () => {
    mockTree({
      "docs/observability.md": `# Observability\n\n${OBSERVABILITY_CONTRACT_MARKDOWN}\n`,
    });

    await run([repo]);

    const body = filedBody();
    expect(body).toContain("Logging already satisfied");
    expect(body).toContain("No `TODO(observability)` placeholder lines");
    expect(body).not.toContain("Metrics: endpoint or analytics");
  });

  it("skips a repo that declares it emits no runtime telemetry and lists its Known gaps", async () => {
    mockTree({
      "package.json": JSON.stringify({ name: "a-library" }),
      "AGENTS.md": `# Repo\n\n## Observability\n\n${NO_TELEMETRY_SENTENCE}\n\n${KNOWN_GAPS_HEADING}\n\nNone.\n\n## Build\n`,
    });

    await run([repo]);

    expect(mockGh.createIssue).not.toHaveBeenCalled();
  });

  it("flags a no-telemetry policy without Known gaps and asks for the code check", async () => {
    mockTree({
      "package.json": JSON.stringify({ name: "a-library" }),
      "AGENTS.md": `# Repo\n\n## Observability\n\n${NO_TELEMETRY_SENTENCE}\n\n## Build\n`,
    });

    await run([repo]);

    const body = filedBody();
    expect(body).toContain("**Check the policy against the code.**");
    expect(body).toContain("Known gaps: where existing code falls short of the contract, or None");
  });

  describe("known-gaps follow-up", () => {
    const policyWith = (gaps: string[]): string =>
      `# Repo\n\n${LOGGING_CONTRACT_MARKDOWN}\n\n${OBS_ONLY.replace("None.\n", gaps.join("\n") + "\n")}\n## Build\n`;

    it("files one native issue per repo listing the unaccepted gaps", async () => {
      mockTree({
        "AGENTS.md": policyWith(["- `request_id` is never emitted.", "- Accepted: no traces, single process.", "- No DB query durations."]),
      });

      await run([repo]);

      expect(mockGh.createIssue).not.toHaveBeenCalled();
      expect(mockClawsIssues.findOpenIssueByDedupeKey).toHaveBeenCalledWith(repo.fullName, KNOWN_GAPS_DEDUPE_KEY);
      expect(mockClawsIssues.createIssue).toHaveBeenCalledTimes(1);
      const input = mockClawsIssues.createIssue.mock.calls[0]![0];
      expect(input).toMatchObject({
        title: KNOWN_GAPS_ISSUE_TITLE,
        authorLogin: "claws",
        repos: [repo.fullName],
        source: "automation",
        dedupeKey: KNOWN_GAPS_DEDUPE_KEY,
      });
      expect(input.body).toContain("`AGENTS.md` lists 2 known observability gap(s)");
      expect(input.body).toContain("- `request_id` is never emitted.");
      expect(input.body).toContain("- No DB query durations.");
      expect(input.body).not.toContain("no traces, single process");
      expect(input.body).toContain("never re-files it after a close as not planned");
    });

    it("rewrites the open issue in place when its body differs", async () => {
      mockTree({ "AGENTS.md": policyWith(["- No DB query durations."]) });
      mockClawsIssues.findOpenIssueByDedupeKey.mockResolvedValue({ id: "clw_open", body: "old body" });

      await run([repo]);

      expect(mockClawsIssues.createIssue).not.toHaveBeenCalled();
      expect(mockClawsIssues.editIssue).toHaveBeenCalledTimes(1);
      expect(mockClawsIssues.editIssue.mock.calls[0]![0]).toBe("clw_open");
      expect(mockClawsIssues.editIssue.mock.calls[0]![1]).toContain("- No DB query durations.");
    });

    it("leaves an open issue whose body already matches", async () => {
      mockTree({ "AGENTS.md": policyWith(["- No DB query durations."]) });
      await run([repo]);
      const body = mockClawsIssues.createIssue.mock.calls[0]![0].body as string;
      vi.clearAllMocks();
      mockClawsIssues.findOpenIssueByDedupeKey.mockResolvedValue({ id: "clw_open", body });

      await run([repo]);

      expect(mockClawsIssues.editIssue).not.toHaveBeenCalled();
      expect(mockClawsIssues.createIssue).not.toHaveBeenCalled();
    });

    it("never re-files after a close as not planned", async () => {
      mockTree({ "AGENTS.md": policyWith(["- No DB query durations."]) });
      mockClawsIssues.findRecentlyClosedIssueByDedupeKey.mockResolvedValue({ id: "clw_closed", state_reason: "not_planned" });

      await run([repo]);

      expect(mockClawsIssues.findRecentlyClosedIssueByDedupeKey).toHaveBeenCalledWith(repo.fullName, KNOWN_GAPS_DEDUPE_KEY, new Date(0));
      expect(mockClawsIssues.createIssue).not.toHaveBeenCalled();
    });

    it("re-files after a close as completed while unaccepted gaps remain", async () => {
      mockTree({ "AGENTS.md": policyWith(["- No DB query durations."]) });
      mockClawsIssues.findRecentlyClosedIssueByDedupeKey.mockResolvedValue({ id: "clw_closed", state_reason: "completed" });

      await run([repo]);

      expect(mockClawsIssues.createIssue).toHaveBeenCalledTimes(1);
    });

    it("files nothing when every gap is accepted or the section says None.", async () => {
      mockTree({ "AGENTS.md": policyWith(["- **Accepted:** no traces, single process."]) });
      await run([repo]);
      mockTree({ "AGENTS.md": policyWith(["None."]) });
      await run([repo]);

      expect(mockGh.createIssue).not.toHaveBeenCalled();
      expect(mockClawsIssues.findOpenIssueByDedupeKey).not.toHaveBeenCalled();
      expect(mockClawsIssues.createIssue).not.toHaveBeenCalled();
    });

    it("reads the whole docs/observability.md as the policy", async () => {
      mockTree({
        "docs/observability.md": "# Observability\n\nScope: one CronJob.\n\n## Known gaps\n\n- No failure metric for the CronJob.\n",
      });

      await run([repo]);

      expect(mockClawsIssues.createIssue).toHaveBeenCalledTimes(1);
      expect(mockClawsIssues.createIssue.mock.calls[0]![0].body).toContain("`docs/observability.md` lists 1 known observability gap(s)");
    });
  });

  it("treats the logging contract inside a fence as satisfying logging only", async () => {
    mockTree({
      "package.json": JSON.stringify({ dependencies: { express: "^4.0.0" } }),
      "src/server.ts": "console.log('still migrating');\n",
      "AGENTS.md": `# Repo\n\n\`\`\`\`markdown\n${LOGGING_CONTRACT_MARKDOWN}\n\`\`\`\`\n\n## Build\n\nRun npm test.\n`,
    });

    await run([repo]);

    expect(filedBody()).toContain("Logging already satisfied");
  });

  it("flags a repo whose docs/logging.md covers only the logging contract for observability sections", async () => {
    mockTree({
      Dockerfile: "FROM node:22",
      "docs/logging.md": `# Logging\n\n${LOGGING_CONTRACT_MARKDOWN}`,
    });

    await run([repo]);

    const body = filedBody();
    expect(body).toContain("Logging already satisfied");
    expect(body).toContain("`docs/logging.md` has an observability policy, but it is incomplete");
  });

  it("files an issue when the logging section covers none of the rules", async () => {
    mockTree({
      "package.json": JSON.stringify({ dependencies: { fastify: "^4.0.0", pino: "^9.0.0" } }),
      "AGENTS.md": "# Repo\n\n## Logging\n\nWe log things.\n",
    });

    await run([repo]);

    expect(mockGh.createIssue).toHaveBeenCalledTimes(1);
    const body = mockGh.createIssue.mock.calls[0]![2] as string;
    expect(body).toContain("Structured logger dependency present: `pino`");
    expect(body).toContain("`AGENTS.md` has an observability policy, but it is incomplete");
    expect(body).toContain("Errors logged as an `err` object");
    expect(body).toContain("No direct `console.*` call sites");
  });

  it("treats a static Astro site with no server adapter and no Dockerfile as a non-service repo", async () => {
    mockTree({
      "package.json": JSON.stringify({ dependencies: { astro: "^4.0.0" }, scripts: { start: "astro dev" } }),
      "src/pages/index.astro": "---\n---\n<h1>Hi</h1>",
    });

    await run([repo]);

    const body = filedBody();
    expect(body).toContain(NON_SERVICE_HINT);
    expect(body).not.toContain("`console.*` call site");
  });

  it("files an issue for an Astro site with a server adapter", async () => {
    mockTree({
      "package.json": JSON.stringify({ dependencies: { astro: "^4.0.0", "@astrojs/node": "^8.0.0" }, scripts: { start: "node dist/server/entry.mjs" } }),
    });

    await run([repo]);

    expect(filedBody()).toContain(SERVICE_HINT);
  });

  it("treats a Next.js static export (output: 'export') with no Dockerfile as a non-service repo", async () => {
    mockTree({
      "package.json": JSON.stringify({ dependencies: { next: "^16.0.0" }, scripts: { start: "next start" } }),
      "next.config.ts": "export default { output: 'export' };\n",
      "lib/storage.ts": "console.warn(\"localStorage unavailable\");\n",
    });

    await run([repo]);

    const body = filedBody();
    expect(body).toContain(NON_SERVICE_HINT);
    expect(body).not.toContain("`console.*` call site");
  });

  it("treats a Vite site whose Dockerfile ends on nginx-unprivileged (whyrr) as a non-service repo", async () => {
    mockTree({
      Dockerfile:
        "FROM node:22-alpine AS build\nWORKDIR /app\nCOPY . .\nRUN npm ci && npm run build\n\nFROM nginxinc/nginx-unprivileged:stable-alpine\nCOPY --from=build /app/dist /usr/share/nginx/html\n",
      "package.json": JSON.stringify({
        dependencies: { idb: "^8.0.0", three: "^0.160.0" },
        devDependencies: { vite: "^5.0.0", vitest: "^1.0.0", typescript: "^5.0.0" },
        scripts: { dev: "vite", build: "vite build", preview: "vite preview", test: "vitest", typecheck: "tsc" },
      }),
      "src/main.ts": "console.error('boom');\n",
    });

    await run([repo]);

    const body = filedBody();
    expect(body).toContain(NON_SERVICE_HINT);
    expect(body).not.toContain("`console.*` call site");
  });

  it("treats a CRA static SPA with react-scripts and no Dockerfile as a non-service repo", async () => {
    mockTree({
      "package.json": JSON.stringify({
        dependencies: { react: "^18.2.0", "react-scripts": "^5.0.1" },
        scripts: { start: "react-scripts start", build: "react-scripts build" },
      }),
      "src/serviceWorkerRegistration.js": "console.log('registered');\n",
    });

    await run([repo]);

    const body = filedBody();
    expect(body).toContain(NON_SERVICE_HINT);
    expect(body).not.toContain("`console.*` call site");
  });

  it("files an issue for a Next.js app without output: 'export'", async () => {
    mockTree({
      "package.json": JSON.stringify({ dependencies: { next: "^16.0.0" }, scripts: { start: "next start" } }),
      "next.config.ts": "export default { output: 'standalone' };\n",
      "lib/storage.ts": "console.warn(\"localStorage unavailable\");\n",
    });

    await run([repo]);

    expect(filedBody()).toContain(SERVICE_HINT);
  });

  it("files an issue for a Next.js static export with a root Dockerfile", async () => {
    mockTree({
      "package.json": JSON.stringify({ dependencies: { next: "^16.0.0" }, scripts: { start: "next start" } }),
      "next.config.ts": "export default { output: 'export' };\n",
      Dockerfile: "FROM node:22",
    });

    await run([repo]);

    expect(filedBody()).toContain(SERVICE_HINT);
  });

  it("treats a repo as non-service when the final stage is reached via an alias chain to nginx", async () => {
    mockTree({
      Dockerfile: "FROM nginx:alpine AS web\nCOPY dist /usr/share/nginx/html\n\nFROM web\n",
      "package.json": JSON.stringify({ devDependencies: { vite: "^5.0.0" } }),
    });

    await run([repo]);

    const body = filedBody();
    expect(body).toContain(NON_SERVICE_HINT);
    expect(body).not.toContain("`console.*` call site");
  });

  it("treats a static site behind caddy as a non-service repo", async () => {
    mockTree({
      Dockerfile: "FROM caddy:2-alpine\nCOPY dist /srv\n",
      "package.json": JSON.stringify({ devDependencies: { vite: "^5.0.0" } }),
    });

    await run([repo]);

    const body = filedBody();
    expect(body).toContain(NON_SERVICE_HINT);
    expect(body).not.toContain("`console.*` call site");
  });

  it("treats a static site behind httpd with a digest-pinned image as a non-service repo", async () => {
    mockTree({
      Dockerfile: "FROM docker.io/library/httpd@sha256:deadbeef\nCOPY dist /usr/local/apache2/htdocs\n",
      "package.json": JSON.stringify({ devDependencies: { vite: "^5.0.0" } }),
    });

    await run([repo]);

    const body = filedBody();
    expect(body).toContain(NON_SERVICE_HINT);
    expect(body).not.toContain("`console.*` call site");
  });

  it("files an issue when the final stage is nginx but package.json has a server dep", async () => {
    mockTree({
      Dockerfile: "FROM nginx:alpine\nCOPY dist /usr/share/nginx/html\n",
      "package.json": JSON.stringify({ dependencies: { express: "^4.0.0" } }),
    });

    await run([repo]);

    expect(filedBody()).toContain(SERVICE_HINT);
  });

  it("files an issue for a react-scripts repo that ships a Dockerfile", async () => {
    mockTree({
      "package.json": JSON.stringify({
        dependencies: { react: "^18.2.0", "react-scripts": "^5.0.1" },
        scripts: { start: "react-scripts start", build: "react-scripts build" },
      }),
      Dockerfile: "FROM node:22",
    });

    await run([repo]);

    expect(filedBody()).toContain(SERVICE_HINT);
  });

  it("files an issue when the final stage is nginx but package.json has a start script", async () => {
    mockTree({
      Dockerfile: "FROM nginx:alpine\nCOPY dist /usr/share/nginx/html\n",
      "package.json": JSON.stringify({ scripts: { start: "node server.js" } }),
    });

    await run([repo]);

    expect(filedBody()).toContain(SERVICE_HINT);
  });

  it("files an issue when an alias chain resolves to a node image", async () => {
    mockTree({
      Dockerfile: "FROM node:26-alpine AS base\nFROM base AS runner\nCMD [\"node\", \"index.js\"]\n",
    });

    await run([repo]);

    expect(filedBody()).toContain(SERVICE_HINT);
  });

  it("files an issue when the Dockerfile has no FROM lines at all", async () => {
    mockTree({
      Dockerfile: "# no base image\nCMD [\"true\"]\n",
    });

    await run([repo]);

    expect(filedBody()).toContain(SERVICE_HINT);
  });

  it("files an issue for a react-scripts repo that also depends on a server framework", async () => {
    mockTree({
      "package.json": JSON.stringify({
        dependencies: { react: "^18.2.0", "react-scripts": "^5.0.1", express: "^4.0.0" },
        scripts: { start: "node server.js", build: "react-scripts build" },
      }),
    });

    await run([repo]);

    expect(filedBody()).toContain(SERVICE_HINT);
  });

  it("treats a repo with no package.json and no Dockerfile as a non-service repo", async () => {
    mockTree({
      "main.go": "package main",
      "README.md": "# Repo",
    });

    await run([repo]);

    const body = filedBody();
    expect(body).toContain(NON_SERVICE_HINT);
    expect(body).not.toContain("`console.*` call site");
  });

  it("scans claws itself like any other repo", async () => {
    const self = mockRepo({ owner: "St-John-Software", name: "claws", fullName: "St-John-Software/claws" });
    mockClaude.repoDir.mockReturnValueOnce(REPO_DIR);
    mockTree({
      "package.json": JSON.stringify({ dependencies: { express: "^4.0.0" } }),
    });

    await run([self]);

    expect(mockGh.createIssue).toHaveBeenCalledWith(self.fullName, ISSUE_TITLE, expect.any(String), []);
  });

  it("does not throw on a malformed package.json", async () => {
    mockTree({
      "package.json": "{ not valid json",
      Dockerfile: "FROM node:22",
    });

    await expect(run([repo])).resolves.not.toThrow();
    expect(mockGh.createIssue).toHaveBeenCalledTimes(1);
  });

  it("does not create an issue when one with the exact title is already open", async () => {
    mockGh.findIssueByExactTitle.mockResolvedValue({ number: 7, labels: [] });
    mockTree({
      "package.json": JSON.stringify({ dependencies: { express: "^4.0.0" } }),
    });

    await run([repo]);

    expect(mockGh.findIssueByExactTitle).toHaveBeenCalledWith(repo.fullName, ISSUE_TITLE);
    expect(mockGh.createIssue).not.toHaveBeenCalled();
    expect(mockGh.editIssueTitle).not.toHaveBeenCalled();
  });

  it("migrates an open legacy logging-contract issue in place instead of filing a second one", async () => {
    mockGh.findIssueByExactTitle.mockImplementation(async (_repo: string, title: string) =>
      title === LEGACY_ISSUE_TITLE ? { number: 9, title, labels: [] } : null,
    );
    mockTree({
      "package.json": JSON.stringify({ dependencies: { express: "^4.0.0" } }),
    });

    await run([repo]);

    expect(mockGh.createIssue).not.toHaveBeenCalled();
    expect(mockGh.editIssueTitle).toHaveBeenCalledWith(repo.fullName, 9, ISSUE_TITLE);
    expect(mockGh.editIssue).toHaveBeenCalledWith(repo.fullName, 9, expect.stringContaining("**Observability sections:**"));
  });
});
