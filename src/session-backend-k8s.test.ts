import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { EventEmitter } from "node:events";
import { PassThrough, Readable } from "node:stream";
import { WebSocketServer, type WebSocket as WsSocket } from "ws";
import type { K8sRequest, K8sResponse } from "./k8s/api.js";
import type { PersistedSession } from "./db.js";

const { rows, mockDb, mockLog, mockListRepos } = vi.hoisted(() => {
  const rows = new Map<string, PersistedSession>();
  const mockDb = {
    insertSession: vi.fn(async (row: Record<string, unknown>) => {
      rows.set(row.id as string, { ended_at: null, resume_repos: null, summary_manual: 0, backend: null, ...row, launched_at: row.created_at } as PersistedSession);
    }),
    getPersistedSession: vi.fn(async (id: string) => rows.get(id)),
    getAllPersistedSessions: vi.fn(async () => [...rows.values()].filter((r) => r.ended_at === null)),
    getEndedSessions: vi.fn(async () => [...rows.values()].filter((r) => r.ended_at !== null)),
    markSessionEnded: vi.fn(async (id: string, endedAt: number, resumeRepos: string | null) => {
      const r = rows.get(id);
      if (r) rows.set(id, { ...r, ended_at: endedAt, resume_repos: resumeRepos });
    }),
    clearSessionEnded: vi.fn(async (id: string, launchedAt?: number) => {
      const r = rows.get(id);
      if (r) rows.set(id, { ...r, ended_at: null, ...(launchedAt === undefined ? {} : { launched_at: launchedAt }) });
    }),
    deletePersistedSession: vi.fn(async (id: string) => { rows.delete(id); }),
    deleteEndedPersistedSession: vi.fn(async (id: string) => rows.get(id)?.ended_at != null && rows.delete(id)),
    getPrunableEndedSessionIds: vi.fn(async () => [] as string[]),
    setManualSessionSummary: vi.fn(async () => true),
    updateSessionCapabilities: vi.fn(async (id: string, caps: string[]) => {
      const r = rows.get(id);
      if (r) rows.set(id, { ...r, capabilities: JSON.stringify(caps) });
    }),
  };
  return {
    rows,
    mockDb,
    mockLog: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    mockListRepos: vi.fn(),
  };
});

vi.mock("./db.js", () => mockDb);
vi.mock("./log.js", () => mockLog);
vi.mock("./github.js", () => ({ listRepos: mockListRepos }));
vi.mock("./github-app.js", () => ({ getInstallationTokenForOwner: vi.fn(), getAnyInstallationToken: vi.fn() }));
vi.mock("./config.js", () => ({
  SESSION_POD_SETTINGS: {},
  isForgejoRepo: () => false,
}));
vi.mock("./shutdown.js", () => ({ isShuttingDown: () => false }));
vi.mock("./capabilities.js", () => ({
  BROWSER_CAPABILITY_ID: "browser",
  CAPABILITIES: [{ id: "prod-infra", envKeys: ["KUBECONFIG"] }, { id: "home-assistant", envKeys: ["HOME_ASSISTANT_TOKEN"] }],
  GITHUB_AUTH_CAPABILITY_ID: "github-auth",
  withImplicitCapabilities: (caps: string[]) => [...new Set(caps)],
  liveGrantableCapabilities: (granted: string[]) =>
    ["prod-infra", "home-assistant"].filter((id) => !granted.includes(id)).map((id) => ({ id, label: id })),
}));
vi.mock("./sessions.js", () => ({
  isIdlePlaceholder: (s: string | null) => s !== null && /^Idle at /.test(s),
  isNumberOnlySummary: () => false,
  setSessionDescription: vi.fn(async (_id: string, d: string) => ({ ok: true, description: d || null })),
  isSessionAgentStatus: (v: unknown) => typeof v === "string" && ["working", "monitoring", "waiting", "done"].includes(v),
  setSessionAgentStatusForSession: vi.fn(async (_id: string, status: string) => ({ ok: true, status, updatedAt: 4242 })),
  summarizeSession: vi.fn(async () => {}),
}));
vi.mock("./session-pod-launch.js", () => ({ buildPodLaunch: vi.fn() }));

import { createK8sClient } from "./k8s/api.js";
import { setSessionAgentStatusForSession, summarizeSession } from "./sessions.js";
import { createK8sSessionBackend } from "./session-backend-k8s.js";
import type { PodLaunch, PodLaunchRequest } from "./session-pod-launch.js";
import type { SessionPodSettings } from "./config.js";

type Resource = "pods" | "services" | "secrets" | "persistentvolumeclaims";
type Obj = { metadata: { name: string; labels?: Record<string, string>; deletionTimestamp?: string }; [k: string]: unknown };

const NS = "claws-sessions";
const READY_STATUS = { phase: "Running", conditions: [{ type: "Ready", status: "True" }] };

/** In-memory Kubernetes API behind the real client, with injectable failures. */
function fakeCluster() {
  const store: Record<Resource, Map<string, Obj>> = {
    pods: new Map(), services: new Map(), secrets: new Map(), persistentvolumeclaims: new Map(),
  };
  const calls: string[] = [];
  let unreachable = false;
  const failures: Array<{ method: string; resource: Resource; status: number }> = [];
  const failAfterApplies: Array<{ method: string; resource: Resource }> = [];
  /** Creates whose answer is lost and whose write lands only after the next DELETE of that object has answered 404. */
  const lateWrites = new Map<Resource, Obj | null>();
  let podStatus: Record<string, unknown> = READY_STATUS;

  const transport = async (req: K8sRequest): Promise<K8sResponse> => {
    const url = new URL(req.path, "https://k8s.test");
    const m = /^\/api\/v1\/namespaces\/([^/]+)\/([a-z]+)(?:\/([^/]+))?$/.exec(url.pathname);
    // Objects exist only in the session namespace; a call anywhere else (e.g. `default`) finds nothing.
    if (!m || m[1] !== NS) return { status: 404, body: "{}" };
    const resource = m[2] as Resource;
    const name = m[3] ? decodeURIComponent(m[3]) : undefined;
    calls.push(`${req.method} ${resource}${name ? `/${name}` : ""}`);
    if (unreachable) throw Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
    const failure = failures.find((f) => f.method === req.method && f.resource === resource);
    if (failure) return { status: failure.status, body: "{}" };
    const map = store[resource];

    if (req.method === "POST") {
      const obj = JSON.parse(req.body!) as Obj;
      if (map.has(obj.metadata.name)) return { status: 409, body: "{}" };
      if (resource === "pods") obj.status = podStatus;
      if (lateWrites.get(resource) === null) {
        lateWrites.set(resource, obj);
        throw Object.assign(new Error("timeout"), { code: "ETIMEDOUT" });
      }
      map.set(obj.metadata.name, obj);
      // A create whose response never arrived (timeout, ECONNRESET, a 5xx after the write reached etcd)
      // still leaves the object behind, unlike `failures` above which rejects before applying anything.
      if (failAfterApplies.some((f) => f.method === "POST" && f.resource === resource)) {
        throw Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
      }
      return { status: 201, body: JSON.stringify(obj) };
    }
    if (req.method === "GET" && name) {
      const obj = map.get(name);
      return obj ? { status: 200, body: JSON.stringify(obj) } : { status: 404, body: "{}" };
    }
    if (req.method === "GET") {
      const selector = url.searchParams.get("labelSelector") ?? "";
      const wanted = selector.split(",").filter(Boolean).map((p) => p.split("="));
      const items = [...map.values()].filter((o) => wanted.every(([k, v]) => o.metadata.labels?.[k] === v));
      return { status: 200, body: JSON.stringify({ items }) };
    }
    if (req.method === "DELETE") {
      if (map.delete(name!)) return { status: 200, body: "{}" };
      const late = lateWrites.get(resource);
      if (late && late.metadata.name === name) {
        lateWrites.delete(resource);
        map.set(name, late);
      }
      return { status: 404, body: "{}" };
    }
    if (req.method === "PATCH") {
      const obj = map.get(name!);
      if (!obj) return { status: 404, body: "{}" };
      const patch = JSON.parse(req.body!) as { data?: Record<string, string> };
      obj.data = { ...(obj.data as Record<string, string>), ...patch.data };
      return { status: 200, body: JSON.stringify(obj) };
    }
    return { status: 405, body: "{}" };
  };

  return {
    store,
    calls,
    transport,
    setUnreachable: (v: boolean) => { unreachable = v; },
    fail: (method: string, resource: Resource, status: number) => failures.push({ method, resource, status }),
    failAfterApply: (method: string, resource: Resource) => failAfterApplies.push({ method, resource }),
    writeLate: (resource: Resource) => lateWrites.set(resource, null),
    clearFailures: () => {
      failures.splice(0);
      failAfterApplies.splice(0);
    },
    setPodStatus: (s: Record<string, unknown>) => { podStatus = s; },
  };
}

const settings: SessionPodSettings = {
  namespace: NS,
  image: "ghcr.io/st-john-software/claws:v1",
  imagePullSecrets: ["ghcr-pull"],
  storageClassName: "local-path",
  storageSize: "20Gi",
  nodeSelector: { "kubernetes.io/hostname": "k3s" },
  priorityClassName: "",
  cpuRequest: "250m",
  memoryRequest: "1Gi",
  memoryLimit: "6Gi",
  mcpUrl: "",
};

let launchCount = 0;

function fakeLaunch(req: PodLaunchRequest): PodLaunch {
  const dir = req.repos[0] ? `/home/claws/work/${req.repos[0]}` : "/home/claws";
  const secretData: Record<string, string> = {
    "launch.json": JSON.stringify({ sessionId: req.id }),
    "terminal-token": "term-token",
    "mcp-token": `mcp-token-${++launchCount}`,
    "clone-env.json": "{}",
    "granted-env": "# Capabilities granted mid-session are written here by Claws\n",
    "granted-kubeconfig-prod-infra": "",
  };
  if (req.capabilities.includes("github-auth")) secretData["github-token"] = "gh-initial";
  return {
    spec: { sessionId: req.id, cwd: dir, command: ["zsh"], uploadDir: "/home/claws/.claws-session/uploads", repos: [], files: [], ssh: [] },
    secretData,
    cwd: dir,
    repoDirs: req.repos.map((repo) => ({ repo, dir: `/home/claws/work/${repo}` })),
    terminalToken: "term-token",
    mcpToken: secretData["mcp-token"],
    hasGithubToken: req.capabilities.includes("github-auth"),
  };
}

function podRow(id: string, overrides: Partial<PersistedSession> = {}): PersistedSession {
  return {
    id, tmux_name: `claws-${id}`, mode: "worktree-claude", repo: "org/app", cwd: "/home/claws/work/org/app",
    worktree_path: "/home/claws/work/org/app", extra_worktrees: null, capabilities: "[]", created_at: 0,
    summary: null, summary_updated_at: null, ended_at: null, resume_repos: null, provider: "claude",
    summary_manual: 0, model: null, backend: "k8s-pod", agent_status: null, agent_status_updated_at: null, launched_at: null,
    ...overrides,
  };
}

function podObject(id: string, status: Record<string, unknown> = READY_STATUS): Obj {
  return {
    metadata: {
      name: `claws-session-${id}`,
      labels: { "app.kubernetes.io/managed-by": "claws", "claws-workload": "session", "claws-workload-id": id },
    },
    status,
  };
}

