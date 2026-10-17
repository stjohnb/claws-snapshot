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

import { run } from "./logging-conventions-scanner.js";
import { LOGGING_CONTRACT_MARKDOWN } from "../logging-contract.js";

const REPO_DIR = "/home/testuser/.claws/repos/test-org/test-repo";
const ISSUE_TITLE = "chore: adopt the structured logging contract";

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

describe("logging-conventions-scanner", () => {
  const repo = mockRepo();

  beforeEach(() => {
    vi.clearAllMocks();
    mockGh.findIssueByExactTitle.mockResolvedValue(null);
    mockGh.createIssue.mockResolvedValue(1);
    mockClaude.ensureClone.mockResolvedValue(REPO_DIR);
  });

  it("files an issue for an express repo with console.log and no logging section", async () => {
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
    expect(body).toContain("`AGENTS.md` exists but has no logging section");
    expect(body).toContain("- No `docs/logging.md`");
    expect(body).not.toContain("No `AGENTS.md`");
    expect(body).toContain("`express` with no structured logger");
    expect(body).toContain(LOGGING_CONTRACT_MARKDOWN);
    expect(body).toContain("docs/logging-conventions.md");
  });

  it("skips a repo whose AGENTS.md contains the canonical contract block", async () => {
    mockTree({
      "package.json": JSON.stringify({ dependencies: { express: "^4.0.0" } }),
      "src/server.ts": "console.log('still migrating');\n",
      "AGENTS.md": `# Repo\n\n${LOGGING_CONTRACT_MARKDOWN}\n\n## Build\n\nRun npm test.\n`,
    });

    await run([repo]);

    expect(mockGh.createIssue).not.toHaveBeenCalled();
  });

  it("skips a repo whose AGENTS.md contains the canonical contract block inside a fence", async () => {
    mockTree({
      "package.json": JSON.stringify({ dependencies: { express: "^4.0.0" } }),
      "src/server.ts": "console.log('still migrating');\n",
      "AGENTS.md": `# Repo\n\n\`\`\`\`markdown\n${LOGGING_CONTRACT_MARKDOWN}\n\`\`\`\`\n\n## Build\n\nRun npm test.\n`,
    });

    await run([repo]);

    expect(mockGh.createIssue).not.toHaveBeenCalled();
  });

  it("skips a repo whose docs/logging.md covers the contract", async () => {
    mockTree({
      Dockerfile: "FROM node:22",
      "docs/logging.md": `# Logging\n\n${LOGGING_CONTRACT_MARKDOWN}`,
    });

    await run([repo]);

    expect(mockGh.createIssue).not.toHaveBeenCalled();
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
    expect(body).toContain("`AGENTS.md` has a logging section, but it does not cover");
    expect(body).toContain("No direct `console.*` call sites");
  });

  it("skips a static Astro site with no server adapter and no Dockerfile", async () => {
    mockTree({
      "package.json": JSON.stringify({ dependencies: { astro: "^4.0.0" }, scripts: { start: "astro dev" } }),
      "src/pages/index.astro": "---\n---\n<h1>Hi</h1>",
    });

    await run([repo]);

    expect(mockGh.createIssue).not.toHaveBeenCalled();
  });

  it("files an issue for an Astro site with a server adapter", async () => {
    mockTree({
      "package.json": JSON.stringify({ dependencies: { astro: "^4.0.0", "@astrojs/node": "^8.0.0" }, scripts: { start: "node dist/server/entry.mjs" } }),
    });

    await run([repo]);

    expect(mockGh.createIssue).toHaveBeenCalledTimes(1);
  });

  it("skips a Next.js static export (output: 'export') with no Dockerfile", async () => {
    mockTree({
      "package.json": JSON.stringify({ dependencies: { next: "^16.0.0" }, scripts: { start: "next start" } }),
      "next.config.ts": "export default { output: 'export' };\n",
      "lib/storage.ts": "console.warn(\"localStorage unavailable\");\n",
    });

    await run([repo]);

    expect(mockGh.createIssue).not.toHaveBeenCalled();
  });

  it("skips a Vite site whose Dockerfile ends on nginx-unprivileged (whyrr)", async () => {
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

    expect(mockGh.createIssue).not.toHaveBeenCalled();
  });

  it("skips a CRA static SPA with react-scripts and no Dockerfile", async () => {
    mockTree({
      "package.json": JSON.stringify({
        dependencies: { react: "^18.2.0", "react-scripts": "^5.0.1" },
        scripts: { start: "react-scripts start", build: "react-scripts build" },
      }),
      "src/serviceWorkerRegistration.js": "console.log('registered');\n",
    });

    await run([repo]);

    expect(mockGh.createIssue).not.toHaveBeenCalled();
  });

  it("files an issue for a Next.js app without output: 'export'", async () => {
    mockTree({
      "package.json": JSON.stringify({ dependencies: { next: "^16.0.0" }, scripts: { start: "next start" } }),
      "next.config.ts": "export default { output: 'standalone' };\n",
      "lib/storage.ts": "console.warn(\"localStorage unavailable\");\n",
    });

    await run([repo]);

    expect(mockGh.createIssue).toHaveBeenCalledTimes(1);
  });

  it("files an issue for a Next.js static export with a root Dockerfile", async () => {
    mockTree({
      "package.json": JSON.stringify({ dependencies: { next: "^16.0.0" }, scripts: { start: "next start" } }),
      "next.config.ts": "export default { output: 'export' };\n",
      Dockerfile: "FROM node:22",
    });

    await run([repo]);

    expect(mockGh.createIssue).toHaveBeenCalledTimes(1);
  });

  it("skips when the final stage is reached via an alias chain to nginx", async () => {
    mockTree({
      Dockerfile: "FROM nginx:alpine AS web\nCOPY dist /usr/share/nginx/html\n\nFROM web\n",
      "package.json": JSON.stringify({ devDependencies: { vite: "^5.0.0" } }),
    });

    await run([repo]);

    expect(mockGh.createIssue).not.toHaveBeenCalled();
  });

  it("skips a static site behind caddy", async () => {
    mockTree({
      Dockerfile: "FROM caddy:2-alpine\nCOPY dist /srv\n",
      "package.json": JSON.stringify({ devDependencies: { vite: "^5.0.0" } }),
    });

    await run([repo]);

    expect(mockGh.createIssue).not.toHaveBeenCalled();
  });

  it("skips a static site behind httpd with a digest-pinned image", async () => {
    mockTree({
      Dockerfile: "FROM docker.io/library/httpd@sha256:deadbeef\nCOPY dist /usr/local/apache2/htdocs\n",
      "package.json": JSON.stringify({ devDependencies: { vite: "^5.0.0" } }),
    });

    await run([repo]);

    expect(mockGh.createIssue).not.toHaveBeenCalled();
  });

  it("files an issue when the final stage is nginx but package.json has a server dep", async () => {
    mockTree({
      Dockerfile: "FROM nginx:alpine\nCOPY dist /usr/share/nginx/html\n",
      "package.json": JSON.stringify({ dependencies: { express: "^4.0.0" } }),
    });

    await run([repo]);

    expect(mockGh.createIssue).toHaveBeenCalledTimes(1);
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

    expect(mockGh.createIssue).toHaveBeenCalledTimes(1);
  });

  it("files an issue when the final stage is nginx but package.json has a start script", async () => {
    mockTree({
      Dockerfile: "FROM nginx:alpine\nCOPY dist /usr/share/nginx/html\n",
      "package.json": JSON.stringify({ scripts: { start: "node server.js" } }),
    });

    await run([repo]);

    expect(mockGh.createIssue).toHaveBeenCalledTimes(1);
  });

  it("files an issue when an alias chain resolves to a node image", async () => {
    mockTree({
      Dockerfile: "FROM node:26-alpine AS base\nFROM base AS runner\nCMD [\"node\", \"index.js\"]\n",
    });

    await run([repo]);

    expect(mockGh.createIssue).toHaveBeenCalledTimes(1);
  });

  it("files an issue when the Dockerfile has no FROM lines at all", async () => {
    mockTree({
      Dockerfile: "# no base image\nCMD [\"true\"]\n",
    });

    await run([repo]);

    expect(mockGh.createIssue).toHaveBeenCalledTimes(1);
  });

  it("files an issue for a react-scripts repo that also depends on a server framework", async () => {
    mockTree({
      "package.json": JSON.stringify({
        dependencies: { react: "^18.2.0", "react-scripts": "^5.0.1", express: "^4.0.0" },
        scripts: { start: "node server.js", build: "react-scripts build" },
      }),
    });

    await run([repo]);

    expect(mockGh.createIssue).toHaveBeenCalledTimes(1);
  });

  it("skips a repo with no package.json and no Dockerfile", async () => {
    mockTree({
      "main.go": "package main",
      "README.md": "# Repo",
    });

    await run([repo]);

    expect(mockGh.createIssue).not.toHaveBeenCalled();
  });

  it("skips claws itself, whose own conversion is tracked separately", async () => {
    const self = mockRepo({ owner: "St-John-Software", name: "claws", fullName: "St-John-Software/claws" });
    mockClaude.repoDir.mockReturnValueOnce(REPO_DIR);
    mockTree({
      "package.json": JSON.stringify({ dependencies: { express: "^4.0.0" } }),
    });

    await run([self]);

    expect(mockGh.createIssue).not.toHaveBeenCalled();
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
  });
});
