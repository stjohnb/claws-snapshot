import crypto from "node:crypto";
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { K8sClient, K8sError, K8sObject, K8sResource, K8sResult } from "./k8s/api.js";
import type { WorkQueueRow } from "./db.js";

const { rows, jobRuns, tasks, calls, mockDb, shutdownState, mockReportError } = vi.hoisted(() => {
  const rows = new Map<number, Record<string, unknown>>();
  const jobRuns = new Map<string, string>();
  const tasks: Array<{ id: number; run_id: string; status: string; error?: string; outcome?: unknown }> = [];
  const calls: string[] = [];
  const update = (id: number, patch: Record<string, unknown>) => {
    const r = rows.get(id);
    if (r) rows.set(id, { ...r, ...patch });
  };
  const mockDb = {
    STALE_RUNNING_WORK_MS: 6 * 60 * 60 * 1000,
    getWorkRow: async (id: number) => rows.get(id),
    setWorkAgentMcpToken: async (id: number, hash: string) => {
      calls.push("setWorkAgentMcpToken");
      update(id, { agent_mcp_token_sha256: hash });
    },
    setWorkAgentPod: async (id: number, pod: string) => {
      calls.push(`setWorkAgentPod ${pod}`);
      update(id, { agent_pod: pod });
    },
    markWorkFailed: async (id: number, error: string) => update(id, { status: "failed", error_message: error }),
    markWorkFailedIfRunning: async (id: number, runId: string, error: string) => {
      const r = rows.get(id);
      if (r?.status !== "running" || r.run_id !== runId) return false;
      update(id, { status: "failed", error_message: error });
      return true;
    },
    markWorkCancelledIfRunning: async (id: number, runId: string, reason: string) => {
      const r = rows.get(id);
      if (r?.status !== "running" || r.run_id !== runId) return false;
      update(id, { status: "cancelled", error_message: reason });
      return true;
    },
    completeJobRun: async (runId: string, status: string) => {
      if (jobRuns.get(runId) !== "cancelled") jobRuns.set(runId, status);
    },
    cancelJobRunIfRunning: async (runId: string) => {
      if (jobRuns.get(runId) !== "running") return false;
      jobRuns.set(runId, "cancelled");
      return true;
    },
    getJobRun: async (runId: string) => (jobRuns.has(runId) ? { run_id: runId, status: jobRuns.get(runId) } : undefined),
    getTasksByRunId: async (runId: string) => tasks.filter((t) => t.run_id === runId),
    recordTaskFailed: async (id: number, error: string, outcome: unknown) => {
      const t = tasks.find((x) => x.id === id);
      if (t) Object.assign(t, { status: "failed", error, outcome });
    },
  };
  return { rows, jobRuns, tasks, calls, mockDb, shutdownState: { shuttingDown: false }, mockReportError: vi.fn() };
});

vi.mock("./db.js", () => mockDb);
vi.mock("./log.js", () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }));
vi.mock("./config.js", () => ({ AGENT_POD_SETTINGS: {}, SESSION_POD_SETTINGS: {}, CONFIG_PATH: "/svc/.claws/config.json" }));
vi.mock("./shutdown.js", () => ({ isShuttingDown: () => shutdownState.shuttingDown }));
vi.mock("./error-reporter.js", () => ({ reportError: mockReportError }));

import * as log from "./log.js";
import {
  AGENT_POD_LOST_TIMEOUT_MS,
  AGENT_POD_START_TIMEOUT_MS,
  TERMINAL_POD_EXIT_WAIT_MS,
  buildAgentPod,
  buildAgentPodLaunch,
  createAgentPodLauncher,
  isDeniedAgentEnvVar,
  type AgentPodLaunchDeps,
  type AgentPodLauncherSettings,
} from "./agent-pod-launcher.js";
import { agentPodWatchdogCapBytes } from "./agent-memory-budget.js";
import { WORKLOAD_LAUNCH_GRACE_MS } from "./k8s/workload.js";

const MEMORY_ENV_NAMES = [
  "CLAWS_AGENT_WORKER_MEMORY_MAX_BYTES",
  "CLAWS_CLAUDE_WORKER_MEMORY_MAX_BYTES",
  "CLAWS_AGENT_WORKER_MEMORY_HEADROOM_BYTES",
  "CLAWS_AGENT_WORKER_MEMORY_SHARED_BUDGET_BYTES",
] as const;

const NS = "claws-sessions";
const SETTINGS: AgentPodLauncherSettings = {
  namespace: NS,
  image: "ghcr.io/st-john-software/claws:1.2.3",
  imagePullSecrets: ["ghcr-pull"],
  nodeSelector: {},
  priorityClassName: "",
  resources: { cpuRequest: "500m", memoryRequest: "2Gi", memoryLimit: "6Gi", ephemeralStorageLimit: "24Gi", homeSize: "20Gi" },
};

function sha256(s: string): string {
  return crypto.createHash("sha256").update(s).digest("hex");
}