describe("k8s-pod session backend", () => {
  let saDir: string;
  let cluster: ReturnType<typeof fakeCluster>;
  let clock: number;
  let buildLaunch: ReturnType<typeof vi.fn>;
  let getGithubToken: ReturnType<typeof vi.fn>;

  function backend() {
    return createK8sSessionBackend({
      client: createK8sClient({ transport: cluster.transport, saDir }),
      settings,
      now: () => clock,
      sleep: async () => {},
      buildLaunch: buildLaunch as unknown as (req: PodLaunchRequest) => Promise<PodLaunch>,
      getGithubToken: getGithubToken as unknown as (repos: string[]) => Promise<string>,
      podBaseUrl: () => "http://127.0.0.1:1",
      readyTimeoutMs: 0,
      podGoneTimeoutMs: 0,
      buildGrantedData: (caps: string[]) => ({
        "granted-env": `# granted\n${caps.map((c) => `export GRANTED_${c.replace(/\W/g, "_")}='1'\n`).join("")}`,
        "granted-kubeconfig-prod-infra": caps.includes("prod-infra") ? "prod-kube" : "",
      }),
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    rows.clear();
    saDir = fs.mkdtempSync(path.join(os.tmpdir(), "claws-k8s-backend-sa-"));
    fs.writeFileSync(path.join(saDir, "token"), "sa-token");
    cluster = fakeCluster();
    clock = 10_000_000;
    buildLaunch = vi.fn(async (req: PodLaunchRequest) => fakeLaunch(req));
    getGithubToken = vi.fn(async () => "gh-fresh");
    mockListRepos.mockResolvedValue([
      { owner: "org", name: "app", fullName: "org/app", defaultBranch: "main" },
      { owner: "org", name: "lib", fullName: "org/lib", defaultBranch: "main" },
    ]);
  });

  afterEach(() => {
    fs.rmSync(saDir, { recursive: true, force: true });
  });

  /** Hold the first `method` call whose path ends with `pathSuffix` until `release()`; `reached` is set once it arrives. */
  function holdCall(method: string, pathSuffix: string) {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const held = { reached: false, release };
    const transport = cluster.transport;
    cluster.transport = async (req) => {
      if (!held.reached && req.method === method && req.path.endsWith(pathSuffix)) {
        held.reached = true;
        await gate;
      }
      return transport(req);
    };
    return held;
  }

  describe("create", () => {
    it("inserts the row, then creates Secret → PVC → Service → Pod", async () => {
      const b = backend();
      const res = await b.create({ repo: "org/app", mode: "worktree-claude", capabilities: ["github-auth"], provider: "claude", model: null });

      expect(res.ok).toBe(true);
      const id = (res as { id: string }).id;
      const row = rows.get(id)!;
      expect(row.backend).toBe("k8s-pod");
      expect(row.tmux_name).toBe(`claws-${id}`);
      expect(row.cwd).toBe("/home/claws/work/org/app");
      expect(cluster.calls.filter((c) => c.startsWith("POST"))).toEqual(["POST secrets", "POST persistentvolumeclaims", "POST services", "POST pods"]);

      const secret = cluster.store.secrets.get(`claws-session-${id}`) as unknown as { data: Record<string, string> };
      expect(Buffer.from(secret.data["github-token"], "base64").toString()).toBe("gh-initial");
      const pod = cluster.store.pods.get(`claws-session-${id}`) as unknown as { spec: { volumes: Array<{ name: string; secret?: { items: Array<{ key: string }> } }>; nodeSelector: Record<string, string> } };
      const mainItems = pod.spec.volumes.find((v) => v.name === "secret")!.secret!.items.map((i) => i.key);
      expect(mainItems).not.toContain("clone-env.json");
      expect(mainItems).toContain("github-token");
      expect(pod.spec.nodeSelector).toEqual({ "kubernetes.io/hostname": "k3s" });
      expect(JSON.stringify(pod)).not.toContain("ownerReferences");

      expect(await b.checkAttach(id)).toEqual({ ok: true });
    });

    it("on an API failure deletes what it created, including the new PVC, and the row", async () => {
      cluster.fail("POST", "services", 403);
      const b = backend();
      const res = await b.create({ repo: "org/app", mode: "repo-claude", capabilities: [], provider: "claude", model: null });

      expect(res.ok).toBe(false);
      expect((res as { reason: string }).reason).toBe("backend-unavailable");
      expect((res as { detail: string }).detail).toContain('RBAC "create" on services');
      expect(cluster.store.secrets.size).toBe(0);
      expect(cluster.store.persistentvolumeclaims.size).toBe(0);
      expect(cluster.calls).toContain(`DELETE persistentvolumeclaims/claws-session-${mockDb.insertSession.mock.calls[0][0].id}`);
      expect(rows.size).toBe(0);
    });

    it("rolls back the Secret even when its create call reports failure after the API already stored it", async () => {
      cluster.failAfterApply("POST", "secrets");
      const b = backend();
      const res = await b.create({ repo: "org/app", mode: "repo-claude", capabilities: [], provider: "claude", model: null });

      expect(res.ok).toBe(false);
      expect((res as { reason: string }).reason).toBe("backend-unavailable");
      expect(cluster.store.secrets.size).toBe(0);
      expect(rows.size).toBe(0);
    });

    it("rolls back every object when the Pod create reports failure after the API already stored it", async () => {
      cluster.failAfterApply("POST", "pods");
      const b = backend();
      expect(await b.create({ repo: "org/app", mode: "repo-claude", capabilities: [], provider: "claude", model: null })).toMatchObject({ ok: false });

      for (const r of ["pods", "services", "secrets", "persistentvolumeclaims"] as const) expect(cluster.store[r].size).toBe(0);
      expect(rows.size).toBe(0);
    });

    it("writes no history row when the API is unreachable, since nothing can have been created", async () => {
      cluster.setUnreachable(true);
      const b = backend();
      expect(await b.create({ repo: "org/app", mode: "repo-claude", capabilities: [], provider: "claude", model: null })).toMatchObject({ ok: false });

      expect(rows.size).toBe(0);
      expect(mockDb.markSessionEnded).not.toHaveBeenCalled();
      cluster.setUnreachable(false);
      await b.reconcile();
      expect(cluster.calls.filter((c) => c.startsWith("DELETE"))).toEqual([]);
    });

    it("rolls back what a refused create created, never deleting the refused object, and deletes the row", async () => {
      cluster.fail("POST", "services", 403);
      cluster.fail("DELETE", "services", 403);
      const b = backend();
      expect(await b.create({ repo: "org/app", mode: "repo-claude", capabilities: [], provider: "claude", model: null })).toMatchObject({ ok: false });
      const id = mockDb.insertSession.mock.calls[0][0].id as string;

      expect(rows.size).toBe(0);
      expect(mockDb.markSessionEnded).not.toHaveBeenCalled();
      expect(cluster.calls).toContain(`DELETE secrets/claws-session-${id}`);
      expect(cluster.calls).toContain(`DELETE persistentvolumeclaims/claws-session-${id}`);
      expect(cluster.calls).not.toContain(`DELETE services/claws-session-${id}`);
    });

    it("deletes a Secret whose timed-out create is written after the rollback's delete, then the row", async () => {
      cluster.writeLate("secrets");
      const b = backend();
      expect(await b.create({ repo: "org/app", mode: "repo-claude", capabilities: [], provider: "claude", model: null })).toMatchObject({ ok: false });
      const id = mockDb.insertSession.mock.calls[0][0].id as string;
      // The rollback's delete answered 404 before the write landed.
      expect(cluster.store.secrets.has(`claws-session-${id}`)).toBe(true);
      expect(rows.get(id)!.ended_at).toBe(clock);

      await b.reconcile();
      expect(cluster.store.secrets.size).toBe(0);
      expect(rows.size).toBe(0);
    });

    it("keeps retrying a timed-out create's delete until its write can no longer land", async () => {
      cluster.fail("POST", "secrets", 504);
      const b = backend();
      expect(await b.create({ repo: "org/app", mode: "repo-claude", capabilities: [], provider: "claude", model: null })).toMatchObject({ ok: false });
      const id = mockDb.insertSession.mock.calls[0][0].id as string;
      expect(rows.get(id)!.ended_at).toBe(clock);

      await b.reconcile();
      expect(rows.has(id)).toBe(true);

      clock += 120_000;
      await b.reconcile();
      expect(rows.size).toBe(0);
      expect(cluster.calls.filter((c) => c.startsWith("DELETE secrets"))).toHaveLength(3);
    });

    it("refuses Delete while a timed-out create may still be written, keeping the row that re-queues its delete", async () => {
      cluster.fail("POST", "secrets", 504);
      const b = backend();
      expect(await b.create({ repo: "org/app", mode: "repo-claude", capabilities: [], provider: "claude", model: null })).toMatchObject({ ok: false });
      const id = mockDb.insertSession.mock.calls[0][0].id as string;
      cluster.clearFailures();
      const deletes = cluster.calls.length;

      expect(await b.remove(id)).toEqual({ ok: false, reason: "unavailable", detail: "session is still being cleaned up — try again shortly" });
      expect(rows.has(id)).toBe(true);
      expect(cluster.calls).toHaveLength(deletes);

      // A restart before the write lands still has the row to re-queue the delete from.
      cluster.store.secrets.set(`claws-session-${id}`, podObject(id));
      await backend().reconcile();
      expect(cluster.store.secrets.size).toBe(0);

      clock += 120_000;
      expect(await b.remove(id)).toEqual({ ok: true });
      expect(rows.has(id)).toBe(false);
    });

    it("refuses Delete while a Secret's write is still pending, then allows it once the deadline passes", async () => {
      cluster.writeLate("secrets");
      const b = backend();
      expect(await b.create({ repo: "org/app", mode: "repo-claude", capabilities: [], provider: "claude", model: null })).toMatchObject({ ok: false });
      const id = mockDb.insertSession.mock.calls[0][0].id as string;

      expect(await b.remove(id)).toEqual({ ok: false, reason: "unavailable", detail: "session is still being cleaned up — try again shortly" });
      expect(rows.has(id)).toBe(true);

      clock += 120_000;
      expect(await b.remove(id)).toEqual({ ok: true });
      expect(rows.has(id)).toBe(false);
    });

    it("refuses Delete after a restart, before reconcile has re-queued them, for a row ended within the late-write window", async () => {
      rows.set("aa11", podRow("aa11", { ended_at: clock - 60_000 }));
      const b = backend();
      expect(await b.remove("aa11")).toMatchObject({ ok: false, reason: "unavailable" });
      expect(rows.has("aa11")).toBe(true);
      expect(cluster.calls).toEqual([]);

      clock += 60_000;
      expect(await b.remove("aa11")).toEqual({ ok: true });
    });

    it("does not prune a row whose timed-out create may still be written until its write can no longer land", async () => {
      cluster.fail("POST", "secrets", 504);
      const b = backend();
      expect(await b.create({ repo: "org/app", mode: "repo-claude", capabilities: [], provider: "claude", model: null })).toMatchObject({ ok: false });
      const id = mockDb.insertSession.mock.calls[0][0].id as string;
      cluster.clearFailures();
      rows.set("aa11", podRow("aa11"));
      mockDb.getPrunableEndedSessionIds.mockResolvedValue([id]);

      expect(await b.end("aa11")).toEqual({ ok: true });
      await vi.waitFor(() => expect(mockDb.getPrunableEndedSessionIds).toHaveBeenCalled());
      await new Promise((r) => setImmediate(r));
      expect(rows.has(id)).toBe(true);
      expect(cluster.calls).not.toContain(`DELETE persistentvolumeclaims/claws-session-${id}`);

      clock += 120_000;
      rows.set("bb22", podRow("bb22"));
      expect(await b.end("bb22")).toEqual({ ok: true });
      await vi.waitFor(() => expect(rows.has(id)).toBe(false));
    });

    it("keeps a timed-out create's delete queued across a restart until its write can no longer land", async () => {
      cluster.fail("POST", "secrets", 504);
      expect(await backend().create({ repo: "org/app", mode: "repo-claude", capabilities: [], provider: "claude", model: null })).toMatchObject({ ok: false });
      const id = mockDb.insertSession.mock.calls[0][0].id as string;
      cluster.clearFailures();

      const b = backend();
      await b.reconcile();
      // The timed-out write lands after the restarted backend's first delete answered 404.
      cluster.store.secrets.set(`claws-session-${id}`, podObject(id));
      clock += 60_000;
      await b.reconcile();
      expect(cluster.store.secrets.size).toBe(0);
    });

    it("keeps the row as ended when a rollback delete fails, and retries it on the next reconcile pass", async () => {
      cluster.fail("POST", "pods", 500);
      cluster.fail("DELETE", "secrets", 500);
      const b = backend();
      expect(await b.create({ repo: "org/app", mode: "repo-claude", capabilities: [], provider: "claude", model: null })).toMatchObject({ ok: false });
      const id = mockDb.insertSession.mock.calls[0][0].id as string;
      expect(rows.get(id)!.ended_at).toBe(clock);
      expect(mockDb.deletePersistedSession).not.toHaveBeenCalled();
      expect(cluster.store.secrets.size).toBe(1);

      cluster.clearFailures();
      await b.reconcile();
      expect(cluster.store.secrets.size).toBe(0);
      expect(cluster.store.persistentvolumeclaims.size).toBe(0);
    });

    it("retries deleting a failed create's row when that delete fails once its rollback has drained", async () => {
      cluster.fail("POST", "pods", 500);
      cluster.fail("DELETE", "secrets", 500);
      const b = backend();
      expect(await b.create({ repo: "org/app", mode: "repo-claude", capabilities: [], provider: "claude", model: null })).toMatchObject({ ok: false });
      const id = mockDb.insertSession.mock.calls[0][0].id as string;
      cluster.clearFailures();
      // Past the lost Pod create's late-write window, so the first pass drains the whole queue.
      clock += 120_000;
      mockDb.deleteEndedPersistedSession.mockRejectedValueOnce(new Error("db down"));

      await b.reconcile();
      expect(cluster.store.secrets.size).toBe(0);
      expect(rows.has(id)).toBe(true);

      await b.reconcile();
      expect(rows.has(id)).toBe(false);
    });

    it("deletes the Secret of a failed create's rollback after a restart", async () => {
      cluster.fail("POST", "pods", 500);
      cluster.fail("DELETE", "secrets", 500);
      expect(await backend().create({ repo: "org/app", mode: "repo-claude", capabilities: [], provider: "claude", model: null })).toMatchObject({ ok: false });
      expect(cluster.store.secrets.size).toBe(1);

      // A fresh backend has no in-memory pendingCleanup; the kept row is what re-queues the delete.
      cluster.clearFailures();
      await backend().reconcile();
      expect(cluster.store.secrets.size).toBe(0);
      expect(mockLog.warn).not.toHaveBeenCalledWith(expect.stringContaining("Orphan session"));
    });

    it("keeps a failed create's attach state failed when the last reconcile pass failed", async () => {
      mockDb.getAllPersistedSessions.mockRejectedValueOnce(new Error("db down"));
      const b = backend();
      await b.reconcile();
      const res = await b.create({ repo: "org/app", mode: "repo-claude", capabilities: [], provider: "claude", model: null });
      expect(res.ok).toBe(true);
      expect(await b.checkAttach((res as { id: string }).id)).toEqual({ ok: false, reason: "unavailable", detail: "session database unreachable" });
    });

    it("refuses End and Delete while the create is still creating objects", async () => {
      const held = holdCall("POST", "/pods");
      const b = backend();

      const creating = b.create({ repo: "org/app", mode: "repo-claude", capabilities: [], provider: "claude", model: null });
      await vi.waitFor(() => expect(held.reached).toBe(true));
      const id = mockDb.insertSession.mock.calls[0][0].id as string;
      const callsBefore = cluster.calls.length;
      const starting = { ok: false, reason: "unavailable", detail: expect.stringContaining("still starting") };
      expect(await b.end(id)).toEqual(starting);
      expect(await b.remove(id)).toEqual(starting);
      expect(cluster.calls).toHaveLength(callsBefore);

      held.release();
      expect(await creating).toEqual({ ok: true, id });
      expect(cluster.store.pods.has(`claws-session-${id}`)).toBe(true);
      expect(rows.get(id)!.ended_at).toBeNull();
    });

    it("returns ok but attach unavailable when the pod is not Ready by the deadline", async () => {
      cluster.setPodStatus({ phase: "Pending" });
      const b = backend();
      const res = await b.create({ repo: "org/app", mode: "repo-claude", capabilities: [], provider: "claude", model: null });
      expect(res.ok).toBe(true);
      expect(await b.checkAttach((res as { id: string }).id)).toEqual({ ok: false, reason: "unavailable", detail: "session pod is pending" });
    });

    it("returns backend-unavailable without touching anything when the image is empty", async () => {
      const b = createK8sSessionBackend({ client: createK8sClient({ transport: cluster.transport, saDir }), settings: { ...settings, image: "" }, buildLaunch: buildLaunch as never });
      const res = await b.create({ repo: null, mode: "home-claude", capabilities: [], provider: "claude", model: null });
      expect(res).toMatchObject({ ok: false, reason: "backend-unavailable" });
      expect(cluster.calls).toEqual([]);
      expect(rows.size).toBe(0);
    });

    it("applies the local request rules", async () => {
      const b = backend();
      expect(await b.create({ repo: "org/unknown", mode: "repo-claude", capabilities: [], provider: "claude", model: null }))
        .toMatchObject({ ok: false, reason: "repo-not-listed" });
      expect(await b.create({ repo: "org/app", mode: "repo-claude", capabilities: ["browser"], provider: "codex", model: null }))
        .toMatchObject({ ok: false, reason: "capability-unsupported" });
      expect(await b.create({ repo: null, mode: "worktree-claude", capabilities: [], provider: "claude", model: null }))
        .toMatchObject({ ok: false, reason: "repo-required-for-mode" });
      expect(await b.createMulti({ repos: ["org/app", "org/lib"], capabilities: [], provider: "opencode", model: null }))
        .toMatchObject({ ok: false, reason: "provider-unsupported" });
      expect(await b.createMulti({ repos: ["org/app", "org/app"], capabilities: [], provider: "claude", model: null }))
        .toMatchObject({ ok: false, reason: "too-few-repos" });
      expect(cluster.calls).toEqual([]);

      // repo-zsh normalises to claude with no model.
      const zsh = await b.create({ repo: "org/app", mode: "repo-zsh", capabilities: [], provider: "codex", model: "gpt" });
      expect(zsh.ok).toBe(true);
      expect(buildLaunch).toHaveBeenLastCalledWith(expect.objectContaining({ provider: "claude", model: null, resume: false }));
    });

    it("rejects a multi-repo session spanning GitHub owners without touching anything", async () => {
      mockListRepos.mockResolvedValue([
        { owner: "org", name: "app", fullName: "org/app", defaultBranch: "main" },
        { owner: "other", name: "tool", fullName: "other/tool", defaultBranch: "main" },
      ]);
      const b = backend();
      const res = await b.createMulti({ repos: ["org/app", "other/tool"], capabilities: [], provider: "claude", model: null });
      expect(res).toMatchObject({ ok: false, reason: "repos-span-owners", detail: expect.stringContaining("org, other") });
      expect(buildLaunch).not.toHaveBeenCalled();
      expect(cluster.calls).toEqual([]);
      expect(rows.size).toBe(0);
    });

    it("creates a multi-repo session with every repo", async () => {
      const b = backend();
      const res = await b.createMulti({ repos: ["org/app", "org/lib", "org/app"], capabilities: [], provider: "claude", model: null });
      expect(res.ok).toBe(true);
      const row = rows.get((res as { id: string }).id)!;
      expect(row.mode).toBe("multi-worktree-claude");
      expect(JSON.parse(row.extra_worktrees!)).toEqual([{ repo: "org/lib", worktreePath: "/home/claws/work/org/lib" }]);
    });
  });

  describe("end", () => {
    it("an API error returns unavailable and writes nothing", async () => {
      rows.set("aa11", podRow("aa11"));
      cluster.store.pods.set("claws-session-aa11", podObject("aa11"));
      cluster.fail("DELETE", "pods", 500);
      const b = backend();

      expect(await b.end("aa11")).toMatchObject({ ok: false, reason: "unavailable" });
      expect(mockDb.markSessionEnded).not.toHaveBeenCalled();
      expect(rows.get("aa11")!.ended_at).toBeNull();
    });

    it("deletes pod, service and secret, ends the row and keeps the PVC", async () => {
      rows.set("aa11", podRow("aa11"));
      for (const r of ["pods", "services", "secrets", "persistentvolumeclaims"] as const) {
        cluster.store[r].set("claws-session-aa11", podObject("aa11"));
      }
      const b = backend();

      expect(await b.end("aa11")).toEqual({ ok: true });
      expect(rows.get("aa11")!.ended_at).toBe(clock);
      expect(JSON.parse(rows.get("aa11")!.resume_repos!)).toEqual(["org/app"]);
      expect(cluster.store.pods.size).toBe(0);
      expect(cluster.store.services.size).toBe(0);
      expect(cluster.store.secrets.size).toBe(0);
      expect(cluster.store.persistentvolumeclaims.has("claws-session-aa11")).toBe(true);
    });

    it("retries a Secret delete that failed on End every reconcile pass until it succeeds", async () => {
      rows.set("aa11", podRow("aa11"));
      for (const r of ["pods", "services", "secrets", "persistentvolumeclaims"] as const) {
        cluster.store[r].set("claws-session-aa11", podObject("aa11"));
      }
      cluster.fail("DELETE", "secrets", 500);
      const b = backend();

      expect(await b.end("aa11")).toEqual({ ok: true });
      expect(cluster.store.secrets.size).toBe(1);
      await b.reconcile();
      expect(cluster.store.secrets.size).toBe(1);

      cluster.clearFailures();
      await b.reconcile();
      expect(cluster.store.secrets.size).toBe(0);
      expect(cluster.store.persistentvolumeclaims.has("claws-session-aa11")).toBe(true);
      const secretDeletes = () => cluster.calls.filter((c) => c === "DELETE secrets/claws-session-aa11").length;
      const deletes = secretDeletes();
      await b.reconcile();
      expect(secretDeletes()).toBe(deletes);
    });

    it("refuses End and Delete while a resume of the session is in flight", async () => {
      rows.set("aa11", podRow("aa11", { ended_at: 5 }));
      cluster.store.persistentvolumeclaims.set("claws-session-aa11", podObject("aa11"));
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      buildLaunch.mockImplementationOnce(async (req: PodLaunchRequest) => {
        await gate;
        return fakeLaunch(req);
      });
      const b = backend();

      const resuming = b.resume("aa11");
      await vi.waitFor(() => expect(buildLaunch).toHaveBeenCalled());
      const callsBefore = cluster.calls.length;
      const starting = { ok: false, reason: "unavailable", detail: expect.stringContaining("still starting") };
      expect(await b.end("aa11")).toEqual(starting);
      expect(await b.remove("aa11")).toEqual(starting);
      expect(cluster.calls).toHaveLength(callsBefore);

      release();
      expect(await resuming).toEqual({ ok: true, id: "aa11" });
      expect(rows.get("aa11")!.ended_at).toBeNull();
      expect(cluster.store.secrets.has("claws-session-aa11")).toBe(true);
    });

    it("refuses a resume while End is deleting the session's objects", async () => {
      rows.set("aa11", podRow("aa11"));
      for (const r of ["pods", "services", "secrets", "persistentvolumeclaims"] as const) {
        cluster.store[r].set("claws-session-aa11", podObject("aa11"));
      }
      const held = holdCall("DELETE", "/secrets/claws-session-aa11");
      const b = backend();

      const ending = b.end("aa11");
      await vi.waitFor(() => expect(held.reached).toBe(true));
      expect(await b.resume("aa11")).toEqual({ ok: false, reason: "backend-unavailable", detail: "session is being ended — try again shortly" });
      expect(buildLaunch).not.toHaveBeenCalled();

      held.release();
      expect(await ending).toEqual({ ok: true });
      expect(rows.get("aa11")!.ended_at).toBe(clock);
      expect(cluster.store.pods.size).toBe(0);
      expect(cluster.store.secrets.size).toBe(0);
    });

    it("is not-found for host rows and unknown ids", async () => {
      rows.set("bb22", podRow("bb22", { backend: null }));
      const b = backend();
      expect(await b.end("bb22")).toMatchObject({ ok: false, reason: "not-found" });
      expect(await b.end("cc33")).toMatchObject({ ok: false, reason: "not-found" });
      expect(cluster.calls).toEqual([]);
    });

    it("deletes every object, PVC included, of sessions pruned from history, then their rows", async () => {
      rows.set("aa11", podRow("aa11"));
      rows.set("old1", podRow("old1", { ended_at: 1 }));
      cluster.store.persistentvolumeclaims.set("claws-session-old1", podObject("old1"));
      mockDb.getPrunableEndedSessionIds.mockResolvedValueOnce(["old1"]);
      const b = backend();
      await b.end("aa11");
      await vi.waitFor(() => expect(rows.has("old1")).toBe(false));
      expect(mockDb.getPrunableEndedSessionIds).toHaveBeenCalledWith(50, "k8s-pod");
      expect(cluster.store.persistentvolumeclaims.has("claws-session-old1")).toBe(false);
    });

    it("refuses to resume a session while its history prune is deleting its objects", async () => {
      rows.set("aa11", podRow("aa11"));
      rows.set("old1", podRow("old1", { ended_at: 1 }));
      cluster.store.persistentvolumeclaims.set("claws-session-old1", podObject("old1"));
      mockDb.getPrunableEndedSessionIds.mockResolvedValueOnce(["old1"]);
      const held = holdCall("DELETE", "/pods/claws-session-old1");
      const b = backend();

      expect(await b.end("aa11")).toEqual({ ok: true });
      await vi.waitFor(() => expect(held.reached).toBe(true));
      expect(await b.resume("old1")).toEqual({ ok: false, reason: "backend-unavailable", detail: "session storage is being deleted — try again shortly" });
      expect(buildLaunch).not.toHaveBeenCalled();

      held.release();
      await vi.waitFor(() => expect(rows.has("old1")).toBe(false));
      expect(cluster.store.persistentvolumeclaims.size).toBe(0);
    });

    it("leaves alone a session resumed between the prune query and its loop", async () => {
      rows.set("aa11", podRow("aa11"));
      rows.set("old1", podRow("old1", { ended_at: 1 }));
      rows.set("old2", podRow("old2", { ended_at: 2 }));
      cluster.store.persistentvolumeclaims.set("claws-session-old1", podObject("old1"));
      const b = backend();
      let resumed: unknown;
      mockDb.getPrunableEndedSessionIds.mockImplementationOnce(async () => {
        resumed = await b.resume("old1");
        return ["old1", "old2"];
      });

      expect(await b.end("aa11")).toEqual({ ok: true });
      // old2 comes after old1 in the loop, so its row going means old1 has been passed over.
      await vi.waitFor(() => expect(rows.has("old2")).toBe(false));
      expect(resumed).toEqual({ ok: true, id: "old1" });
      expect(rows.get("old1")!.ended_at).toBeNull();
      expect(cluster.store.pods.has("claws-session-old1")).toBe(true);
      expect(cluster.store.secrets.has("claws-session-old1")).toBe(true);
      expect(cluster.store.persistentvolumeclaims.has("claws-session-old1")).toBe(true);
      expect(cluster.calls).not.toContain("DELETE persistentvolumeclaims/claws-session-old1");
    });

    it("keeps a pruned row whose object delete fails, so the next End or reconcile that ends a row retries it", async () => {
      rows.set("aa11", podRow("aa11"));
      rows.set("old1", podRow("old1", { ended_at: 1 }));
      cluster.store.persistentvolumeclaims.set("claws-session-old1", podObject("old1"));
      cluster.fail("DELETE", "persistentvolumeclaims", 500);
      mockDb.getPrunableEndedSessionIds.mockResolvedValueOnce(["old1"]);
      const b = backend();
      expect(await b.end("aa11")).toEqual({ ok: true });
      await vi.waitFor(() => expect(mockLog.warn).toHaveBeenCalledWith(expect.stringContaining("Failed to delete persistentvolumeclaims claws-session-old1")));
      expect(rows.has("old1")).toBe(true);
      expect(cluster.store.persistentvolumeclaims.has("claws-session-old1")).toBe(true);
    });
  });

  describe("remove", () => {
    it("deletes the row only after every delete returns ok or 404", async () => {
      rows.set("aa11", podRow("aa11", { ended_at: 5 }));
      cluster.store.persistentvolumeclaims.set("claws-session-aa11", podObject("aa11"));
      cluster.store.secrets.set("claws-session-aa11", podObject("aa11"));
      cluster.fail("DELETE", "persistentvolumeclaims", 500);
      const b = backend();

      expect(await b.remove("aa11")).toMatchObject({ ok: false, reason: "unavailable" });
      expect(rows.has("aa11")).toBe(true);
      expect(mockDb.deletePersistedSession).not.toHaveBeenCalled();

      cluster.clearFailures();
      expect(await b.remove("aa11")).toEqual({ ok: true });
      expect(rows.has("aa11")).toBe(false);
      expect(cluster.store.persistentvolumeclaims.size).toBe(0);
    });

    it("refuses a resume while Delete is removing the session, leaving no pod behind", async () => {
      rows.set("aa11", podRow("aa11", { ended_at: 5 }));
      for (const r of ["services", "secrets", "persistentvolumeclaims"] as const) cluster.store[r].set("claws-session-aa11", podObject("aa11"));
      const held = holdCall("DELETE", "/pods/claws-session-aa11");
      const b = backend();

      const removing = b.remove("aa11");
      await vi.waitFor(() => expect(held.reached).toBe(true));
      expect(await b.resume("aa11")).toEqual({ ok: false, reason: "backend-unavailable", detail: "session is being deleted — try again shortly" });
      expect(await b.end("aa11")).toEqual({ ok: false, reason: "unavailable", detail: "session is being deleted — try again shortly" });
      expect(buildLaunch).not.toHaveBeenCalled();

      held.release();
      expect(await removing).toEqual({ ok: true });
      expect(rows.has("aa11")).toBe(false);
      for (const r of ["pods", "services", "secrets", "persistentvolumeclaims"] as const) expect(cluster.store[r].size).toBe(0);
    });

    it("never deletes a live host-tmux row", async () => {
      rows.set("bb22", podRow("bb22", { backend: "local-tmux" }));
      const b = backend();
      expect(await b.remove("bb22")).toMatchObject({ ok: false, reason: "not-found" });
      expect(rows.has("bb22")).toBe(true);
      expect(cluster.calls).toEqual([]);
    });

    it("removes an ended host-tmux row from history without calling the cluster", async () => {
      rows.set("bb22", podRow("bb22", { backend: null, ended_at: 5 }));
      const b = backend();
      expect(await b.remove("bb22")).toEqual({ ok: true });
      expect(rows.has("bb22")).toBe(false);
      expect(cluster.calls).toEqual([]);
    });
  });

  describe("resume", () => {
    it("refuses host rows and sessions whose storage is gone", async () => {
      rows.set("bb22", podRow("bb22", { backend: null, ended_at: 5 }));
      rows.set("aa11", podRow("aa11", { ended_at: 5 }));
      const b = backend();

      expect(await b.resume("bb22")).toEqual({ ok: false, reason: "not-resumable", detail: "created on the host tmux backend" });
      expect(await b.resume("aa11")).toEqual({ ok: false, reason: "not-resumable", detail: "session storage was deleted" });
      expect(rows.get("aa11")!.ended_at).toBe(5);
    });

    it("refuses a session whose PVC is terminating", async () => {
      rows.set("aa11", podRow("aa11", { ended_at: 5 }));
      const pvc = podObject("aa11");
      pvc.metadata.deletionTimestamp = "2026-09-14T00:00:00Z";
      cluster.store.persistentvolumeclaims.set("claws-session-aa11", pvc);
      const b = backend();

      expect(await b.resume("aa11")).toEqual({ ok: false, reason: "not-resumable", detail: "session storage is being deleted" });
      expect(buildLaunch).not.toHaveBeenCalled();
      expect(rows.get("aa11")!.ended_at).toBe(5);
    });

    it("an API error is backend-unavailable with no writes", async () => {
      rows.set("aa11", podRow("aa11", { ended_at: 5 }));
      cluster.setUnreachable(true);
      const b = backend();
      expect(await b.resume("aa11")).toMatchObject({ ok: false, reason: "backend-unavailable" });
      expect(mockDb.clearSessionEnded).not.toHaveBeenCalled();
    });

    it("reopens a row whose pod is still running without relaunching", async () => {
      rows.set("aa11", podRow("aa11", { ended_at: 5 }));
      for (const r of ["pods", "services", "secrets", "persistentvolumeclaims"] as const) cluster.store[r].set("claws-session-aa11", podObject("aa11"));
      const b = backend();
      expect(await b.resume("aa11")).toEqual({ ok: true, id: "aa11" });
      expect(rows.get("aa11")!.ended_at).toBeNull();
      expect(buildLaunch).not.toHaveBeenCalled();
    });

    it("relaunches an ended row whose pod still runs but whose Secret is gone", async () => {
      rows.set("aa11", podRow("aa11", { ended_at: 5 }));
      for (const r of ["pods", "services", "persistentvolumeclaims"] as const) cluster.store[r].set("claws-session-aa11", podObject("aa11"));
      const b = backend();

      expect(await b.resume("aa11")).toEqual({ ok: true, id: "aa11" });
      expect(cluster.calls).toContain("DELETE pods/claws-session-aa11");
      expect(buildLaunch).toHaveBeenCalledWith(expect.objectContaining({ id: "aa11", resume: true }));
      expect(cluster.calls.filter((c) => c.startsWith("POST"))).toEqual(["POST secrets", "POST services", "POST pods"]);
      expect(cluster.store.secrets.has("claws-session-aa11")).toBe(true);
      expect(rows.get("aa11")!.ended_at).toBeNull();
    });

    it("treats a terminating pod as terminal: waits for it to go, then relaunches", async () => {
      rows.set("aa11", podRow("aa11", { ended_at: 5 }));
      cluster.store.persistentvolumeclaims.set("claws-session-aa11", podObject("aa11"));
      const terminating = () => {
        const pod = podObject("aa11");
        pod.metadata.deletionTimestamp = "2026-09-14T00:00:00Z";
        return pod;
      };
      // The fake API deletes immediately; re-add the pod on DELETE so it stays present, like a slow shutdown.
      cluster.store.pods.set("claws-session-aa11", terminating());
      const realDelete = cluster.store.pods.delete.bind(cluster.store.pods);
      cluster.store.pods.delete = (key: string) => {
        const had = realDelete(key);
        cluster.store.pods.set(key, terminating());
        return had;
      };
      const b = backend();

      expect(await b.resume("aa11")).toMatchObject({ ok: false, reason: "backend-unavailable", detail: expect.stringContaining("still terminating") });
      expect(mockDb.clearSessionEnded).not.toHaveBeenCalled();
      expect(buildLaunch).not.toHaveBeenCalled();

      cluster.store.pods.delete = realDelete;
      realDelete("claws-session-aa11");
      expect(await b.resume("aa11")).toEqual({ ok: true, id: "aa11" });
      expect(buildLaunch).toHaveBeenCalledWith(expect.objectContaining({ id: "aa11", resume: true }));
      expect(rows.get("aa11")!.ended_at).toBeNull();
    });

    it("replaces a terminated pod on the existing PVC with resume:true", async () => {
      rows.set("aa11", podRow("aa11", { ended_at: 5, capabilities: '["github-auth"]' }));
      cluster.store.persistentvolumeclaims.set("claws-session-aa11", podObject("aa11"));
      cluster.store.pods.set("claws-session-aa11", podObject("aa11", { phase: "Failed", reason: "Evicted" }));
      cluster.store.secrets.set("claws-session-aa11", podObject("aa11"));
      const b = backend();

      expect(await b.resume("aa11")).toEqual({ ok: true, id: "aa11" });
      expect(buildLaunch).toHaveBeenCalledWith(expect.objectContaining({ id: "aa11", resume: true, repos: ["org/app"], capabilities: ["github-auth"] }));
      expect(cluster.calls).not.toContain("POST persistentvolumeclaims");
      expect(cluster.calls.filter((c) => c.startsWith("POST"))).toEqual(["POST secrets", "POST services", "POST pods"]);
      expect(rows.get("aa11")!.ended_at).toBeNull();
    });

    it("persists the relaunch time, so a restart keeps the resumed session's launch grace", async () => {
      rows.set("aa11", podRow("aa11", { ended_at: 5, created_at: 0 }));
      cluster.store.persistentvolumeclaims.set("claws-session-aa11", podObject("aa11"));
      cluster.store.pods.set("claws-session-aa11", podObject("aa11", { phase: "Failed", reason: "Evicted" }));
      expect(await backend().resume("aa11")).toEqual({ ok: true, id: "aa11" });
      expect(mockDb.clearSessionEnded).toHaveBeenCalledWith("aa11", clock);
      expect(rows.get("aa11")!.launched_at).toBe(clock);

      // The relaunched pod is not listed yet (e.g. still being scheduled) when a restarted Claws reconciles.
      cluster.store.pods.delete("claws-session-aa11");
      await backend().reconcile();
      expect(rows.get("aa11")!.ended_at).toBeNull();

      clock += 3 * 60 * 1000 + 1;
      await backend().reconcile();
      expect(rows.get("aa11")!.ended_at).toBe(clock);
      expect(mockLog.info).toHaveBeenCalledWith(expect.stringContaining("ended (pod not found)"));
    });

    it("keeps the PVC and removes the new pod when reopening the row fails", async () => {
      rows.set("aa11", podRow("aa11", { ended_at: 5 }));
      cluster.store.persistentvolumeclaims.set("claws-session-aa11", podObject("aa11"));
      mockDb.clearSessionEnded.mockRejectedValueOnce(new Error("db down"));
      const b = backend();

      expect(await b.resume("aa11")).toMatchObject({ ok: false, reason: "persist-failed" });
      expect(cluster.store.pods.size).toBe(0);
      expect(cluster.store.secrets.size).toBe(0);
      expect(cluster.store.persistentvolumeclaims.has("claws-session-aa11")).toBe(true);
    });

    it("rolls back the relaunch, keeping the PVC and the ended row, when the Pod create fails after the API stored it", async () => {
      rows.set("aa11", podRow("aa11", { ended_at: 5 }));
      cluster.store.persistentvolumeclaims.set("claws-session-aa11", podObject("aa11"));
      cluster.failAfterApply("POST", "pods");
      const b = backend();

      expect(await b.resume("aa11")).toMatchObject({ ok: false, reason: "backend-unavailable" });
      expect(cluster.store.pods.size).toBe(0);
      expect(cluster.store.services.size).toBe(0);
      expect(cluster.store.secrets.size).toBe(0);
      expect(cluster.store.persistentvolumeclaims.has("claws-session-aa11")).toBe(true);
      expect(rows.get("aa11")!.ended_at).toBe(5);
    });
  });

  describe("reconcile", () => {
    it.each([
      ["the API is unreachable", () => cluster.setUnreachable(true), "Kubernetes API unreachable"],
      ["listing pods is forbidden", () => cluster.fail("GET", "pods", 403), "Kubernetes API unreachable"],
      ["listing pods errors", () => cluster.fail("GET", "pods", 500), "Kubernetes API unreachable"],
      ["the database read fails", () => mockDb.getAllPersistedSessions.mockRejectedValueOnce(new Error("db down")), "session database unreachable"],
    ])("makes no writes when %s, and 503s attach and uploads", async (_label, breakIt, detail) => {
      rows.set("aa11", podRow("aa11", { created_at: 0 }));
      breakIt();
      const b = backend();
      await b.start();
      await b.shutdown();

      expect(cluster.calls.length).toBeGreaterThan(0);
      expect(mockDb.markSessionEnded).not.toHaveBeenCalled();
      expect(cluster.calls.filter((c) => c.startsWith("DELETE") || c.startsWith("PATCH") || c.startsWith("POST"))).toEqual([]);
      // A failure on the very first pass is still logged.
      expect(mockLog.warn).toHaveBeenCalledWith(expect.stringContaining("making no changes"));
      expect(await b.checkAttach("aa11")).toEqual({ ok: false, reason: "unavailable", detail });
      expect(await b.saveUpload("aa11", "a.txt", Buffer.from("x"))).toMatchObject({ ok: false, reason: "unavailable" });
      // The row is still listed as live.
      expect((await b.listLive()).map((s) => s.id)).toEqual(["aa11"]);
    });

    it("names the missing list grant when listing pods is forbidden", async () => {
      cluster.fail("GET", "pods", 403);
      await backend().reconcile();
      expect(mockLog.warn).toHaveBeenCalledWith(expect.stringContaining('RBAC "list" on pods'));
    });

    it("ends rows with a terminal pod or no pod past the grace, and never deletes a PVC", async () => {
      rows.set("gone", podRow("gone", { created_at: 0 }));
      rows.set("fresh", podRow("fresh", { created_at: clock - 1_000 }));
      rows.set("died", podRow("died", { created_at: 0 }));
      rows.set("live", podRow("live", { created_at: 0 }));
      rows.set("host", podRow("host", { created_at: 0, backend: null }));
      cluster.store.pods.set("claws-session-died", podObject("died", { phase: "Failed", reason: "Evicted" }));
      cluster.store.pods.set("claws-session-live", podObject("live"));
      cluster.store.pods.set("claws-session-orphan", podObject("orphan"));
      for (const id of ["gone", "died", "live"]) cluster.store.persistentvolumeclaims.set(`claws-session-${id}`, podObject(id));
      const b = backend();
      await b.reconcile();

      expect(rows.get("gone")!.ended_at).toBe(clock);
      expect(rows.get("died")!.ended_at).toBe(clock);
      expect(rows.get("fresh")!.ended_at).toBeNull();
      expect(rows.get("live")!.ended_at).toBeNull();
      expect(rows.get("host")!.ended_at).toBeNull();
      expect(cluster.calls.some((c) => c.startsWith("DELETE persistentvolumeclaims"))).toBe(false);
      // Orphans are reported, never deleted.
      expect(cluster.store.pods.has("claws-session-orphan")).toBe(true);
      expect(mockLog.warn).toHaveBeenCalledWith(expect.stringContaining("kubectl -n claws-sessions delete pod,svc,secret -l claws-workload-id=orphan"));
      expect(await b.checkAttach("live")).toEqual({ ok: true });

      // Next pass deletes the pod of the now-ended row, still leaving its PVC.
      await b.reconcile();
      expect(cluster.store.pods.has("claws-session-died")).toBe(false);
      expect(cluster.store.persistentvolumeclaims.has("claws-session-died")).toBe(true);
    });

    it("deletes the Service and Secret of a row it ends, keeping the PVC", async () => {
      rows.set("died", podRow("died", { created_at: 0 }));
      for (const r of ["services", "secrets", "persistentvolumeclaims"] as const) cluster.store[r].set("claws-session-died", podObject("died"));
      cluster.store.pods.set("claws-session-died", podObject("died", { phase: "Succeeded" }));
      const b = backend();
      await b.reconcile();

      expect(rows.get("died")!.ended_at).toBe(clock);
      expect(cluster.store.secrets.size).toBe(0);
      expect(cluster.store.services.size).toBe(0);
      expect(cluster.store.persistentvolumeclaims.has("claws-session-died")).toBe(true);
    });

    it("prunes history once a row ends on its own, not only when End is clicked", async () => {
      rows.set("died", podRow("died", { created_at: 0 }));
      cluster.store.pods.set("claws-session-died", podObject("died", { phase: "Succeeded" }));
      rows.set("old1", podRow("old1", { ended_at: 1 }));
      cluster.store.persistentvolumeclaims.set("claws-session-old1", podObject("old1"));
      mockDb.getPrunableEndedSessionIds.mockResolvedValueOnce(["old1"]);
      const b = backend();

      await b.reconcile();
      expect(rows.get("died")!.ended_at).toBe(clock);
      expect(rows.has("old1")).toBe(false);
      expect(cluster.store.persistentvolumeclaims.has("claws-session-old1")).toBe(false);
    });

    it("retries a Secret delete that failed when it ended a pod-less row", async () => {
      rows.set("gone", podRow("gone", { created_at: 0 }));
      cluster.store.secrets.set("claws-session-gone", podObject("gone"));
      cluster.fail("DELETE", "secrets", 500);
      const b = backend();
      await b.reconcile();
      expect(rows.get("gone")!.ended_at).toBe(clock);
      expect(cluster.store.secrets.size).toBe(1);

      cluster.clearFailures();
      await b.reconcile();
      expect(cluster.store.secrets.size).toBe(0);
    });

    it("deletes the leftover Service and Secret of ended rows once after a restart, keeping the PVC", async () => {
      rows.set("old1", podRow("old1", { ended_at: 5 }));
      for (const r of ["services", "secrets", "persistentvolumeclaims"] as const) cluster.store[r].set("claws-session-old1", podObject("old1"));
      const b = backend();
      await b.reconcile();
      await b.reconcile();

      expect(cluster.store.services.size).toBe(0);
      expect(cluster.store.secrets.size).toBe(0);
      expect(cluster.store.persistentvolumeclaims.has("claws-session-old1")).toBe(true);
      expect(cluster.calls.filter((c) => c.startsWith("DELETE secrets"))).toHaveLength(1);
    });

    it("only queues ended rows' Service and Secret deletes on the startup pass, leaving them to the next pass", async () => {
      rows.set("old1", podRow("old1", { ended_at: 5 }));
      for (const r of ["services", "secrets"] as const) cluster.store[r].set("claws-session-old1", podObject("old1"));
      const b = backend();
      await b.start();
      try {
        expect(cluster.calls.filter((c) => c.startsWith("DELETE"))).toEqual([]);

        await b.reconcile();
        expect(cluster.calls.filter((c) => c.startsWith("DELETE"))).toEqual(["DELETE services/claws-session-old1", "DELETE secrets/claws-session-old1"]);
        expect(cluster.store.services.size).toBe(0);
        expect(cluster.store.secrets.size).toBe(0);
      } finally {
        await b.shutdown();
      }
    });

    it("reports a PVC with no session row once and never deletes it", async () => {
      rows.set("kept", podRow("kept", { ended_at: 5 }));
      cluster.store.persistentvolumeclaims.set("claws-session-kept", podObject("kept"));
      cluster.store.persistentvolumeclaims.set("claws-session-lost", podObject("lost"));
      const b = backend();
      await b.reconcile();
      await b.reconcile();

      const pvcWarnings = mockLog.warn.mock.calls.filter(([m]) => String(m).includes("Orphan session PVC"));
      expect(pvcWarnings).toHaveLength(1);
      expect(pvcWarnings[0][0]).toContain("claws-session-lost");
      expect(cluster.store.persistentvolumeclaims.size).toBe(2);
    });

    it("leaves alone a session resumed while the pass was acting on an older snapshot", async () => {
      rows.set("x1", podRow("x1", { created_at: 0 }));
      rows.set("aa11", podRow("aa11", { created_at: 0 }));
      cluster.store.persistentvolumeclaims.set("claws-session-aa11", podObject("aa11"));
      cluster.store.pods.set("claws-session-aa11", podObject("aa11", { phase: "Failed", reason: "Evicted" }));
      const b = backend();
      // While the pass records x1 as ended, the operator revives aa11 (whose Failed pod the plan wants to end).
      let resumed: unknown;
      mockDb.markSessionEnded.mockImplementationOnce(async (id: string, endedAt: number, resumeRepos: string | null) => {
        if (id === "x1") resumed = await b.resume("aa11");
        rows.set(id, { ...rows.get(id)!, ended_at: endedAt, resume_repos: resumeRepos });
      });
      await b.reconcile();

      expect(resumed).toEqual({ ok: true, id: "aa11" });
      expect(rows.get("x1")!.ended_at).toBe(clock);
      expect(rows.get("aa11")!.ended_at).toBeNull();
      expect(cluster.store.pods.has("claws-session-aa11")).toBe(true);
      expect(cluster.store.secrets.has("claws-session-aa11")).toBe(true);
    });

    it("does not touch a session whose lock a Revive holds, even with a cleanup queued for it", async () => {
      rows.set("aa11", podRow("aa11", { ended_at: 5 }));
      cluster.store.persistentvolumeclaims.set("claws-session-aa11", podObject("aa11"));
      // The Revive has created the new Secret and Service; the row is still ended until the pod exists.
      const held = holdCall("POST", "/pods");
      const b = backend();

      const resuming = b.resume("aa11");
      await vi.waitFor(() => expect(held.reached).toBe(true));
      const callsBefore = cluster.calls.length;
      // The first pass queues the ended row's Service and Secret for deletion, but must skip the held id.
      await b.reconcile();
      expect(cluster.calls.slice(callsBefore).filter((c) => c.startsWith("DELETE"))).toEqual([]);
      expect(cluster.store.secrets.has("claws-session-aa11")).toBe(true);

      held.release();
      expect(await resuming).toEqual({ ok: true, id: "aa11" });
      await b.reconcile();
      expect(cluster.store.secrets.has("claws-session-aa11")).toBe(true);
      expect(cluster.store.services.has("claws-session-aa11")).toBe(true);
    });

    it("refuses Revive, End and Delete while reconcile is ending the session", async () => {
      rows.set("aa11", podRow("aa11", { created_at: 0 }));
      for (const r of ["services", "secrets", "persistentvolumeclaims"] as const) cluster.store[r].set("claws-session-aa11", podObject("aa11"));
      cluster.store.pods.set("claws-session-aa11", podObject("aa11", { phase: "Failed", reason: "Evicted" }));
      const held = holdCall("DELETE", "/secrets/claws-session-aa11");
      const b = backend();

      const reconciling = b.reconcile();
      await vi.waitFor(() => expect(held.reached).toBe(true));
      const detail = "session is being reconciled — try again shortly";
      expect(await b.resume("aa11")).toEqual({ ok: false, reason: "backend-unavailable", detail });
      expect(await b.end("aa11")).toEqual({ ok: false, reason: "unavailable", detail });
      expect(await b.remove("aa11")).toEqual({ ok: false, reason: "unavailable", detail });
      expect(buildLaunch).not.toHaveBeenCalled();

      held.release();
      await reconciling;
      expect(rows.get("aa11")!.ended_at).toBe(clock);
      expect(cluster.calls.filter((c) => c.startsWith("POST"))).toEqual([]);
      expect(cluster.store.secrets.size).toBe(0);
      expect(cluster.store.persistentvolumeclaims.has("claws-session-aa11")).toBe(true);
    });

    it("does not report the terminating pod and PVC of a just-deleted session as orphans", async () => {
      rows.set("aa11", podRow("aa11"));
      for (const r of ["pods", "services", "secrets", "persistentvolumeclaims"] as const) cluster.store[r].set("claws-session-aa11", podObject("aa11"));
      const b = backend();
      expect(await b.remove("aa11")).toEqual({ ok: true });

      // Both objects linger while the pod's grace period runs and the PVC's protection finalizer waits for it.
      for (const r of ["pods", "persistentvolumeclaims"] as const) {
        const obj = podObject("aa11");
        obj.metadata.deletionTimestamp = "2026-09-14T00:00:00Z";
        cluster.store[r].set("claws-session-aa11", obj);
      }
      await b.reconcile();
      expect(mockLog.warn).not.toHaveBeenCalledWith(expect.stringContaining("Orphan session"));
    });

    it("re-checks github-token every pass and patches only when the token changed", async () => {
      rows.set("aa11", podRow("aa11", { capabilities: '["github-auth"]' }));
      cluster.store.pods.set("claws-session-aa11", podObject("aa11"));
      cluster.store.secrets.set("claws-session-aa11", { metadata: { name: "claws-session-aa11" }, data: { "github-token": "b2xk" } });
      const b = backend();

      // Unknown token after a restart → written on the first pass.
      await b.reconcile();
      const secret = () => cluster.store.secrets.get("claws-session-aa11") as unknown as { data: Record<string, string> };
      expect(Buffer.from(secret().data["github-token"], "base64").toString()).toBe("gh-fresh");
      const patches = () => cluster.calls.filter((c) => c.startsWith("PATCH")).length;
      expect(patches()).toBe(1);

      // The cache hands back the same token: checked, not patched.
      await b.reconcile();
      expect(getGithubToken).toHaveBeenCalledTimes(2);
      expect(patches()).toBe(1);

      // A failed PATCH is retried on the next pass rather than remembered as written.
      getGithubToken.mockResolvedValue("gh-newer");
      cluster.fail("PATCH", "secrets", 500);
      await b.reconcile();
      expect(patches()).toBe(2);
      expect(Buffer.from(secret().data["github-token"], "base64").toString()).toBe("gh-fresh");

      cluster.clearFailures();
      await b.reconcile();
      expect(patches()).toBe(3);
      expect(Buffer.from(secret().data["github-token"], "base64").toString()).toBe("gh-newer");
    });

    it("does not re-patch the token create wrote, and patches when the cache rotates it", async () => {
      const b = backend();
      const res = await b.create({ repo: "org/app", mode: "worktree-claude", capabilities: ["github-auth"], provider: "claude", model: null });
      const id = (res as { id: string }).id;
      getGithubToken.mockResolvedValue("gh-initial");
      await b.reconcile();
      expect(cluster.calls.filter((c) => c.startsWith("PATCH"))).toEqual([]);

      getGithubToken.mockResolvedValue("gh-rotated");
      await b.reconcile();
      const secret = cluster.store.secrets.get(`claws-session-${id}`) as unknown as { data: Record<string, string> };
      expect(Buffer.from(secret.data["github-token"], "base64").toString()).toBe("gh-rotated");
    });
  });

  describe("verifyMcpToken (#3056)", () => {
    const mcpSecret = (id: string, token?: string): Obj => ({
      metadata: { name: `claws-session-${id}` },
      data: {
        "terminal-token": Buffer.from("t").toString("base64"),
        ...(token === undefined ? {} : { "mcp-token": Buffer.from(token).toString("base64") }),
      },
    });

    it("accepts the token of a live session created here and denies a wrong one", async () => {
      const b = backend();
      const res = await b.create({ repo: "org/app", mode: "worktree-claude", capabilities: [], provider: "claude", model: null });
      const id = (res as { id: string }).id;
      const token = (await buildLaunch.mock.results[0].value as PodLaunch).mcpToken;
      cluster.calls.splice(0);

      expect(await b.verifyMcpToken!(id, token)).toBe("ok");
      // Cached from the launch: no Secret read.
      expect(cluster.calls).toEqual([]);
      expect(await b.verifyMcpToken!(id, `${token}x`)).toBe("denied");
      expect(await b.verifyMcpToken!(id, "mcp-token-0")).toBe("denied");
      expect(await b.verifyMcpToken!(id, "")).toBe("denied");
    });

    it("denies an ended row, a host-tmux row and an unknown id", async () => {
      rows.set("ended", podRow("ended", { ended_at: 5 }));
      rows.set("host", podRow("host", { backend: "local-tmux" }));
      cluster.store.secrets.set("claws-session-ended", mcpSecret("ended", "tok"));
      cluster.store.secrets.set("claws-session-host", mcpSecret("host", "tok"));
      const b = backend();

      expect(await b.verifyMcpToken!("ended", "tok")).toBe("denied");
      expect(await b.verifyMcpToken!("host", "tok")).toBe("denied");
      expect(await b.verifyMcpToken!("nope", "tok")).toBe("denied");
      expect(cluster.calls).toEqual([]);
    });

    it("reads the token from the Secret after a restart, once", async () => {
      rows.set("aa11", podRow("aa11"));
      cluster.store.secrets.set("claws-session-aa11", mcpSecret("aa11", "restart-token"));
      const b = backend();

      expect(await b.verifyMcpToken!("aa11", "restart-token")).toBe("ok");
      expect(await b.verifyMcpToken!("aa11", "restart-token")).toBe("ok");
      expect(await b.verifyMcpToken!("aa11", "other-token")).toBe("denied");
      expect(cluster.calls.filter((c) => c === "GET secrets/claws-session-aa11")).toHaveLength(1);
    });

    it("denies when the Secret or its mcp-token key is gone", async () => {
      rows.set("gone", podRow("gone"));
      rows.set("old", podRow("old"));
      cluster.store.secrets.set("claws-session-old", mcpSecret("old"));
      const b = backend();

      expect(await b.verifyMcpToken!("gone", "tok")).toBe("denied");
      expect(await b.verifyMcpToken!("old", "tok")).toBe("denied");
    });

    it("is unavailable when the Secret read fails with anything but 404, or the database is down", async () => {
      rows.set("aa11", podRow("aa11"));
      cluster.store.secrets.set("claws-session-aa11", mcpSecret("aa11", "tok"));
      cluster.fail("GET", "secrets", 500);
      const b = backend();

      expect(await b.verifyMcpToken!("aa11", "tok")).toBe("unavailable");
      cluster.clearFailures();
      cluster.setUnreachable(true);
      expect(await b.verifyMcpToken!("aa11", "tok")).toBe("unavailable");
      cluster.setUnreachable(false);
      expect(await b.verifyMcpToken!("aa11", "tok")).toBe("ok");

      mockDb.getPersistedSession.mockRejectedValueOnce(new Error("db down"));
      expect(await b.verifyMcpToken!("aa11", "tok")).toBe("unavailable");
    });

    it("revokes the token on End, and replaces it when a terminated pod is resumed", async () => {
      const b = backend();
      const res = await b.create({ repo: "org/app", mode: "worktree-claude", capabilities: [], provider: "claude", model: null });
      const id = (res as { id: string }).id;
      const oldToken = (await buildLaunch.mock.results[0].value as PodLaunch).mcpToken;
      expect(await b.verifyMcpToken!(id, oldToken)).toBe("ok");

      expect(await b.end(id)).toEqual({ ok: true });
      expect(await b.verifyMcpToken!(id, oldToken)).toBe("denied");

      expect(await b.resume(id)).toEqual({ ok: true, id });
      const newToken = (await buildLaunch.mock.results[1].value as PodLaunch).mcpToken;
      expect(newToken).not.toBe(oldToken);
      expect(await b.verifyMcpToken!(id, oldToken)).toBe("denied");
      expect(await b.verifyMcpToken!(id, newToken)).toBe("ok");

      // A restarted Claws reads the new token back from the recreated Secret.
      const restarted = backend();
      expect(await restarted.verifyMcpToken!(id, oldToken)).toBe("denied");
      expect(await restarted.verifyMcpToken!(id, newToken)).toBe("ok");
    });

    it("denies the old token after a pod that failed while its row was open is relaunched", async () => {
      rows.set("aa11", podRow("aa11"));
      cluster.store.persistentvolumeclaims.set("claws-session-aa11", podObject("aa11"));
      cluster.store.pods.set("claws-session-aa11", podObject("aa11", { phase: "Failed", reason: "Evicted" }));
      cluster.store.secrets.set("claws-session-aa11", mcpSecret("aa11", "before-resume"));
      const b = backend();
      expect(await b.verifyMcpToken!("aa11", "before-resume")).toBe("ok");

      expect(await b.resume("aa11")).toEqual({ ok: true, id: "aa11" });
      const newToken = (await buildLaunch.mock.results[0].value as PodLaunch).mcpToken;
      expect(await b.verifyMcpToken!("aa11", "before-resume")).toBe("denied");
      expect(await b.verifyMcpToken!("aa11", newToken)).toBe("ok");
    });
  });

  describe("grantCapability (#3072)", () => {
    const secretName = (id: string) => `claws-session-${id}`;
    const decoded = (id: string, key: string) => {
      const data = (cluster.store.secrets.get(secretName(id)) as unknown as { data: Record<string, string> }).data;
      return data[key] === undefined ? undefined : Buffer.from(data[key], "base64").toString("utf8");
    };

    async function createLive(capabilities: string[] = []): Promise<{ b: ReturnType<typeof backend>; id: string }> {
      const b = backend();
      const res = await b.create({ repo: "org/app", mode: "worktree-claude", capabilities, provider: "claude", model: null });
      const id = (res as { id: string }).id;
      cluster.calls.splice(0);
      return { b, id };
    }

    it("patches every slot in one write, then records the grant", async () => {
      const { b, id } = await createLive(["home-assistant"]);
      let callsAtDbWrite: string[] = [];
      mockDb.updateSessionCapabilities.mockImplementationOnce(async (sid: string, caps: string[]) => {
        callsAtDbWrite = [...cluster.calls];
        rows.set(sid, { ...rows.get(sid)!, capabilities: JSON.stringify(caps) });
      });

      expect(await b.grantCapability(id, "prod-infra")).toEqual({ ok: true, live: true, loadPath: "/etc/claws-workload/granted-env", marker: "# claws-granted: prod-infra", delayed: true });

      expect(cluster.calls).toEqual([`GET secrets/${secretName(id)}`, `PATCH secrets/${secretName(id)}`]);
      expect(callsAtDbWrite).toContain(`PATCH secrets/${secretName(id)}`);
      expect(mockDb.updateSessionCapabilities).toHaveBeenCalledWith(id, ["home-assistant", "prod-infra"]);
      expect(decoded(id, "granted-env")).toBe("# granted\nexport GRANTED_home_assistant='1'\nexport GRANTED_prod_infra='1'\n");
      expect(decoded(id, "granted-kubeconfig-prod-infra")).toBe("prod-kube");
      // Keys outside the slots are untouched.
      expect(decoded(id, "terminal-token")).toBe("term-token");
      const live = await b.getLive(id);
      expect(live.ok && live.session.capabilities).toEqual(["home-assistant", "prod-infra"]);
    });

    it("rolls the Secret back to the previous grant when the database write fails", async () => {
      const { b, id } = await createLive(["home-assistant"]);
      mockDb.updateSessionCapabilities.mockRejectedValueOnce(new Error("db down"));

      expect(await b.grantCapability(id, "prod-infra")).toEqual({ ok: false, reason: "unavailable", detail: "database: Error: db down" });

      expect(cluster.calls.filter((c) => c.startsWith("PATCH"))).toHaveLength(2);
      expect(decoded(id, "granted-env")).toBe("# granted\nexport GRANTED_home_assistant='1'\n");
      expect(decoded(id, "granted-kubeconfig-prod-infra")).toBe("");
      expect(JSON.parse(rows.get(id)!.capabilities!)).toEqual(["home-assistant"]);
    });

    it("writes nothing to the database when the Secret read or the patch fails", async () => {
      const { b, id } = await createLive();

      cluster.fail("GET", "secrets", 500);
      expect(await b.grantCapability(id, "prod-infra")).toMatchObject({ ok: false, reason: "unavailable" });
      expect(cluster.calls.some((c) => c.startsWith("PATCH"))).toBe(false);
      cluster.clearFailures();

      cluster.fail("PATCH", "secrets", 500);
      expect(await b.grantCapability(id, "prod-infra")).toMatchObject({ ok: false, reason: "unavailable" });
      expect(mockDb.updateSessionCapabilities).not.toHaveBeenCalled();
      expect(JSON.parse(rows.get(id)!.capabilities!)).toEqual([]);
      expect(decoded(id, "granted-env")).toBe("# Capabilities granted mid-session are written here by Claws\n");
    });

    it("records the grant for the next resume when the Secret predates the slot keys", async () => {
      rows.set("aa11", podRow("aa11"));
      cluster.store.secrets.set(secretName("aa11"), { metadata: { name: secretName("aa11") }, data: { "terminal-token": Buffer.from("t").toString("base64") } });
      const b = backend();

      expect(await b.grantCapability("aa11", "prod-infra")).toEqual({ ok: true, live: false, loadPath: null, marker: null, delayed: false });
      expect(cluster.calls.some((c) => c.startsWith("PATCH"))).toBe(false);
      expect(mockDb.updateSessionCapabilities).toHaveBeenCalledWith("aa11", ["prod-infra"]);
    });

    it("records the grant for the next resume when the pod never mounted a kubeconfig slot the grant fills", async () => {
      rows.set("aa11", podRow("aa11"));
      cluster.store.secrets.set(secretName("aa11"), { metadata: { name: secretName("aa11") }, data: { "granted-env": "" } });
      const b = backend();

      expect(await b.grantCapability("aa11", "home-assistant")).toMatchObject({ ok: true, live: true });
      expect(await b.grantCapability("aa11", "prod-infra")).toEqual({ ok: true, live: false, loadPath: null, marker: null, delayed: false });
      expect(mockDb.updateSessionCapabilities).toHaveBeenLastCalledWith("aa11", ["home-assistant", "prod-infra"]);
    });

    it("is invalid for a capability that is not live-grantable and not-found for an unknown or ended session", async () => {
      const { b, id } = await createLive(["prod-infra"]);
      rows.set("ended", podRow("ended", { ended_at: 5 }));

      expect(await b.grantCapability(id, "prod-infra")).toMatchObject({ ok: false, reason: "invalid" });
      expect(await b.grantCapability(id, "ssh:nas")).toMatchObject({ ok: false, reason: "invalid" });
      expect(await b.grantCapability("nope", "prod-infra")).toEqual({ ok: false, reason: "not-found" });
      expect(await b.grantCapability("ended", "prod-infra")).toEqual({ ok: false, reason: "not-found" });
      expect(cluster.calls).toEqual([]);
      expect(mockDb.updateSessionCapabilities).not.toHaveBeenCalled();
    });

    it("holds the session lock: End and a second grant are refused until it finishes", async () => {
      rows.set("aa11", podRow("aa11"));
      cluster.store.pods.set(secretName("aa11"), podObject("aa11"));
      cluster.store.secrets.set(secretName("aa11"), { metadata: { name: secretName("aa11") }, data: { "granted-env": "", "granted-kubeconfig-prod-infra": "" } });
      const held = holdCall("GET", `/secrets/${secretName("aa11")}`);
      const b = backend();

      const granting = b.grantCapability("aa11", "prod-infra");
      await vi.waitFor(() => expect(held.reached).toBe(true));
      const busy = { ok: false, reason: "unavailable", detail: "a capability is being granted to this session — try again shortly" };
      expect(await b.end("aa11")).toEqual(busy);
      expect(await b.grantCapability("aa11", "home-assistant")).toEqual(busy);
      expect(cluster.store.pods.has(secretName("aa11"))).toBe(true);

      held.release();
      expect(await granting).toEqual({ ok: true, live: true, loadPath: "/etc/claws-workload/granted-env", marker: "# claws-granted: prod-infra", delayed: true });
      expect(await b.grantCapability("aa11", "home-assistant")).toMatchObject({ ok: true });
      expect(JSON.parse(rows.get("aa11")!.capabilities!)).toEqual(["prod-infra", "home-assistant"]);
    });
  });

  describe("grantDelivery (#3072)", () => {
    const secretName = (id: string) => `claws-session-${id}`;
    const b64 = (v: string) => Buffer.from(v).toString("base64");
    const setSecret = (id: string, data: Record<string, string>) => {
      cluster.store.secrets.set(secretName(id), { metadata: { name: secretName(id) }, data });
    };

    it("reports the granted-env file while the Secret carries the capability's marker", async () => {
      rows.set("aa11", podRow("aa11", { capabilities: JSON.stringify(["prod-infra"]) }));
      setSecret("aa11", { "granted-env": b64("# header\n# claws-granted: prod-infra\nexport KUBECONFIG=/x\n"), "granted-kubeconfig-prod-infra": b64("kube") });
      expect(await backend().grantDelivery("aa11", "prod-infra")).toEqual({
        ok: true, live: true, loadPath: "/etc/claws-workload/granted-env", marker: "# claws-granted: prod-infra", delayed: true,
      });
    });

    it("reports nothing to load once a resume has rewritten the slots without the marker", async () => {
      rows.set("aa11", podRow("aa11", { capabilities: JSON.stringify(["prod-infra"]) }));
      setSecret("aa11", { "granted-env": b64("# header\n"), "granted-kubeconfig-prod-infra": "" });
      expect(await backend().grantDelivery("aa11", "prod-infra")).toEqual({ ok: true, live: true, loadPath: null, marker: null, delayed: false });
    });

    it("reports a grant waiting for a resume when the pod lacks the slots it needs", async () => {
      rows.set("aa11", podRow("aa11", { capabilities: JSON.stringify(["prod-infra", "home-assistant"]) }));
      setSecret("aa11", { "terminal-token": b64("t") });
      expect(await backend().grantDelivery("aa11", "home-assistant")).toEqual({ ok: true, live: false, loadPath: null, marker: null, delayed: false });
      setSecret("aa11", { "granted-env": b64("# header\n") });
      expect(await backend().grantDelivery("aa11", "prod-infra")).toEqual({ ok: true, live: false, loadPath: null, marker: null, delayed: false });
      expect(await backend().grantDelivery("aa11", "home-assistant")).toMatchObject({ ok: true, live: true, loadPath: null });
    });

    it("is not-found for an unknown session and unavailable when the Secret cannot be read", async () => {
      expect(await backend().grantDelivery("nope", "prod-infra")).toEqual({ ok: false, reason: "not-found" });
      rows.set("aa11", podRow("aa11"));
      cluster.fail("GET", "secrets", 500);
      expect(await backend().grantDelivery("aa11", "prod-infra")).toMatchObject({ ok: false, reason: "unavailable" });
    });
  });

  describe("agent status (#3083)", () => {
    it("listLive surfaces the self-reported status from the row, ignoring an unknown value", async () => {
      rows.set("aa11", podRow("aa11", { agent_status: "monitoring", agent_status_updated_at: 1234 }));
      rows.set("bb22", podRow("bb22", { agent_status: "bogus", agent_status_updated_at: 1234 }));
      rows.set("cc33", podRow("cc33"));
      const live = await backend().listLive();
      expect(live.map((s) => [s.id, s.agentStatus, s.agentStatusUpdatedAt])).toEqual([
        ["aa11", "monitoring", 1234],
        ["bb22", null, null],
        ["cc33", null, null],
      ]);
    });

    it("listLive surfaces capabilities from the row's JSON column (#3110)", async () => {
      rows.set("aa11", podRow("aa11", { capabilities: '["home-assistant", "ssh:proxmox"]' }));
      rows.set("bb22", podRow("bb22"));
      const live = await backend().listLive();
      expect(live.map((s) => [s.id, s.capabilities])).toEqual([
        ["aa11", ["home-assistant", "ssh:proxmox"]],
        ["bb22", []],
      ]);
    });

    it("setAgentStatus persists and updates the entry, so the DB-down listLive fallback stays current", async () => {
      rows.set("aa11", podRow("aa11"));
      cluster.store.pods.set("claws-session-aa11", podObject("aa11"));
      const b = backend();
      await b.reconcile();

      expect(await b.setAgentStatus("aa11", "waiting")).toEqual({ ok: true, status: "waiting", updatedAt: 4242 });
      expect(setSessionAgentStatusForSession).toHaveBeenCalledWith("aa11", "waiting");

      mockDb.getAllPersistedSessions.mockRejectedValueOnce(new Error("db down"));
      const live = await b.listLive();
      expect(live.map((s) => [s.id, s.agentStatus, s.agentStatusUpdatedAt])).toEqual([["aa11", "waiting", 4242]]);
    });
  });

  describe("attach and uploads", () => {
    it("distinguish not-found from unavailable", async () => {
      rows.set("ended", podRow("ended", { ended_at: 5 }));
      rows.set("pending", podRow("pending"));
      cluster.store.pods.set("claws-session-pending", podObject("pending", { phase: "Pending" }));
      const b = backend();
      await b.reconcile();

      expect(await b.checkAttach("nope")).toMatchObject({ ok: false, reason: "not-found" });
      expect(await b.checkAttach("ended")).toMatchObject({ ok: false, reason: "not-found" });
      expect(await b.checkAttach("pending")).toMatchObject({ ok: false, reason: "unavailable" });
      expect(await b.getLive("nope")).toMatchObject({ ok: false, reason: "not-found" });
      expect(await b.getLive("pending")).toMatchObject({ ok: true });
      expect(await b.saveUpload("nope", "a.txt", Buffer.from("x"))).toMatchObject({ ok: false, reason: "not-found" });
      expect(await b.saveUpload("pending", "a.txt", Buffer.from("x"))).toMatchObject({ ok: false, reason: "unavailable" });
    });

    it("an unreachable pod makes an upload unavailable", async () => {
      rows.set("aa11", podRow("aa11"));
      cluster.store.pods.set("claws-session-aa11", podObject("aa11"));
      cluster.store.secrets.set("claws-session-aa11", { metadata: { name: "claws-session-aa11" }, data: { "terminal-token": Buffer.from("t").toString("base64") } });
      const b = backend();
      await b.reconcile();
      expect(await b.saveUpload("aa11", "a.txt", Buffer.from("x"))).toMatchObject({ ok: false, reason: "unavailable" });

      // A streamed upload's source is torn down too, so the browser's upload aborts instead of stalling.
      const source = new PassThrough();
      source.write("partial");
      expect(await b.saveUploadStream("aa11", "a.txt", source)).toMatchObject({ ok: false, reason: "unavailable" });
      await vi.waitFor(() => expect(source.destroyed).toBe(true));
    });
  });

  describe("terminal proxy", () => {
    let podServer: http.Server;
    let wss: WebSocketServer;
    let podUrl: string;
    const received: string[] = [];
    let authHeader: string | undefined;

    function fakeClient() {
      const client = Object.assign(new EventEmitter(), {
        readyState: 1,
        send: vi.fn(),
        close: vi.fn(() => {
          if (client.readyState === 3) return;
          client.readyState = 3;
          client.emit("close");
        }),
      });
      return client;
    }

    beforeEach(async () => {
      received.length = 0;
      podServer = http.createServer();
      wss = new WebSocketServer({ server: podServer, path: "/pty" });
      wss.on("connection", (sock, req) => {
        authHeader = req.headers.authorization;
        sock.send(JSON.stringify({ type: "scrollback", data: "hello" }));
        sock.on("message", (m) => received.push(m.toString()));
      });
      await new Promise<void>((resolve) => podServer.listen(0, "127.0.0.1", resolve));
      podUrl = `http://127.0.0.1:${(podServer.address() as { port: number }).port}`;
    });

    afterEach(async () => {
      for (const c of wss.clients) c.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => podServer.close(() => resolve()));
    });

    async function readyBackend(baseUrl: string, extra: { summaryIntervalMs?: number; reconcileIntervalMs?: number } = {}) {
      rows.set("aa11", podRow("aa11"));
      cluster.store.pods.set("claws-session-aa11", podObject("aa11"));
      cluster.store.secrets.set("claws-session-aa11", { metadata: { name: "claws-session-aa11" }, data: { "terminal-token": Buffer.from("tok-123").toString("base64") } });
      const b = createK8sSessionBackend({
        client: createK8sClient({ transport: cluster.transport, saDir }),
        settings, now: () => clock, sleep: async () => {}, podBaseUrl: () => baseUrl, ...extra,
      });
      await b.reconcile();
      return b;
    }

    it("bridges to the pod's /pty with the bearer token and forwards only valid frames", async () => {
      const b = await readyBackend(podUrl);
      const client = fakeClient();
      b.attach("aa11", client as unknown as WsSocket);
      client.emit("message", Buffer.from(JSON.stringify({ type: "resize", cols: 9999, rows: 10 })));
      client.emit("message", Buffer.from("not json"));
      client.emit("message", Buffer.from(JSON.stringify({ type: "evil", data: "x" })));
      client.emit("message", Buffer.from(JSON.stringify({ type: "input", data: "ls\r" })));

      await vi.waitFor(() => expect(received).toHaveLength(2));
      expect(authHeader).toBe("Bearer tok-123");
      expect(received.map((m) => JSON.parse(m).type)).toEqual(["resize", "input"]);
      // Passed through unclamped: the pod's terminal server clamps the size.
      expect(JSON.parse(received[0]).cols).toBe(9999);
      expect(client.send).toHaveBeenCalledWith(JSON.stringify({ type: "scrollback", data: "hello" }));
      expect((await b.listLive())[0].wsConnected).toBe(true);
      client.emit("close");
      expect((await b.listLive())[0].wsConnected).toBe(false);
    });

    it("prints the unreachable notice and closes 1011 when the pod cannot be reached", async () => {
      const b = await readyBackend("http://127.0.0.1:1");
      const client = fakeClient();
      b.attach("aa11", client as unknown as WsSocket);
      await vi.waitFor(() => expect(client.close).toHaveBeenCalled());
      expect(client.send).toHaveBeenCalledWith(expect.stringContaining("[Session pod unreachable — retrying]"));
      expect(client.close).toHaveBeenCalledWith(1011, expect.any(String));
    });

    it.each([
      [1000, 1000],
      [1001, 1001],
      [4000, 1011],
    ])("when the pod closes the terminal with %i, closes the client with %i", async (podCode, clientCode) => {
      wss.once("connection", (sock) => sock.close(podCode));
      const b = await readyBackend(podUrl);
      const client = fakeClient();
      b.attach("aa11", client as unknown as WsSocket);
      await vi.waitFor(() => expect(client.close).toHaveBeenCalled());

      if (clientCode === 1011) {
        expect(client.send).toHaveBeenCalledWith(expect.stringContaining("[Session pod unreachable — retrying]"));
        expect(client.close).toHaveBeenCalledWith(1011, "Session pod unreachable");
      } else {
        expect(client.close).toHaveBeenCalledWith(clientCode, "Session ended");
        expect(client.send).not.toHaveBeenCalledWith(expect.stringContaining("unreachable"));
      }
    });

    it.each([
      ["the Kubernetes API", () => cluster.setUnreachable(true), "Kubernetes API unreachable"],
      ["the database", () => mockDb.getAllPersistedSessions.mockRejectedValueOnce(new Error("db down")), "session database unreachable"],
    ])("an outage of %s after a healthy pass ends nothing and closes no terminal, and attach recovers", async (_label, breakIt, detail) => {
      const b = await readyBackend(podUrl);
      const client = fakeClient();
      b.attach("aa11", client as unknown as WsSocket);
      await vi.waitFor(() => expect(wss.clients.size).toBe(1));
      expect(await b.checkAttach("aa11")).toEqual({ ok: true });
      const writes = () => cluster.calls.filter((c) => /^(DELETE|PATCH|POST) /.test(c));
      const writesBefore = writes();

      breakIt();
      clock += 60 * 60 * 1000;
      await b.reconcile();
      expect(mockDb.markSessionEnded).not.toHaveBeenCalled();
      expect(writes()).toEqual(writesBefore);
      expect(client.close).not.toHaveBeenCalled();
      expect(await b.checkAttach("aa11")).toEqual({ ok: false, reason: "unavailable", detail });

      cluster.setUnreachable(false);
      await b.reconcile();
      expect(await b.checkAttach("aa11")).toEqual({ ok: true });
      expect(rows.get("aa11")!.ended_at).toBeNull();
      expect(client.close).not.toHaveBeenCalled();
    });

    it("proxies an upload to the pod's /uploads with the bearer token and returns its result", async () => {
      const seen: Array<{ auth?: string; url?: string; body: string }> = [];
      const saved = { ok: true, path: "/home/claws/.claws-session/uploads/a b.txt" };
      let reply = JSON.stringify(saved);
      podServer.on("request", (req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
          seen.push({ auth: req.headers.authorization, url: req.url, body: Buffer.concat(chunks).toString() });
          res.end(reply);
        });
      });
      const b = await readyBackend(podUrl);

      expect(await b.saveUpload("aa11", "a b.txt", Buffer.from("hello"))).toEqual(saved);
      expect(await b.saveUploadStream("aa11", "a b.txt", Readable.from([Buffer.from("str"), Buffer.from("eam")]))).toEqual(saved);
      expect(seen).toEqual([
        { auth: "Bearer tok-123", url: "/uploads?name=a%20b.txt", body: "hello" },
        { auth: "Bearer tok-123", url: "/uploads?name=a%20b.txt", body: "stream" },
      ]);

      reply = "<html>Bad Gateway</html>";
      expect(await b.saveUpload("aa11", "a.txt", Buffer.from("x"))).toMatchObject({ ok: false, reason: "unavailable" });
    });

    it("refuses an oversized upload reply and keeps only the tail of a large scrollback", async () => {
      let reply = "";
      podServer.on("request", (_req, res) => res.end(reply));
      const b = await readyBackend(podUrl);

      reply = JSON.stringify({ ok: true, path: "x".repeat(100_000) });
      expect(await b.saveUpload("aa11", "a.txt", Buffer.from("x"))).toMatchObject({ ok: false, reason: "unavailable" });

      reply = `${"y".repeat(1_000_000)}END`;
      await b.resummarize("aa11");
      const entry = vi.mocked(summarizeSession).mock.calls[0][0] as unknown as { scrollback: string };
      expect(entry.scrollback).toHaveLength(50_000);
      expect(entry.scrollback.endsWith("END")).toBe(true);
    });

    it("sends exit to open terminals when the session is ended, then closes the upstream", async () => {
      const b = await readyBackend(podUrl);
      const client = fakeClient();
      b.attach("aa11", client as unknown as WsSocket);
      await vi.waitFor(() => expect(wss.clients.size).toBe(1));
      expect(await b.end("aa11")).toEqual({ ok: true });
      expect(client.send).toHaveBeenCalledWith(JSON.stringify({ type: "exit", code: 0 }));
      expect(client.close).toHaveBeenCalledWith(1000, "Session ended");
      await vi.waitFor(() => expect(wss.clients.size).toBe(0));
      expect(client.close).toHaveBeenCalledTimes(1);
    });

    it("shutdown closes proxied terminals with 1012 and their upstreams, deleting nothing", async () => {
      const b = await readyBackend(podUrl);
      const client = fakeClient();
      b.attach("aa11", client as unknown as WsSocket);
      await vi.waitFor(() => expect(wss.clients.size).toBe(1));
      await b.shutdown();

      expect(client.close).toHaveBeenCalledWith(1012, "Claws restarting");
      await vi.waitFor(() => expect(wss.clients.size).toBe(0));
      expect(cluster.calls.some((c) => c.startsWith("DELETE"))).toBe(false);
      expect(cluster.store.pods.size).toBe(1);
    });

    it("fetches scrollback for the summariser only when a summary could still change", async () => {
      const scrollbackAuth: string[] = [];
      podServer.on("request", (req, res) => {
        scrollbackAuth.push(String(req.headers.authorization));
        res.end("some output");
      });
      rows.set("pinned", podRow("pinned", { summary: "Fixing the login page", summary_manual: 1 }));
      rows.set("done", podRow("done", { summary: "Fixing the login page" }));
      for (const id of ["pinned", "done"]) {
        cluster.store.pods.set(`claws-session-${id}`, podObject(id));
        cluster.store.secrets.set(`claws-session-${id}`, { metadata: { name: `claws-session-${id}` }, data: { "terminal-token": Buffer.from(`tok-${id}`).toString("base64") } });
      }
      const b = await readyBackend(podUrl, { summaryIntervalMs: 5, reconcileIntervalMs: 60_000 });
      await b.start();
      try {
        // One pass checks every entry, so pinned and done have been skipped by the time aa11 is summarised.
        await vi.waitFor(() => expect(summarizeSession).toHaveBeenCalled());
      } finally {
        await b.shutdown();
      }
      expect(new Set(scrollbackAuth)).toEqual(new Set(["Bearer tok-123"]));
    });
  });

});