function launchDeps(overrides: Partial<AgentPodLaunchDeps> = {}, extraFiles: Record<string, string> = {}): AgentPodLaunchDeps {
  const files: Record<string, string> = {
    ...extraFiles,
    "/svc/.ssh/id_ed25519": "SSH KEY\n",
    "/svc/.kube/config": "kubeconfig: yes\n",
    "/keys/app.pem": "APP KEY",
    "/keys/other.pem": "OTHER KEY",
    "/svc/.claws/config.json": JSON.stringify({
      githubAppPrivateKeyPath: "/keys/app.pem",
      githubOwnerAppCredentials: { acme: { appId: 2, privateKeyPath: "/keys/other.pem" }, same: { appId: 3, privateKeyPath: "/keys/app.pem" } },
      repos: ["a/b"],
    }),
  };
  return {
    readFile: (p) => files[p] ?? null,
    homeDir: "/svc",
    env: {
      PATH: "/bin",
      HOME: "/svc",
      PWD: "/svc/app",
      OLDPWD: "/svc",
      SHLVL: "1",
      _: "/usr/bin/node",
      TERM: "xterm",
      HOSTNAME: "claws-0",
      KUBERNETES_SERVICE_HOST: "10.0.0.1",
      CLAWS_OIDC_CLIENT_SECRET: "oidc",
      CLAWS_AUTH_SECRET_NAME: "x",
      CLAWS_SESSION_BACKEND: "k8s-pod",
      CLAWS_WORK_BACKEND: "k8s-pod",
      CLAWS_MAX_WORK_WORKERS: "4",
      CLAWS_DATABASE_URL: "postgres://db/claws",
      CLAWS_DATABASE_PASSWORD: "db-secret",
      CLAUDE_CODE_OAUTH_TOKEN: "oauth",
      CLAWS_GITHUB_APP_PRIVATE_KEY_PATH: "/keys/app.pem",
      "NOT-AN-IDENT": "x",
    },
    configPath: "/svc/.claws/config.json",
    podMemoryLimit: "6Gi",
    newToken: () => "run-token",
    ...overrides,
  };
}

function workRow(id: number, patch: Partial<WorkQueueRow> = {}): WorkQueueRow {
  return {
    id, kind: "pr-reviewer", repo: "St-John-Software/claws", item_number: 42, args_json: "{}", priority: 0,
    status: "running", pid: 1, attempts: 1, error_message: null, enqueued_at: "2026-09-23 10:00:00",
    started_at: "2026-09-23 10:00:00", completed_at: null, run_id: `run-${id}`, agent_pod: null, agent_mcp_token_sha256: null,
    ...patch,
  };
}

function err(kind: K8sError["kind"], message: string = kind): K8sError {
  return { ok: false, kind, applied: "no", message };
}

/** In-memory namespaced API with injectable failures. */
function fakeClient() {
  const store: Record<"pods" | "secrets", Map<string, K8sObject>> = { pods: new Map(), secrets: new Map() };
  const failCreate = new Set<string>();
  let getError: K8sError | null = null;
  const client: K8sClient = {
    async create<T extends K8sObject>(resource: K8sResource, _ns: string, obj: K8sObject): Promise<K8sResult<T>> {
      calls.push(`create ${resource}`);
      if (failCreate.has(resource)) return err("forbidden", `POST ${resource}: HTTP 403`);
      if (store[resource as "pods" | "secrets"].has(obj.metadata!.name!)) return err("conflict", `POST ${resource}: HTTP 409`);
      store[resource as "pods" | "secrets"].set(obj.metadata!.name!, obj);
      return { ok: true, value: obj as T };
    },
    async get<T extends K8sObject>(resource: K8sResource, _ns: string, name: string): Promise<K8sResult<T>> {
      if (getError) return getError;
      const obj = store[resource as "pods" | "secrets"].get(name);
      return obj ? { ok: true, value: obj as T } : err("not-found");
    },
    async list<T extends K8sObject>(resource: K8sResource): Promise<K8sResult<T[]>> {
      return { ok: true, value: [...store[resource as "pods" | "secrets"].values()] as T[] };
    },
    async delete(resource: K8sResource, _ns: string, name: string): Promise<K8sResult<void>> {
      calls.push(`delete ${resource} ${name}`);
      const existed = store[resource as "pods" | "secrets"].delete(name);
      return existed ? { ok: true, value: undefined } : err("not-found");
    },
    async patch() { return err("http-error"); },
    async selfSubjectAccessReview() { return { ok: true, value: { allowed: true } }; },
  };
  return {
    client,
    store,
    failCreate,
    setGetError: (e: K8sError | null) => { getError = e; },
    setPodStatus: (name: string, status: Record<string, unknown>) => {
      const pod = store.pods.get(name);
      if (pod) pod.status = status;
    },
  };
}

/**
 * A launcher on a fake clock. `onTick(n)` runs at each poll's sleep; the loop
 * is stopped by shutdown after `maxTicks` so a wrong branch cannot hang a test.
 */
function setup(onTick: (n: number, now: number) => void | Promise<void> = () => {}, maxTicks = 50, depOverrides: Partial<AgentPodLaunchDeps> = {}) {
  const k8s = fakeClient();
  let clock = Date.parse("2026-09-23T10:00:00Z");
  let ticks = 0;
  const launcher = createAgentPodLauncher({
    client: k8s.client,
    settings: SETTINGS,
    pollMs: 15_000,
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
      ticks++;
      if (ticks > maxTicks) shutdownState.shuttingDown = true;
      await onTick(ticks, clock);
    },
    launchDeps: launchDeps(depOverrides),
  });
  return { k8s, launcher, advance: (ms: number) => { clock += ms; }, now: () => clock };
}

function seedRow(id: number, patch: Partial<WorkQueueRow> = {}): WorkQueueRow {
  const row = workRow(id, patch);
  rows.set(id, row as unknown as Record<string, unknown>);
  jobRuns.set(row.run_id!, "running");
  return row;
}

/** Run `fn`, returning the fake-clock time at which the launcher failed the row. */
async function failureTime(now: () => number, fn: () => Promise<void>): Promise<number | null> {
  const markFailed = mockDb.markWorkFailedIfRunning;
  let at: number | null = null;
  mockDb.markWorkFailedIfRunning = async (id, runId, error) => {
    at ??= now();
    return markFailed(id, runId, error);
  };
  try {
    await fn();
  } finally {
    mockDb.markWorkFailedIfRunning = markFailed;
  }
  return at;
}

beforeEach(() => {
  rows.clear();
  jobRuns.clear();
  tasks.length = 0;
  calls.length = 0;
  shutdownState.shuttingDown = false;
  mockReportError.mockReset();
  vi.mocked(log.warn).mockClear();
  vi.mocked(log.info).mockClear();
});

describe("buildAgentPodLaunch", () => {
  it("copies the service env minus the deny-list and forces the in-process backend", () => {
    const { secretData } = buildAgentPodLaunch(workRow(7), "run-7", launchDeps());
    const env = secretData["agent.env"]!;
    expect(env).toContain("export CLAUDE_CODE_OAUTH_TOKEN='oauth'");
    expect(env).toContain("export CLAWS_WORK_BACKEND='in-process'");
    for (const denied of ["export PATH=", "export HOME=", "export PWD=", "export OLDPWD=", "export SHLVL=", "export _=", "export TERM=", "export HOSTNAME=", "KUBERNETES_SERVICE_HOST", "CLAWS_OIDC_", "CLAWS_AUTH_SECRET_", "CLAWS_SESSION_BACKEND", "CLAWS_MAX_WORK_WORKERS", "NOT-AN-IDENT", "CLAWS_WORK_BACKEND='k8s-pod'", "CLAWS_DATABASE_URL", "CLAWS_DATABASE_PASSWORD", "db-secret"]) {
      expect(env).not.toContain(denied);
    }
  });

  it("re-reads the file-backed secrets the entrypoint unset", () => {
    const env = buildAgentPodLaunch(workRow(7), "run-7", launchDeps()).secretData["agent.env"]!;
    expect(env).toContain("export CLAWS_SSH_PRIVATE_KEY='SSH KEY'");
    expect(env).toContain("export CLAWS_KUBECONFIG='kubeconfig: yes'");
    expect(env).not.toContain("CLAWS_PROD_KUBECONFIG");
  });

  it("re-reads every file-backed secret that is present", () => {
    const deps = launchDeps({}, {
      "/svc/.kube/prod-config": "prod: yes\n",
      "/svc/.codex/auth.json": "{\"codex\":1}\n",
      "/svc/.claude/settings.json": "{\"claude\":1}\n",
    });
    const env = buildAgentPodLaunch(workRow(7), "run-7", deps).secretData["agent.env"]!;
    expect(env).toContain("export CLAWS_PROD_KUBECONFIG='prod: yes'");
    expect(env).toContain(`export CLAWS_CODEX_AUTH_JSON='{"codex":1}'`);
    expect(env).toContain(`export CLAWS_CLAUDE_SETTINGS_JSON='{"claude":1}'`);
  });

  it("ships GitHub App keys as Secret keys and points env and config.json at the mounted copies", () => {
    const { secretData, spec } = buildAgentPodLaunch(workRow(7), "run-7", launchDeps());
    expect(secretData["github-app-1.pem"]).toBe("APP KEY");
    expect(secretData["github-app-2.pem"]).toBe("OTHER KEY");
    expect(secretData["github-app-3.pem"]).toBeUndefined();
    expect(secretData["agent.env"]).toContain("export CLAWS_GITHUB_APP_PRIVATE_KEY_PATH='/etc/claws-workload/github-app-1.pem'");
    const config = JSON.parse(spec.files.find((f) => f.path === ".claws/config.json")!.content);
    expect(config.githubAppPrivateKeyPath).toBe("/etc/claws-workload/github-app-1.pem");
    expect(config.githubOwnerAppCredentials.acme.privateKeyPath).toBe("/etc/claws-workload/github-app-2.pem");
    expect(config.githubOwnerAppCredentials.same.privateKeyPath).toBe("/etc/claws-workload/github-app-1.pem");
    expect(config.repos).toEqual(["a/b"]);
  });

  it("leaves an unreadable GitHub App key at its service-side path and warns", () => {
    const base = launchDeps();
    const deps = { ...base, readFile: (p: string) => (p === "/keys/other.pem" ? null : base.readFile(p)) };
    const { secretData, spec } = buildAgentPodLaunch(workRow(7), "run-7", deps);
    const config = JSON.parse(spec.files.find((f) => f.path === ".claws/config.json")!.content);
    expect(config.githubOwnerAppCredentials.acme.privateKeyPath).toBe("/keys/other.pem");
    expect(config.githubAppPrivateKeyPath).toBe("/etc/claws-workload/github-app-1.pem");
    expect(secretData["github-app-2.pem"]).toBeUndefined();
    expect(vi.mocked(log.warn)).toHaveBeenCalledWith(expect.stringContaining("/keys/other.pem is unreadable"));
  });

  it("ships a config.json that is not valid JSON unchanged", () => {
    const deps = launchDeps({}, { "/svc/.claws/config.json": "{not json" });
    const { spec } = buildAgentPodLaunch(workRow(7), "run-7", { ...deps, readFile: (p) => (p === "/svc/.claws/config.json" ? "{not json" : deps.readFile(p)) });
    expect(spec.files.find((f) => f.path === ".claws/config.json")!.content).toBe("{not json");
    expect(vi.mocked(log.warn)).toHaveBeenCalledWith(expect.stringContaining("is not valid JSON"));
  });

  it("generates a per-run MCP token for the Secret and HOME, and returns only its hash", () => {
    const { secretData, spec, mcpTokenSha256 } = buildAgentPodLaunch(workRow(7), "run-7", launchDeps());
    expect(secretData["mcp-token"]).toBe("run-token");
    expect(spec.files).toContainEqual({ path: ".claws/internal-mcp-token", content: "run-token" });
    expect(mcpTokenSha256).toBe(sha256("run-token"));
    expect(JSON.parse(secretData["launch.json"]!)).toEqual({ rowId: 7, runId: "run-7", files: spec.files });
  });

  it("does not inherit the service's memory-tuning env vars and derives its own cap from the pod's own limit", () => {
    const deps = launchDeps({
      podMemoryLimit: "6Gi",
      env: {
        ...launchDeps().env,
        CLAWS_AGENT_WORKER_MEMORY_MAX_BYTES: "4294967296",
        CLAWS_CLAUDE_WORKER_MEMORY_MAX_BYTES: "4294967296",
        CLAWS_AGENT_WORKER_MEMORY_HEADROOM_BYTES: "1342177280",
        CLAWS_AGENT_WORKER_MEMORY_SHARED_BUDGET_BYTES: "8000000000",
      },
    });
    const env = buildAgentPodLaunch(workRow(7), "run-7", deps).secretData["agent.env"]!;
    expect(env).toContain("export CLAWS_AGENT_WORKER_MEMORY_MAX_BYTES='4294967296'");
    for (const denied of ["CLAWS_CLAUDE_WORKER_MEMORY_MAX_BYTES", "CLAWS_AGENT_WORKER_MEMORY_HEADROOM_BYTES", "CLAWS_AGENT_WORKER_MEMORY_SHARED_BUDGET_BYTES"]) {
      expect(env).not.toContain(denied);
    }
  });

  it("falls back to the 2 GiB floor and warns when the pod memory limit is unparseable", () => {
    const deps = launchDeps({ podMemoryLimit: "bogus" });
    const env = buildAgentPodLaunch(workRow(7), "run-7", deps).secretData["agent.env"]!;
    expect(env).toContain(`export CLAWS_AGENT_WORKER_MEMORY_MAX_BYTES='${agentPodWatchdogCapBytes(null)}'`);
    expect(vi.mocked(log.warn)).toHaveBeenCalledWith(expect.stringContaining("bogus"));
  });

  it("strips the memory-tuning keys from a shipped config.json while keeping every other key", () => {
    const base = launchDeps();
    const rawConfig = JSON.stringify({
      repos: ["a/b"],
      agentWorkerMemoryMaxBytes: 4294967296,
      claudeWorkerMemoryMaxBytes: 4294967296,
      agentWorkerMemoryHeadroomBytes: 1342177280,
      agentWorkerMemorySharedBudgetBytes: 8000000000,
    });
    const deps = { ...base, readFile: (p: string) => (p === "/svc/.claws/config.json" ? rawConfig : base.readFile(p)) };
    const { spec } = buildAgentPodLaunch(workRow(7), "run-7", deps);
    const config = JSON.parse(spec.files.find((f) => f.path === ".claws/config.json")!.content);
    expect(config).toEqual({ repos: ["a/b"] });
  });
});

describe("isDeniedAgentEnvVar", () => {
  it("denies the four service memory-tuning env vars", () => {
    for (const name of MEMORY_ENV_NAMES) {
      expect(isDeniedAgentEnvVar(name)).toBe(true);
    }
  });
});

describe("buildAgentPod", () => {
  it("runs the entrypoint after sourcing agent.env, on an emptyDir HOME with no ports or init container", () => {
    const pod = buildAgentPod(7, ["agent.env", "launch.json", "mcp-token"], SETTINGS) as { metadata: { name: string }; spec: Record<string, any> };
    expect(pod.metadata.name).toBe("claws-agent-7");
    const c = pod.spec.containers[0];
    expect(c.args).toEqual(["/bin/sh", "-c", ". /etc/claws-workload/agent.env && exec /opt/claws/deploy/container-entrypoint.sh"]);
    expect(c.env).toContainEqual({ name: "CLAWS_AGENT_POD_ROW", value: "7" });
    expect(c.ports).toBeUndefined();
    expect(c.resources).toEqual({ requests: { cpu: "500m", memory: "2Gi" }, limits: { memory: "6Gi", "ephemeral-storage": "24Gi" } });
    expect(pod.spec.initContainers).toBeUndefined();
    expect(pod.spec.volumes[0]).toEqual({ name: "home", emptyDir: { sizeLimit: "20Gi" } });
    expect(pod.spec.imagePullSecrets).toEqual([{ name: "ghcr-pull" }]);
  });
});

describe("runRowInPod", () => {
  it("records the token hash before creating the Secret, and the pod only once it exists", async () => {
    const row = seedRow(7);
    const { launcher } = setup(() => { shutdownState.shuttingDown = true; });
    await launcher.runRowInPod(0, row, { adopt: false });
    expect(calls.slice(0, 4)).toEqual(["setWorkAgentMcpToken", "create secrets", "create pods", "setWorkAgentPod claws-agent-7"]);
    expect(rows.get(7)).toMatchObject({ agent_pod: "claws-agent-7", agent_mcp_token_sha256: sha256("run-token") });
  });

  it("fails the row without creating a Pod when the Secret cannot be created", async () => {
    const row = seedRow(7);
    const { k8s, launcher } = setup();
    k8s.failCreate.add("secrets");
    await launcher.runRowInPod(0, row, { adopt: false });
    expect(calls).not.toContain("create pods");
    expect(rows.get(7)).toMatchObject({ status: "failed", error_message: "agent pod launch failed: POST secrets: HTTP 403", agent_pod: null });
    expect(jobRuns.get("run-7")).toBe("failed");
    expect(k8s.store.pods.size + k8s.store.secrets.size).toBe(0);
  });

  it("replaces a Secret left by a crashed launch of the same row", async () => {
    const row = seedRow(7);
    const { k8s, launcher } = setup(() => { shutdownState.shuttingDown = true; });
    k8s.store.secrets.set("claws-agent-7", { metadata: { name: "claws-agent-7" }, data: { stale: "yes" } } as K8sObject);
    await launcher.runRowInPod(0, row, { adopt: false });
    expect(calls.slice(0, 5)).toEqual(["setWorkAgentMcpToken", "create secrets", "delete secrets claws-agent-7", "create secrets", "create pods"]);
    expect((k8s.store.secrets.get("claws-agent-7") as { data?: Record<string, string> }).data).not.toHaveProperty("stale");
    expect(rows.get(7)!.status).toBe("running");
  });

  it("replaces a live Pod left by a launch that crashed before recording it", async () => {
    const row = seedRow(7);
    const { k8s, launcher } = setup(() => { shutdownState.shuttingDown = true; });
    k8s.store.secrets.set("claws-agent-7", { metadata: { name: "claws-agent-7" }, data: { stale: "yes" } } as K8sObject);
    k8s.store.pods.set("claws-agent-7", { metadata: { name: "claws-agent-7" }, status: { phase: "Running" }, stale: true } as K8sObject);
    await launcher.runRowInPod(0, row, { adopt: false });
    expect(calls).toContain("delete pods claws-agent-7");
    expect(calls.filter((c) => c === "create pods")).toHaveLength(2);
    expect(k8s.store.pods.get("claws-agent-7")).not.toHaveProperty("stale");
    expect(rows.get(7)).toMatchObject({ status: "running", agent_pod: "claws-agent-7" });
  });

  it("fails the launch when a leftover Pod is still terminating after the wait", async () => {
    const row = seedRow(7);
    const { k8s, launcher } = setup(() => {}, 200);
    k8s.store.pods.set("claws-agent-7", { metadata: { name: "claws-agent-7" } });
    const del = k8s.client.delete;
    // The API accepts the delete, but the pod never goes (a lost node's kubelet never confirms it).
    k8s.client.delete = async (resource, ns, name) => (resource === "pods" ? { ok: true, value: undefined } : del(resource, ns, name));
    await launcher.runRowInPod(0, row, { adopt: false });
    expect(rows.get(7)).toMatchObject({ status: "failed", error_message: "agent pod launch failed: POST pods: HTTP 409 (the leftover pods claws-agent-7 is still terminating)" });
    expect(jobRuns.get("run-7")).toBe("failed");
  });

  it("fails a row claimed without a run id", async () => {
    const row = seedRow(7, { run_id: null });
    const { k8s, launcher } = setup();
    await launcher.runRowInPod(0, row, { adopt: false });
    expect(rows.get(7)).toMatchObject({ status: "failed", error_message: "agent pod launch failed: row has no run id" });
    expect(calls).not.toContain("create secrets");
    expect(k8s.store.pods.size + k8s.store.secrets.size).toBe(0);
  });

  it("fails the row when the launch cannot be built", async () => {
    const row = seedRow(7);
    const { k8s, launcher } = setup(() => {}, 50, { newToken: () => { throw new Error("no entropy"); } });
    await launcher.runRowInPod(0, row, { adopt: false });
    expect(rows.get(7)).toMatchObject({ status: "failed", error_message: "agent pod launch failed: no entropy" });
    expect(jobRuns.get("run-7")).toBe("failed");
    expect(k8s.store.pods.size + k8s.store.secrets.size).toBe(0);
  });

  it("fails the row and removes both objects when the launch throws", async () => {
    const row = seedRow(7);
    const setPod = mockDb.setWorkAgentPod;
    mockDb.setWorkAgentPod = async () => { throw new Error("database down"); };
    try {
      const { k8s, launcher } = setup();
      await launcher.runRowInPod(0, row, { adopt: false });
      expect(rows.get(7)).toMatchObject({ status: "failed", error_message: "agent pod launch failed: database down" });
      expect(jobRuns.get("run-7")).toBe("failed");
      expect(k8s.store.pods.size + k8s.store.secrets.size).toBe(0);
    } finally {
      mockDb.setWorkAgentPod = setPod;
    }
  });

  it("rolls back and fails the row when the Pod cannot be created", async () => {
    const row = seedRow(7);
    const { k8s, launcher } = setup();
    k8s.failCreate.add("pods");
    await launcher.runRowInPod(0, row, { adopt: false });
    expect(k8s.store.secrets.size).toBe(0);
    expect(rows.get(7)).toMatchObject({ status: "failed", error_message: "agent pod launch failed: POST pods: HTTP 403" });
    expect(jobRuns.get("run-7")).toBe("failed");
  });

  it("cleans up and completes the job run once the pod finishes the row", async () => {
    const row = seedRow(7);
    const { k8s, launcher } = setup((n) => {
      if (n === 2) {
        rows.set(7, { ...rows.get(7)!, status: "completed" });
        k8s.setPodStatus("claws-agent-7", { phase: "Succeeded" });
      }
    });
    await launcher.runRowInPod(0, row, { adopt: false });
    expect(k8s.store.pods.size).toBe(0);
    expect(k8s.store.secrets.size).toBe(0);
    expect(jobRuns.get("run-7")).toBe("completed");
    expect(shutdownState.shuttingDown).toBe(false);
  });

  it("waits for a finished row's pod to exit before deleting it, up to the limit", async () => {
    const row = seedRow(7);
    let finishedAt = 0;
    let deletedAt: number | null = null;
    const env = setup((n, now) => {
      if (n === 1) {
        env.k8s.setPodStatus("claws-agent-7", { phase: "Running" });
        rows.set(7, { ...rows.get(7)!, status: "failed" });
        finishedAt = now;
      }
    }, 100);
    const del = env.k8s.client.delete;
    env.k8s.client.delete = async (resource, ns, name) => {
      if (resource === "pods") deletedAt ??= env.now();
      return del(resource, ns, name);
    };
    await env.launcher.runRowInPod(0, row, { adopt: false });
    expect(env.k8s.store.pods.size + env.k8s.store.secrets.size).toBe(0);
    expect(jobRuns.get("run-7")).toBe("failed");
    expect(deletedAt! - finishedAt).toBeGreaterThanOrEqual(TERMINAL_POD_EXIT_WAIT_MS);
    expect(deletedAt! - finishedAt).toBeLessThan(TERMINAL_POD_EXIT_WAIT_MS + 30_000);
  });

  it("fails an OOMKilled pod's row, its running tasks and job run, and reports it", async () => {
    const row = seedRow(7);
    tasks.push({ id: 1, run_id: "run-7", status: "running" }, { id: 2, run_id: "run-7", status: "completed" });
    const { k8s, launcher } = setup((n) => {
      if (n === 1) k8s.setPodStatus("claws-agent-7", { phase: "Failed", containerStatuses: [{ state: { terminated: { exitCode: 137, reason: "OOMKilled" } } }] });
    });
    await launcher.runRowInPod(0, row, { adopt: false });
    expect(rows.get(7)).toMatchObject({ status: "failed", error_message: "agent pod failed: OOMKilled" });
    expect(tasks[0]).toMatchObject({ status: "failed", error: "agent pod failed: OOMKilled", outcome: { failureCategory: "external-kill" } });
    expect(tasks[1]!.status).toBe("completed");
    expect(jobRuns.get("run-7")).toBe("failed");
    expect(mockReportError).toHaveBeenCalledWith("agent-pod:run", "St-John-Software/claws#42", expect.any(Error), { repo: "St-John-Software/claws" });
    expect(k8s.store.pods.size + k8s.store.secrets.size).toBe(0);
  });

  it("deletes the pod on a dashboard cancel, then marks the row cancelled", async () => {
    const row = seedRow(7);
    const { k8s, launcher } = setup((n) => {
      if (n === 1) jobRuns.set("run-7", "cancelled");
    });
    await launcher.runRowInPod(0, row, { adopt: false });
    expect(rows.get(7)).toMatchObject({ status: "cancelled", error_message: "run cancelled" });
    expect(jobRuns.get("run-7")).toBe("cancelled");
    expect(k8s.store.pods.size + k8s.store.secrets.size).toBe(0);
  });

  it("cancelByRunId stops a watched pod and cancelAll counts watches", async () => {
    const row = seedRow(7);
    let launcherRef: ReturnType<typeof setup>["launcher"] | null = null;
    const env = setup((n) => {
      if (n === 1) {
        expect(launcherRef!.inFlight()).toEqual([{ workerId: 3, rowId: 7, runId: "run-7", podName: "claws-agent-7" }]);
        expect(launcherRef!.cancelByRunId("nope")).toBe(false);
        expect(launcherRef!.cancelByRunId("run-7")).toBe(true);
      }
    });
    launcherRef = env.launcher;
    await env.launcher.runRowInPod(3, row, { adopt: false });
    expect(rows.get(7)!.status).toBe("cancelled");
    expect(jobRuns.get("run-7")).toBe("cancelled");
    expect(env.launcher.inFlight()).toEqual([]);
    expect(await env.launcher.cancelAll()).toBe(0);
  });

  it("a cancelAll survives a restart before the next poll: the adopting boot cancels the row", async () => {
    const row = seedRow(7);
    const first = setup((n) => {
      if (n === 1) {
        return first.launcher.cancelAll().then((count) => {
          expect(count).toBe(1);
          shutdownState.shuttingDown = true; // Claws restarts before the watch sees the cancel
        });
      }
    });
    await first.launcher.runRowInPod(0, row, { adopt: false });
    expect(rows.get(7)!.status).toBe("running");
    expect(jobRuns.get("run-7")).toBe("cancelled");

    shutdownState.shuttingDown = false;
    const second = setup();
    second.k8s.store.secrets.set("claws-agent-7", first.k8s.store.secrets.get("claws-agent-7")!);
    await second.launcher.runRowInPod(0, rows.get(7) as unknown as WorkQueueRow, { adopt: true });
    expect(rows.get(7)).toMatchObject({ status: "cancelled", error_message: "run cancelled" });
    expect(jobRuns.get("run-7")).toBe("cancelled");
    expect(second.k8s.store.secrets.size).toBe(0);
  });

  it("returns on shutdown without touching the row, pod or Secret", async () => {
    const row = seedRow(7);
    const { k8s, launcher } = setup(() => { shutdownState.shuttingDown = true; });
    await launcher.runRowInPod(0, row, { adopt: false });
    expect(rows.get(7)!.status).toBe("running");
    expect(jobRuns.get("run-7")).toBe("running");
    expect(k8s.store.pods.size).toBe(1);
    expect(k8s.store.secrets.size).toBe(1);
  });

  it("fails, not re-runs, an adopted row whose pod is gone — it existed, since agent_pod was set after creating it", async () => {
    const row = seedRow(7, { agent_pod: "claws-agent-7", agent_mcp_token_sha256: "hash" });
    tasks.push({ id: 1, run_id: "run-7", status: "running" });
    const { launcher } = setup();
    await launcher.runRowInPod(0, row, { adopt: true });
    expect(calls).not.toContain("create pods");
    expect(rows.get(7)).toMatchObject({ status: "failed", error_message: "agent pod not found" });
    expect(tasks[0]!.status).toBe("failed");
    expect(jobRuns.get("run-7")).toBe("failed");
  });

  it("fails a launched row whose pod disappeared, but only after the grace", async () => {
    const row = seedRow(7);
    let clearedAt = 0;
    const env = setup((n, now) => {
      if (n === 1) {
        env.k8s.store.pods.clear();
        clearedAt = now;
      }
    }, 100);
    const { k8s, launcher } = env;
    const failedAt = await failureTime(env.now, () => launcher.runRowInPod(0, row, { adopt: false }));
    expect(rows.get(7)).toMatchObject({ status: "failed", error_message: "agent pod not found" });
    expect(k8s.store.secrets.size).toBe(0);
    // The grace runs from the launch, which was one poll before the pod was cleared.
    expect(failedAt! - clearedAt).toBeGreaterThanOrEqual(WORKLOAD_LAUNCH_GRACE_MS - 15_000);
  });

  it("fails a row whose pod never leaves Pending, and deletes the pod", async () => {
    const row = seedRow(7);
    let pendingAt = 0;
    const env = setup((n, now) => {
      if (n === 1) {
        env.k8s.setPodStatus("claws-agent-7", { phase: "Pending", containerStatuses: [{ state: { waiting: { reason: "ImagePullBackOff" } } }] });
        pendingAt = now;
      }
    }, 200);
    const { k8s, launcher } = env;
    const failedAt = await failureTime(env.now, () => launcher.runRowInPod(0, row, { adopt: false }));
    expect(rows.get(7)).toMatchObject({ status: "failed", error_message: "agent pod never started: ImagePullBackOff" });
    expect(failedAt! - pendingAt).toBeGreaterThan(AGENT_POD_START_TIMEOUT_MS);
    expect(jobRuns.get("run-7")).toBe("failed");
    expect(k8s.store.pods.size + k8s.store.secrets.size).toBe(0);
  });

  it("leaves a job run the pod already completed as it is", async () => {
    const row = seedRow(7);
    const { k8s, launcher } = setup((n) => {
      if (n === 1) {
        // The pod finished the row and its job run; the row was then claimed again under another run.
        rows.set(7, { ...rows.get(7)!, status: "running", run_id: "run-next" });
        jobRuns.set("run-7", "completed");
        k8s.setPodStatus("claws-agent-7", { phase: "Succeeded" });
      }
    });
    await launcher.runRowInPod(0, row, { adopt: false });
    expect(jobRuns.get("run-7")).toBe("completed");
    expect(rows.get(7)!.status).toBe("running");
  });

  it("never finalises on an API error", async () => {
    const row = seedRow(7);
    const { k8s, launcher } = setup((n) => {
      if (n === 1) k8s.setGetError(err("unreachable", "GET pods: ETIMEDOUT"));
    }, 30);
    await launcher.runRowInPod(0, row, { adopt: false });
    expect(rows.get(7)!.status).toBe("running");
    expect(jobRuns.get("run-7")).toBe("running");
    // Logged once per state change, not once per poll.
    expect(vi.mocked(log.warn).mock.calls.filter(([m]) => String(m).includes("ETIMEDOUT"))).toHaveLength(1);
  });

  it("stops a pod that outlives the stale-work ceiling", async () => {
    const row = seedRow(7);
    const { k8s, launcher, advance } = setup((n) => {
      if (n === 1) {
        k8s.setPodStatus("claws-agent-7", { phase: "Running" });
        advance(mockDb.STALE_RUNNING_WORK_MS);
      }
    });
    await launcher.runRowInPod(0, row, { adopt: false });
    expect(rows.get(7)).toMatchObject({ status: "failed", error_message: "agent pod exceeded 6h ceiling" });
    expect(k8s.store.pods.size + k8s.store.secrets.size).toBe(0);
  });

  it("measures an adopted row's ceiling from when it started, not from the adopting boot", async () => {
    const row = seedRow(7, { agent_pod: "claws-agent-7", started_at: "2026-09-23 03:59:00" });
    const { k8s, launcher, now } = setup();
    k8s.store.pods.set("claws-agent-7", { metadata: { name: "claws-agent-7" }, status: { phase: "Running" } });
    const adoptedAt = now();
    const failedAt = await failureTime(now, () => launcher.runRowInPod(0, row, { adopt: true }));
    // Six hours after started_at, on the first poll: the ceiling did not restart with the boot.
    expect(failedAt).toBe(adoptedAt);
    expect(rows.get(7)).toMatchObject({ status: "failed", error_message: "agent pod exceeded 6h ceiling" });
    expect(k8s.store.pods.size + k8s.store.secrets.size).toBe(0);
  });

  it("fails a row whose pod stays in phase Unknown, and deletes the pod", async () => {
    const row = seedRow(7);
    let unknownAt = 0;
    const env = setup((n, now) => {
      if (n === 1) {
        env.k8s.setPodStatus("claws-agent-7", { phase: "Unknown" });
        unknownAt = now;
      }
    }, 200);
    const failedAt = await failureTime(env.now, () => env.launcher.runRowInPod(0, row, { adopt: false }));
    expect(rows.get(7)).toMatchObject({ status: "failed", error_message: "agent pod lost: phase Unknown" });
    expect(failedAt! - unknownAt).toBeGreaterThan(AGENT_POD_LOST_TIMEOUT_MS);
    expect(env.k8s.store.pods.size + env.k8s.store.secrets.size).toBe(0);
  });

  it("fails a row whose pod is stuck terminating on a deletion the launcher did not make", async () => {
    const row = seedRow(7);
    const env = setup((n) => {
      if (n === 1) {
        const pod = env.k8s.store.pods.get("claws-agent-7")!;
        pod.metadata = { ...pod.metadata, deletionTimestamp: "2026-09-23T10:00:15Z" };
        pod.status = { phase: "Running" };
      }
    }, 200);
    await env.launcher.runRowInPod(0, row, { adopt: false });
    expect(rows.get(7)).toMatchObject({ status: "failed", error_message: "agent pod lost: stuck terminating" });
  });

  it("frees the worker once a finished row's objects keep failing to delete", async () => {
    const row = seedRow(7);
    const { k8s, launcher } = setup((n) => {
      if (n === 1) {
        rows.set(7, { ...rows.get(7)!, status: "completed" });
        k8s.setPodStatus("claws-agent-7", { phase: "Succeeded" });
      }
    }, 100);
    k8s.client.delete = async () => err("forbidden", "DELETE: HTTP 403");
    await launcher.runRowInPod(0, row, { adopt: false });
    expect(shutdownState.shuttingDown).toBe(false);
    expect(vi.mocked(log.error)).toHaveBeenCalledWith(expect.stringContaining("kubectl -n claws-sessions delete pod,secret"));
  });

  it("does not overwrite a row the pod finished just before the stale-ceiling write", async () => {
    const row = seedRow(7);
    const markFailed = mockDb.markWorkFailedIfRunning;
    mockDb.markWorkFailedIfRunning = async (id, runId, error) => {
      // The pod's own finalisation lands between the launcher's row read and its write.
      rows.set(7, { ...rows.get(7)!, status: "completed" });
      return markFailed(id, runId, error);
    };
    try {
      const { k8s, launcher, advance } = setup((n) => {
        if (n === 1) {
          k8s.setPodStatus("claws-agent-7", { phase: "Running" });
          advance(mockDb.STALE_RUNNING_WORK_MS);
        }
      });
      await launcher.runRowInPod(0, row, { adopt: false });
    } finally {
      mockDb.markWorkFailedIfRunning = markFailed;
    }
    expect(rows.get(7)).toMatchObject({ status: "completed", error_message: null });
    expect(mockReportError).not.toHaveBeenCalled();
  });
});

describe("sweepOrphans", () => {
  it("deletes agent Pods and Secrets whose row is missing or not running", async () => {
    seedRow(1);
    seedRow(2, { status: "completed" });
    const { k8s, launcher } = setup();
    for (const id of ["1", "2", "3"]) {
      const obj = { metadata: { name: `claws-agent-${id}`, labels: { "claws-workload-id": id } } };
      k8s.store.pods.set(obj.metadata.name, obj);
      k8s.store.secrets.set(obj.metadata.name, obj);
    }
    await launcher.sweepOrphans();
    expect([...k8s.store.pods.keys()]).toEqual(["claws-agent-1"]);
    expect([...k8s.store.secrets.keys()]).toEqual(["claws-agent-1"]);
  });
});

describe("sweepOrphans without list on Secrets", () => {
  it("deletes an orphan pod's Secret with it and skips the forbidden Secret list", async () => {
    const { k8s, launcher } = setup();
    const list = k8s.client.list;
    k8s.client.list = async (resource, ns, selector) =>
      resource === "secrets" ? err("forbidden", "GET secrets: HTTP 403") : list(resource, ns, selector);
    const obj = { metadata: { name: "claws-agent-9", labels: { "claws-workload-id": "9" } } };
    k8s.store.pods.set(obj.metadata.name, obj);
    k8s.store.secrets.set(obj.metadata.name, obj);
    k8s.store.secrets.set("claws-agent-10", { metadata: { name: "claws-agent-10", labels: { "claws-workload-id": "10" } } });
    await launcher.sweepOrphans();
    await launcher.sweepOrphans();
    expect(k8s.store.pods.size).toBe(0);
    expect([...k8s.store.secrets.keys()]).toEqual(["claws-agent-10"]);
    expect(vi.mocked(log.warn)).not.toHaveBeenCalled();
    expect(vi.mocked(log.info).mock.calls.filter(([m]) => String(m).includes("cannot list Secrets"))).toHaveLength(1);
  });
});
