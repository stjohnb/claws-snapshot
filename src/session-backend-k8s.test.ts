import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { EventEmitter } from "node:events";
import { PassThrough, Readable } from "node:stream";
import { WebSocketServer, type WebSocket as WsSocket } from "ws";
import type { K8sRequest, K8sResponse } from "./k8s/api.js";
import type { PersistedSession, SessionAttachmentRow } from "./db.js";
import type { MountedGrants } from "./session-pod/terminal-server.js";

const { rows, attachments, mockDb, mockLog, mockListRepos, claudeAccounts } = vi.hoisted(() => {
  const rows = new Map<string, PersistedSession>();
  /** Claude accounts with a token, and the held or auth-expired ones among them. */
  const claudeAccounts = { list: [] as Array<{ id: string; label: string }>, held: new Set<string>() };
  const attachments = new Map<string, SessionAttachmentRow>();
  const mockDb = {
    insertSession: vi.fn(async (row: Record<string, unknown>) => {
      rows.set(row.id as string, {
        ended_at: null, resume_repos: null, summary_manual: 0, backend: null, ...row, launched_at: row.created_at,
        startup_state: null, startup_step: null, startup_detail: null, startup_started_at: row.created_at as number,
        startup_updated_at: row.created_at as number, startup_ready_at: null, startup_failed_at: null, startup_failure: null,
        exit_code: null, last_output: null,
      } as PersistedSession);
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
      if (r) rows.set(id, { ...r, ended_at: null, exit_code: null, last_output: null, ...(launchedAt === undefined ? {} : { launched_at: launchedAt }) });
    }),
    recordSessionExit: vi.fn(async (id: string, exitCode: number | null, lastOutput: string | null) => {
      const r = rows.get(id);
      if (r) rows.set(id, { ...r, exit_code: exitCode, last_output: lastOutput });
    }),
    markSessionInitialPromptSent: vi.fn(async (id: string, at: number) => {
      const r = rows.get(id);
      if (!r || r.initial_prompt_sent_at != null) return false;
      rows.set(id, { ...r, initial_prompt_sent_at: at });
      return true;
    }),
    deletePersistedSession: vi.fn(async (id: string) => {
      rows.delete(id);
      for (const [aid, a] of attachments) if (a.session_id === id) attachments.delete(aid);
    }),
    getSessionAttachment: vi.fn(async (id: string) => attachments.get(id)),
    listSessionAttachments: vi.fn(async (sessionId: string) => [...attachments.values()].filter((a) => a.session_id === sessionId)),
    claimPendingSessionAttachments: vi.fn(async (claims: Array<{ id: string; podName: string }>, sessionId: string) => {
      const claimed: SessionAttachmentRow[] = [];
      for (const { id, podName } of claims) {
        const a = attachments.get(id);
        if (!a || a.session_id !== null) continue;
        const row = { ...a, session_id: sessionId, pod_name: podName };
        attachments.set(id, row);
        claimed.push(row);
      }
      return claimed;
    }),
    releaseSessionAttachments: vi.fn(async (sessionId: string) => {
      let n = 0;
      for (const [id, a] of attachments) {
        if (a.session_id === sessionId) { attachments.set(id, { ...a, session_id: null, pod_name: null }); n++; }
      }
      return n;
    }),
    deleteSessionAttachmentsForSession: vi.fn(async (sessionId: string) => {
      let n = 0;
      for (const [id, a] of attachments) if (a.session_id === sessionId) { attachments.delete(id); n++; }
      return n;
    }),
    deleteSessionAttachmentRow: vi.fn(async (id: string) => { attachments.delete(id); }),
    deleteEndedPersistedSession: vi.fn(async (id: string) => rows.get(id)?.ended_at != null && rows.delete(id)),
    getPrunableEndedSessionIds: vi.fn(async () => [] as string[]),
    getSessionsNeedingMemoryCapture: vi.fn(async (maxAttempts: number, limit: number) => [...rows.values()]
      .filter((r) => r.backend === "k8s-pod" && r.ended_at !== null && r.memories_captured_at == null && (r.memory_capture_attempts ?? 0) < maxAttempts)
      .slice(0, limit)),
    setManualSessionSummary: vi.fn(async () => true),
    setSessionClaudeAccount: vi.fn(async (id: string, accountId: string | null) => {
      const r = rows.get(id);
      if (r) rows.set(id, { ...r, claude_account: accountId });
    }),
    updateSessionCapabilities: vi.fn(async (id: string, caps: string[]) => {
      const r = rows.get(id);
      if (r) rows.set(id, { ...r, capabilities: JSON.stringify(caps) });
    }),
    updateSessionUsage: vi.fn(async (id: string, snapshot: { tokensUsed: number; costUsd: number | null; lastContextTokens: number; usageUpdatedAt: number | null }) => {
      const r = rows.get(id);
      if (r) {
        rows.set(id, {
          ...r,
          tokens_used: snapshot.tokensUsed,
          cost_usd: snapshot.costUsd,
          last_context_tokens: snapshot.lastContextTokens,
          usage_updated_at: snapshot.usageUpdatedAt,
        });
      }
    }),
    updateSessionStartup: vi.fn(async (id: string, update: Record<string, unknown>) => {
      const r = rows.get(id);
      if (!r) return false;
      // Same optimistic-concurrency guard as the real one: a write derived from a row that has
      // since been written by someone else is a no-op.
      if (update.expectUpdatedAt !== undefined && r.startup_updated_at !== update.expectUpdatedAt) return false;
      rows.set(id, {
        ...r,
        ...("state" in update ? { startup_state: update.state as string | null } : {}),
        ...("step" in update ? { startup_step: update.step as string | null } : {}),
        ...("detail" in update ? { startup_detail: update.detail as string | null } : {}),
        ...("startedAt" in update ? { startup_started_at: update.startedAt as number | null } : {}),
        ...("updatedAt" in update ? { startup_updated_at: update.updatedAt as number | null } : {}),
        ...("readyAt" in update ? { startup_ready_at: update.readyAt as number | null } : {}),
        ...("failedAt" in update ? { startup_failed_at: update.failedAt as number | null } : {}),
        ...("failure" in update ? { startup_failure: update.failure as string | null } : {}),
        ...(update.clearFailure ? { startup_failed_at: null, startup_failure: null } : {}),
      });
      return true;
    }),
  };
  return {
    rows,
    attachments,
    claudeAccounts,
    mockDb,
    mockLog: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    mockListRepos: vi.fn(),
  };
});

vi.mock("./db.js", () => mockDb);
vi.mock("./log.js", () => mockLog);
vi.mock("./github.js", () => ({ listRepos: mockListRepos }));
vi.mock("./config.js", () => ({
  SESSION_POD_SETTINGS: {},
  WORK_DIR: "/nonexistent/claws-work",
  ATTACHMENTS_S3: null,
  // Agent pods may go off-node; a session pod must not follow them.
  AGENT_POD_SETTINGS: {
    offNode: {
      nodeSelector: {},
      tolerations: [{ key: "node-role.kubernetes.io/gpu", operator: "Equal", value: "true", effect: "NoSchedule" }],
      preferredNodes: ["ryzen", "k3s-nas"],
    },
  },
}));
vi.mock("./shutdown.js", () => ({ isShuttingDown: () => false }));
vi.mock("./claude-accounts.js", () => ({
  accountsWithToken: () => claudeAccounts.list,
  pickClaudeAccount: (exclude?: Set<string>) => claudeAccounts.list.find((a) => !exclude?.has(a.id)) ?? null,
}));
vi.mock("./provider-holds.js", () => ({
  pickClaudeAccount: (opts: { exclude?: ReadonlySet<string> } = {}) =>
    claudeAccounts.list.find((a) => !opts.exclude?.has(a.id) && !claudeAccounts.held.has(a.id)) ?? null,
  providerHoldsStale: () => false,
  refreshProviderHolds: async () => {},
}));
vi.mock("./capabilities.js", () => ({
  BROWSER_CAPABILITY_ID: "browser",
  CLAUDE_AUTH_CAPABILITY_ID: "claude-auth",
  PI_AUTH_CAPABILITY_ID: "pi-auth",
  CAPABILITIES: [{ id: "cross-repo", envKeys: ["CLAWS_FORGEJO_READ_TOKEN"], implicit: true }, { id: "forgejo", envKeys: ["CLAWS_FORGEJO_TOKEN"], implicit: true }, { id: "home-assistant", envKeys: ["HOME_ASSISTANT_TOKEN"] }, { id: "ssh:nas", envKeys: [] }],
  withImplicitCapabilities: (caps: string[]) => [...new Set([...caps, "cross-repo"])],
  liveGrantableCapabilities: (granted: string[], _backend: string, target: { provider: string; mode: string }) =>
    ["forgejo", "home-assistant", "ssh:nas", ...(target.provider === "claude" && target.mode !== "repo-zsh" ? ["browser"] : [])]
      .filter((id) => !granted.includes(id)).map((id) => ({ id, label: id })),
}));
vi.mock("./sessions.js", () => ({
  isIdlePlaceholder: (s: string | null) => s !== null && /^Idle at /.test(s),
  isNumberOnlySummary: () => false,
  providerFromRow: (raw: string | null | undefined) => (raw === "codex" || raw === "opencode" || raw === "pi" ? raw : "claude"),
  setSessionDescription: vi.fn(async (_id: string, d: string) => ({ ok: true, description: d || null })),
  isSessionAgentStatus: (v: unknown) => typeof v === "string" && ["working", "monitoring", "waiting", "done"].includes(v),
  setSessionAgentStatusForSession: vi.fn(async (_id: string, status: string) => ({ ok: true, status, updatedAt: 4242 })),
  summarizeSession: vi.fn(async () => {}),
}));
vi.mock("./session-pod-launch.js", () => ({ buildPodLaunch: vi.fn(), POD_UPLOAD_DIR: "/home/claws/.claws-session/uploads" }));
vi.mock("./session-memory-capture.js", () => ({ MAX_MEMORY_CAPTURE_ATTEMPTS: 3, captureSessionMemories: vi.fn() }));

import { createK8sClient } from "./k8s/api.js";
import { setSessionAgentStatusForSession, summarizeSession } from "./sessions.js";
import { createK8sSessionBackend, GRANT_LANDED_TIMEOUT_MS, RELAUNCH_NOTICE_POLL_MS, RELAUNCH_NOTICE_SETTLE_MS, RELAUNCH_NOTICE_TIMEOUT_MS, SECRET_REVISION_ANNOTATION } from "./session-backend-k8s.js";
import type { PodLaunch, PodLaunchRequest } from "./session-pod-launch.js";

function stagedAttachment(id: string, over: Partial<SessionAttachmentRow> = {}): SessionAttachmentRow {
  const row: SessionAttachmentRow = {
    id, session_id: null, filename: "board.png", pod_name: null, stored_path: `session-attachments/pending/abc123-board.png`,
    storage: "fs", content_type: "image/png", size: 1234, created_at: "2026-10-28 12:00:00", ...over,
  };
  attachments.set(id, row);
  return row;
}

const SAT_A = "sat_01M617FXR2G2Q62972WCFY57HA";
const SAT_B = "sat_01M617FXR2G2Q62972WCFY57HB";
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
  claudeTheme: "auto",
};

let launchCount = 0;

function fakeLaunch(req: PodLaunchRequest): PodLaunch {
  const dir = req.repos[0] ? `/home/claws/work/${req.repos[0]}` : "/home/claws";
  // Like `buildPodLaunch`: the requested account, else the first with a token, for a Claude or pi login.
  const usesAccount = req.capabilities.includes("claude-auth") || req.capabilities.includes("pi-auth");
  const account = usesAccount ? req.claudeAccountId ?? claudeAccounts.list[0]?.id ?? null : null;
  const secretData: Record<string, string> = {
    ...(account ? { "session.env": `CLAUDE_CODE_OAUTH_TOKEN=tok-${account}\n` } : {}),
    "launch.json": JSON.stringify({ sessionId: req.id }),
    "terminal-token": "term-token",
    "mcp-token": `mcp-token-${++launchCount}`,
    "clone-env.json": "{}",
    "granted-env": "# Capabilities granted mid-session are written here by Claws\n",
  };
  return {
    spec: { sessionId: req.id, cwd: dir, command: ["zsh"], uploadDir: "/home/claws/.claws-session/uploads", repos: [], files: [], ssh: [], attachments: [] },
    secretData,
    cwd: dir,
    repoDirs: req.repos.map((repo) => ({ repo, dir: `/home/claws/work/${repo}` })),
    terminalToken: "term-token",
    mcpToken: secretData["mcp-token"],
    claudeAccountId: account,
  };
}

function podRow(id: string, overrides: Partial<PersistedSession> = {}): PersistedSession {
  return {
    id, tmux_name: `claws-${id}`, mode: "worktree-claude", repo: "org/app", cwd: "/home/claws/work/org/app",
    worktree_path: "/home/claws/work/org/app", extra_worktrees: null, capabilities: "[]", created_at: 0,
    summary: null, summary_updated_at: null, ended_at: null, resume_repos: null, provider: "claude",
    summary_manual: 0, model: null, backend: "k8s-pod", agent_status: null, agent_status_updated_at: null, launched_at: null,
    tokens_used: null, cost_usd: null, last_context_tokens: null, usage_updated_at: null,
    startup_state: null, startup_step: null, startup_detail: null, startup_started_at: null, startup_updated_at: null,
    startup_ready_at: null, startup_failed_at: null, startup_failure: null, exit_code: null, last_output: null, mcp_token_sha256: null,
    launched_version: null, brief: null, spawned_by_session: null, spawned_for_issue: null, spawned_from: null, spawned_for_pr: null,
    initial_prompt: null, initial_prompt_sent_at: null,
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

/**
 * A session pod's terminal server for the grant routes, shared by every test.
 * `grants` answers `GET /grants` (null: 404, as on a pod launched before
 * the route existed); `notifyStatus` answers `POST /notify`.
 */
const grantPod = {
  server: null as http.Server | null,
  url: "",
  grants: null as MountedGrants | null | (() => MountedGrants | null),
  notifyStatus: 204,
  requests: [] as Array<{ method: string; path: string; auth: string | undefined; body: string }>,
  reset(): void {
    this.grants = null;
    this.notifyStatus = 204;
    this.requests = [];
  },
};

beforeAll(async () => {
  grantPod.server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c: Buffer) => { body += c.toString(); });
    req.on("end", () => {
      grantPod.requests.push({ method: req.method ?? "", path: req.url ?? "", auth: req.headers.authorization, body });
      if (req.method === "GET" && req.url === "/grants") {
        const grants = typeof grantPod.grants === "function" ? grantPod.grants() : grantPod.grants;
        res.writeHead(grants ? 200 : 404).end(grants ? JSON.stringify(grants) : "not found");
        return;
      }
      if (req.method === "POST" && req.url === "/notify") {
        res.writeHead(grantPod.notifyStatus).end();
        return;
      }
      res.writeHead(404).end();
    });
  });
  await new Promise<void>((resolve) => grantPod.server!.listen(0, "127.0.0.1", resolve));
  grantPod.url = `http://127.0.0.1:${(grantPod.server.address() as { port: number }).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => grantPod.server!.close(() => resolve()));
});

describe("k8s-pod session backend", () => {
  let saDir: string;
  let cluster: ReturnType<typeof fakeCluster>;
  let clock: number;
  let buildLaunch: ReturnType<typeof vi.fn>;
  /** Stands in for the capture pod: stamps the row captured, as `recordSessionMemoryCapture` does. */
  let captureMemories: ReturnType<typeof vi.fn<(id: string, endedAt: number | null) => Promise<{ ok: true; files: number; recorded: boolean } | { ok: false; error: string }>>>;
  let onMemoriesCaptured: ReturnType<typeof vi.fn<() => void>>;

  const outerBackend = (overrides: Partial<Parameters<typeof createK8sSessionBackend>[0]> = {}) => backend(overrides);

  function backend(overrides: Partial<Parameters<typeof createK8sSessionBackend>[0]> = {}) {
    return createK8sSessionBackend({
      client: createK8sClient({ transport: cluster.transport, saDir }),
      settings,
      now: () => clock,
      sleep: async () => {},
      buildLaunch: buildLaunch as unknown as (req: PodLaunchRequest) => Promise<PodLaunch>,
      readServiceSshKeys: () => ({ "ssh-id_ed25519": "SERVICE-ED", "ssh-id_rsa": "SERVICE-RSA" }),
      podBaseUrl: () => "http://127.0.0.1:1",
      podGoneTimeoutMs: 0,
      captureMemories,
      onMemoriesCaptured,
      buildGrantedData: (caps: string[]) => ({
        "granted-env": `# granted\n${caps.map((c) => `export GRANTED_${c.replace(/\W/g, "_")}='1'\n`).join("")}${caps.includes("forgejo") ? "export CLAWS_FORGEJO_TOKEN='forge-token'\n" : ""}`,
      }),
      ...overrides,
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    rows.clear();
    attachments.clear();
    saDir = fs.mkdtempSync(path.join(os.tmpdir(), "claws-k8s-backend-sa-"));
    fs.writeFileSync(path.join(saDir, "token"), "sa-token");
    cluster = fakeCluster();
    clock = 10_000_000;
    buildLaunch = vi.fn(async (req: PodLaunchRequest) => fakeLaunch(req));
    captureMemories = vi.fn(async (id: string, endedAt: number | null) => {
      const r = rows.get(id);
      if (r && r.ended_at === endedAt) rows.set(id, { ...r, memories_captured_at: clock });
      return { ok: true as const, files: 0, recorded: !!r && r.ended_at === endedAt };
    });
    onMemoriesCaptured = vi.fn();
    grantPod.reset();
    mockListRepos.mockResolvedValue([
      { owner: "org", name: "app", fullName: "org/app", defaultBranch: "main" },
      { owner: "org", name: "lib", fullName: "org/lib", defaultBranch: "main" },
    ]);
  });

  afterEach(() => {
    fs.rmSync(saDir, { recursive: true, force: true });
  });

  /**
   * Make the next `updateSessionStartup` recording `state` reject, as a transient DB error would.
   * Restores itself once it has thrown; the returned `restore` is for a test that never hits it.
   */
  function failStartupWrite(state: string): () => void {
    const real = mockDb.updateSessionStartup.getMockImplementation()!;
    const restore = (): void => { mockDb.updateSessionStartup.mockImplementation(real); };
    mockDb.updateSessionStartup.mockImplementation(async (id, update) => {
      if (update.state === state) { restore(); throw new Error("database is locked"); }
      return await real(id, update);
    });
    return restore;
  }

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
      const res = await b.create({ repo: "org/app", mode: "worktree-claude", capabilities: ["home-assistant"], provider: "claude", model: null });

      expect(res.ok).toBe(true);
      const id = (res as { id: string }).id;
      const row = rows.get(id)!;
      expect(row.backend).toBe("k8s-pod");
      expect(row.tmux_name).toBe(`claws-${id}`);
      expect(row.cwd).toBe("/home/claws/work/org/app");
      expect(cluster.calls.filter((c) => c.startsWith("POST"))).toEqual(["POST secrets", "POST persistentvolumeclaims", "POST services", "POST pods"]);

      const secret = cluster.store.secrets.get(`claws-session-${id}`) as unknown as { data: Record<string, string> };
      expect(secret.data).not.toHaveProperty("github-token");
      const pod = cluster.store.pods.get(`claws-session-${id}`) as unknown as { spec: { volumes: Array<{ name: string; secret?: { items: Array<{ key: string }> } }>; nodeSelector: Record<string, string> } };
      const mainItems = pod.spec.volumes.find((v) => v.name === "secret")!.secret!.items.map((i) => i.key);
      expect(mainItems).not.toContain("clone-env.json");
      expect(mainItems).not.toContain("github-token");
      expect(pod.spec.nodeSelector).toEqual({ "kubernetes.io/hostname": "k3s" });
      expect(JSON.stringify(pod)).not.toContain("ownerReferences");

      expect(cluster.calls).not.toContain(`GET pods/claws-session-${id}`);
      expect(await b.getStartupStatus(id)).toMatchObject({ ok: true, status: { state: "ready", step: "Terminal ready" } });
      expect(await b.checkAttach(id)).toEqual({ ok: true });
    });

    it("keeps a session pod pinned to k3s, with no off-node tolerations or affinity, while agent pods may go off-node", async () => {
      const res = await backend().create({ repo: "org/app", mode: "worktree-claude", capabilities: [], provider: "claude", model: null });
      expect(res.ok).toBe(true);
      const pod = cluster.store.pods.get(`claws-session-${(res as { id: string }).id}`) as unknown as { spec: Record<string, unknown> };
      expect(pod.spec.nodeSelector).toEqual({ "kubernetes.io/hostname": "k3s" });
      expect(pod.spec).not.toHaveProperty("tolerations");
      expect(pod.spec).not.toHaveProperty("affinity");
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

    it("still creates every object when the DB blips while recording creation progress", async () => {
      const restore = failStartupWrite("creating");
      const b = backend();
      const res = await b.create({ repo: "org/app", mode: "repo-claude", capabilities: [], provider: "claude", model: null });
      restore();

      // Startup progress is observability; a failed write must not abort a create that is going fine.
      expect(res).toMatchObject({ ok: true });
      for (const r of ["pods", "services", "secrets", "persistentvolumeclaims"] as const) expect(cluster.store[r].size).toBe(1);
      expect(rows.size).toBe(1);
    });

    it("still rolls back what it created when the DB blips while recording the failure", async () => {
      cluster.fail("POST", "services", 403);
      const restore = failStartupWrite("failed");
      const b = backend();
      const res = await b.create({ repo: "org/app", mode: "repo-claude", capabilities: [], provider: "claude", model: null });
      restore();

      // The write that throws sits one line above the rollback; escaping past it would orphan
      // the Secret and PVC this attempt already created.
      expect(res).toMatchObject({ ok: false, reason: "backend-unavailable" });
      for (const r of ["pods", "services", "secrets", "persistentvolumeclaims"] as const) expect(cluster.store[r].size).toBe(0);
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
      expect(await b.getStartupStatus((res as { id: string }).id)).toMatchObject({ ok: true, status: { state: "pending", step: "Waiting for pod to start" } });
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
      expect(await b.createMulti({ repos: ["org/app", "org/lib"], capabilities: [], provider: "pi", model: null }))
        .toMatchObject({ ok: false, reason: "provider-unsupported" });
      expect(await b.createMulti({ repos: ["org/app", "org/app"], capabilities: [], provider: "claude", model: null }))
        .toMatchObject({ ok: false, reason: "too-few-repos" });
      expect(cluster.calls).toEqual([]);

      // repo-zsh normalises to claude with no model.
      const zsh = await b.create({ repo: "org/app", mode: "repo-zsh", capabilities: [], provider: "codex", model: "gpt" });
      expect(zsh.ok).toBe(true);
      expect(buildLaunch).toHaveBeenLastCalledWith(expect.objectContaining({ provider: "claude", model: null, resume: false }));
    });

    it("creates a multi-repo session whose repos span owners, with one Secret", async () => {
      mockListRepos.mockResolvedValue([
        { owner: "org", name: "app", fullName: "org/app", defaultBranch: "main" },
        { owner: "other", name: "tool", fullName: "other/tool", defaultBranch: "main" },
      ]);
      const b = backend();
      const res = await b.createMulti({ repos: ["org/app", "other/tool"], capabilities: [], provider: "claude", model: null });
      expect(res.ok).toBe(true);
      expect(buildLaunch).toHaveBeenCalledWith(expect.objectContaining({ repos: ["org/app", "other/tool"] }));
      expect(cluster.calls.filter((c) => c === "POST secrets")).toHaveLength(1);
    });

    it("creates a multi-repo session with every repo", async () => {
      const b = backend();
      const res = await b.createMulti({ repos: ["org/app", "org/lib", "org/app"], capabilities: [], provider: "claude", model: null });
      expect(res.ok).toBe(true);
      const row = rows.get((res as { id: string }).id)!;
      expect(row.mode).toBe("multi-worktree-claude");
      expect(JSON.parse(row.extra_worktrees!)).toEqual([{ repo: "org/lib", worktreePath: "/home/claws/work/org/lib" }]);
    });

    it("persists a started session's brief and audit fields and launches with the brief", async () => {
      const b = backend();
      const res = await b.create({ repo: "org/app", mode: "worktree-claude", capabilities: [], provider: "claude", model: null, brief: "## Issue brief", spawnedBySession: "abc123", spawnedForIssue: "clw_01M4BD4HVYGHT1AF1Z5XNQ6BGE" });
      expect(res.ok).toBe(true);
      const row = rows.get((res as { id: string }).id)!;
      expect(row).toMatchObject({ brief: "## Issue brief", spawned_by_session: "abc123", spawned_for_issue: "clw_01M4BD4HVYGHT1AF1Z5XNQ6BGE" });
      expect(buildLaunch).toHaveBeenCalledWith(expect.objectContaining({ brief: "## Issue brief", resume: false }));
    });

    it("stores the dashboard Initial prompt on the row and launches with it", async () => {
      const b = backend();
      const res = await b.create({ repo: "org/app", mode: "worktree-claude", capabilities: [], provider: "codex", model: null, initialPrompt: "Fix the build" });
      expect(res.ok).toBe(true);
      expect(rows.get((res as { id: string }).id)).toMatchObject({ initial_prompt: "Fix the build" });
      expect(buildLaunch).toHaveBeenCalledWith(expect.objectContaining({ initialPrompt: "Fix the build", resume: false }));

      const multi = await b.createMulti({ repos: ["org/app", "org/lib"], capabilities: [], provider: "claude", model: null, initialPrompt: "Both repos" });
      expect(rows.get((multi as { id: string }).id)).toMatchObject({ initial_prompt: "Both repos" });
      expect(buildLaunch).toHaveBeenLastCalledWith(expect.objectContaining({ initialPrompt: "Both repos" }));
    });

    it("stores no Initial prompt for a zsh session or an empty field", async () => {
      const b = backend();
      const zsh = await b.create({ repo: "org/app", mode: "repo-zsh", capabilities: [], provider: "claude", model: null, initialPrompt: "ignored" });
      expect(rows.get((zsh as { id: string }).id)!.initial_prompt).toBeNull();
      expect(buildLaunch).toHaveBeenLastCalledWith(expect.objectContaining({ initialPrompt: null }));
      const plain = await b.create({ repo: "org/app", mode: "worktree-claude", capabilities: [], provider: "claude", model: null });
      expect(rows.get((plain as { id: string }).id)!.initial_prompt).toBeNull();
      expect(buildLaunch).toHaveBeenLastCalledWith(expect.objectContaining({ initialPrompt: null }));
    });

    it("claims attached files, names their pod paths after the prompt and launches with them", async () => {
      stagedAttachment(SAT_A, { filename: "board.png", size: 10 });
      stagedAttachment(SAT_B, { filename: "build.log", size: 20 });
      const b = backend();
      const res = await b.create({ repo: "org/app", mode: "worktree-claude", capabilities: [], provider: "claude", model: null, initialPrompt: "Look at these", attachments: [SAT_A, SAT_B] });
      expect(res.ok).toBe(true);
      const id = (res as { id: string }).id;
      const a = attachments.get(SAT_A)!;
      const bRow = attachments.get(SAT_B)!;
      expect(a).toMatchObject({ session_id: id, pod_name: expect.stringMatching(/^[0-9a-f]{6}-board\.png$/) });
      expect(bRow).toMatchObject({ session_id: id, pod_name: expect.stringMatching(/^[0-9a-f]{6}-build\.log$/) });
      const prompt = `Look at these\n\n/home/claws/.claws-session/uploads/${a.pod_name}\n/home/claws/.claws-session/uploads/${bRow.pod_name}`;
      expect(rows.get(id)!.initial_prompt).toBe(prompt);
      expect(buildLaunch).toHaveBeenLastCalledWith(expect.objectContaining({
        initialPrompt: prompt,
        attachments: [{ id: SAT_A, podName: a.pod_name, size: 10 }, { id: SAT_B, podName: bRow.pod_name, size: 20 }],
      }));
    });

    it("sends the attached paths alone when the Initial prompt is empty, on the multi-repo form too", async () => {
      stagedAttachment(SAT_A);
      const res = await backend().createMulti({ repos: ["org/app", "org/lib"], capabilities: [], provider: "claude", model: null, initialPrompt: null, attachments: [SAT_A] });
      const id = (res as { id: string }).id;
      expect(rows.get(id)!.initial_prompt).toBe(`/home/claws/.claws-session/uploads/${attachments.get(SAT_A)!.pod_name}`);
    });

    it("refuses a create naming an unknown or already-claimed file, and keeps no row", async () => {
      stagedAttachment(SAT_A, { session_id: "otherse55", pod_name: "abcdef-board.png" });
      const b = backend();
      expect(await b.create({ repo: "org/app", mode: "worktree-claude", capabilities: [], provider: "claude", model: null, attachments: [SAT_A] }))
        .toEqual({ ok: false, reason: "attachment-unavailable" });
      expect(await b.create({ repo: "org/app", mode: "worktree-claude", capabilities: [], provider: "claude", model: null, attachments: [SAT_B] }))
        .toEqual({ ok: false, reason: "attachment-unavailable" });
      expect(rows.size).toBe(0);
      expect(buildLaunch).not.toHaveBeenCalled();
    });

    it("ignores attached files for a zsh session", async () => {
      stagedAttachment(SAT_A);
      const res = await backend().create({ repo: "org/app", mode: "repo-zsh", capabilities: [], provider: "claude", model: null, attachments: [SAT_A] });
      expect(rows.get((res as { id: string }).id)!.initial_prompt).toBeNull();
      expect(attachments.get(SAT_A)!.session_id).toBeNull();
      expect(buildLaunch).toHaveBeenLastCalledWith(expect.objectContaining({ attachments: [] }));
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

  describe("memory capture", () => {
    /** A capture that marks where it ran in `cluster.calls`, then answers `result`. */
    function markingCapture(result: { ok: true; files: number; recorded: boolean } | { ok: false; error: string } = { ok: true, files: 1, recorded: true }) {
      captureMemories.mockImplementation(async (id: string) => {
        cluster.calls.push(`CAPTURE ${id}`);
        return result;
      });
    }

    it("remove() captures after deleting the pod and before deleting the PVC, then deletes the capture pod", async () => {
      rows.set("aa11", podRow("aa11", { ended_at: 5 }));
      cluster.store.persistentvolumeclaims.set("claws-session-aa11", podObject("aa11"));
      markingCapture();
      const b = backend();

      expect(await b.remove("aa11")).toEqual({ ok: true });

      expect(captureMemories).toHaveBeenCalledWith("aa11", 5);
      const at = (c: string) => cluster.calls.indexOf(c);
      expect(at("CAPTURE aa11")).toBeGreaterThan(at("DELETE pods/claws-session-aa11"));
      expect(at("DELETE pods/claws-session-memory-aa11")).toBeGreaterThan(at("CAPTURE aa11"));
      expect(at("DELETE persistentvolumeclaims/claws-session-aa11")).toBeGreaterThan(at("DELETE pods/claws-session-memory-aa11"));
      expect(cluster.store.persistentvolumeclaims.size).toBe(0);
    });

    it("remove() captures an open session with a NULL ended_at", async () => {
      rows.set("aa11", podRow("aa11"));
      cluster.store.persistentvolumeclaims.set("claws-session-aa11", podObject("aa11"));
      const b = backend();
      expect(await b.remove("aa11")).toEqual({ ok: true });
      expect(captureMemories).toHaveBeenCalledWith("aa11", null);
    });

    it("a failed capture still lets remove() delete the PVC and row", async () => {
      rows.set("aa11", podRow("aa11", { ended_at: 5 }));
      cluster.store.persistentvolumeclaims.set("claws-session-aa11", podObject("aa11"));
      markingCapture({ ok: false, error: "HTTP 403" });
      const b = backend();

      expect(await b.remove("aa11")).toEqual({ ok: true });
      expect(cluster.calls).toContain("CAPTURE aa11");
      expect(cluster.store.persistentvolumeclaims.size).toBe(0);
      expect(rows.has("aa11")).toBe(false);
    });

    it("a capture that throws still lets remove() finish", async () => {
      rows.set("aa11", podRow("aa11", { ended_at: 5 }));
      cluster.store.persistentvolumeclaims.set("claws-session-aa11", podObject("aa11"));
      captureMemories.mockRejectedValueOnce(new Error("boom"));
      expect(await backend().remove("aa11")).toEqual({ ok: true });
      expect(cluster.store.persistentvolumeclaims.size).toBe(0);
    });

    it("skips the capture once a row is captured, has used up its attempts, or has no PVC", async () => {
      rows.set("done", podRow("done", { ended_at: 5, memories_captured_at: 6 }));
      rows.set("tried", podRow("tried", { ended_at: 5, memory_capture_attempts: 3 }));
      rows.set("nopvc", podRow("nopvc", { ended_at: 5 }));
      for (const id of ["done", "tried"]) cluster.store.persistentvolumeclaims.set(`claws-session-${id}`, podObject(id));
      const b = backend();

      for (const id of ["done", "tried", "nopvc"]) expect(await b.remove(id)).toEqual({ ok: true });
      expect(captureMemories).not.toHaveBeenCalled();
      expect(cluster.store.persistentvolumeclaims.size).toBe(0);
    });

    it("keeps the row and PVC when the capture pod cannot be deleted", async () => {
      rows.set("aa11", podRow("aa11", { ended_at: 5 }));
      cluster.store.persistentvolumeclaims.set("claws-session-aa11", podObject("aa11"));
      const transport = cluster.transport;
      cluster.transport = async (req) => (req.method === "DELETE" && req.path.endsWith("/pods/claws-session-memory-aa11")
        ? { status: 500, body: "{}" }
        : transport(req));

      expect(await backend().remove("aa11")).toMatchObject({ ok: false, reason: "unavailable" });
      expect(rows.has("aa11")).toBe(true);
      expect(cluster.store.persistentvolumeclaims.size).toBe(1);
    });

    it("pruning captures before deleting the PVC, and a failed capture still prunes", async () => {
      rows.set("aa11", podRow("aa11"));
      rows.set("old1", podRow("old1", { ended_at: 1 }));
      cluster.store.persistentvolumeclaims.set("claws-session-old1", podObject("old1"));
      mockDb.getPrunableEndedSessionIds.mockResolvedValueOnce(["old1"]);
      markingCapture({ ok: false, error: "capture pod failed" });
      const b = backend();

      await b.end("aa11");
      await vi.waitFor(() => expect(rows.has("old1")).toBe(false));
      const at = (c: string) => cluster.calls.indexOf(c);
      expect(at("CAPTURE old1")).toBeGreaterThan(at("DELETE pods/claws-session-old1"));
      expect(at("DELETE pods/claws-session-memory-old1")).toBeGreaterThan(at("CAPTURE old1"));
      expect(at("DELETE persistentvolumeclaims/claws-session-old1")).toBeGreaterThan(at("DELETE pods/claws-session-memory-old1"));
    });

    it("reconcile captures ended rows whose pod is gone, then runs the backup", async () => {
      rows.set("ended", podRow("ended", { ended_at: 5 }));
      cluster.store.persistentvolumeclaims.set("claws-session-ended", podObject("ended"));
      const b = backend();

      await b.reconcile();

      expect(captureMemories).toHaveBeenCalledWith("ended", 5);
      expect(onMemoriesCaptured).toHaveBeenCalledTimes(1);
      expect(rows.get("ended")!.memories_captured_at).toBe(clock);

      await b.reconcile();
      expect(captureMemories).toHaveBeenCalledTimes(1);
    });

    it("reconcile waits a pass for a row whose pod it listed, and does not run the backup after a failure", async () => {
      rows.set("died", podRow("died", { created_at: 0 }));
      cluster.store.pods.set("claws-session-died", podObject("died", { phase: "Succeeded" }));
      cluster.store.persistentvolumeclaims.set("claws-session-died", podObject("died"));
      const b = backend();

      await b.reconcile();
      expect(rows.get("died")!.ended_at).toBe(clock);
      expect(captureMemories).not.toHaveBeenCalled();
      // The next pass deletes the ended pod it listed; the one after captures.
      await b.reconcile();
      expect(cluster.store.pods.size).toBe(0);
      expect(captureMemories).not.toHaveBeenCalled();

      markingCapture({ ok: false, error: "HTTP 403" });
      await b.reconcile();
      expect(captureMemories).toHaveBeenCalledWith("died", clock);
      expect(onMemoriesCaptured).not.toHaveBeenCalled();
    });

    it("reconcile captures at most two rows a pass and skips a busy id", async () => {
      for (const id of ["r1", "r2", "r3"]) {
        rows.set(id, podRow(id, { ended_at: 5 }));
        cluster.store.persistentvolumeclaims.set(`claws-session-${id}`, podObject(id));
      }
      rows.set("open", podRow("open", { created_at: 0 }));
      cluster.store.pods.set("claws-session-open", podObject("open"));
      // Hold a remove of r1 inside its pod delete, so r1 is busy throughout the pass.
      const held = holdCall("DELETE", "/pods/claws-session-r1");
      const b = backend();
      const removing = b.remove("r1");
      await vi.waitFor(() => expect(held.reached).toBe(true));

      await b.reconcile();
      expect(captureMemories.mock.calls.map((c) => c[0]).sort()).toEqual(["r2", "r3"]);

      held.release();
      expect(await removing).toEqual({ ok: true });
    });

    it("a remove() during a reconcile capture is refused until the capture finishes", async () => {
      rows.set("ended", podRow("ended", { ended_at: 5 }));
      cluster.store.persistentvolumeclaims.set("claws-session-ended", podObject("ended"));
      let finish!: () => void;
      captureMemories.mockImplementationOnce(() => new Promise((resolve) => { finish = () => resolve({ ok: true, files: 0, recorded: true }); }));
      const b = backend();

      const pass = b.reconcile();
      await vi.waitFor(() => expect(captureMemories).toHaveBeenCalled());
      expect(await b.remove("ended")).toEqual({ ok: false, reason: "unavailable", detail: "the session's memories are being saved — try again shortly" });
      finish();
      await pass;
      expect(await b.remove("ended")).toEqual({ ok: true });
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

      expect(await b.resume("bb22")).toEqual({ ok: false, reason: "not-resumable", detail: "host tmux sessions can no longer be resumed" });
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
      rows.set("aa11", podRow("aa11", { ended_at: 5, capabilities: '["home-assistant"]' }));
      cluster.store.persistentvolumeclaims.set("claws-session-aa11", podObject("aa11"));
      cluster.store.pods.set("claws-session-aa11", podObject("aa11", { phase: "Failed", reason: "Evicted" }));
      cluster.store.secrets.set("claws-session-aa11", podObject("aa11"));
      const b = backend();

      expect(await b.resume("aa11")).toEqual({ ok: true, id: "aa11" });
      expect(buildLaunch).toHaveBeenCalledWith(expect.objectContaining({ id: "aa11", resume: true, repos: ["org/app"], capabilities: ["home-assistant", "cross-repo"] }));
      expect(cluster.calls).not.toContain("POST persistentvolumeclaims");
      expect(cluster.calls.filter((c) => c.startsWith("POST"))).toEqual(["POST secrets", "POST services", "POST pods"]);
      expect(rows.get("aa11")!.ended_at).toBeNull();
    });

    it("relaunches with the brief on the row", async () => {
      rows.set("aa11", podRow("aa11", { ended_at: 5, brief: "## Issue brief" }));
      cluster.store.persistentvolumeclaims.set("claws-session-aa11", podObject("aa11"));
      const b = backend();

      expect(await b.resume("aa11")).toEqual({ ok: true, id: "aa11" });
      expect(buildLaunch).toHaveBeenCalledWith(expect.objectContaining({ id: "aa11", resume: true, brief: "## Issue brief" }));
    });

    it.each([
      ["an undelivered prompt", null, "Fix the build"],
      ["an already-delivered prompt", 42, null],
    ])("relaunches with %s carried only while it is unsent", async (_label, sentAt, expected) => {
      rows.set("aa11", podRow("aa11", { ended_at: 5, initial_prompt: "Fix the build", initial_prompt_sent_at: sentAt }));
      cluster.store.persistentvolumeclaims.set("claws-session-aa11", podObject("aa11"));
      const b = backend();

      expect(await b.resume("aa11")).toEqual({ ok: true, id: "aa11" });
      expect(buildLaunch).toHaveBeenCalledWith(expect.objectContaining({ id: "aa11", resume: true, initialPrompt: expected }));
    });

    it("fetches attached files again on a relaunch before the prompt is delivered", async () => {
      rows.set("aa11", podRow("aa11", { ended_at: 5, initial_prompt: "Fix the build\n\n/x", initial_prompt_sent_at: null }));
      stagedAttachment(SAT_A, { session_id: "aa11", pod_name: "abcdef-board.png", size: 7 });
      cluster.store.persistentvolumeclaims.set("claws-session-aa11", podObject("aa11"));
      expect(await backend().resume("aa11")).toEqual({ ok: true, id: "aa11" });
      expect(buildLaunch).toHaveBeenCalledWith(expect.objectContaining({ attachments: [{ id: SAT_A, podName: "abcdef-board.png", size: 7 }] }));
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

    it("marks an Initial prompt sent once, the first time the pod reads ready", async () => {
      rows.set("ead1", podRow("ead1", { created_at: 0, initial_prompt: "Fix the build" }));
      rows.set("b1a1", podRow("b1a1", { created_at: 0 }));
      cluster.store.pods.set("claws-session-ead1", podObject("ead1"));
      cluster.store.pods.set("claws-session-b1a1", podObject("b1a1"));
      const b = backend();
      await b.reconcile();
      expect(rows.get("ead1")!.initial_prompt_sent_at).toBe(clock);
      expect(rows.get("b1a1")!.initial_prompt_sent_at).toBeNull();

      clock += 1_000;
      await b.reconcile();
      await b.getStartupStatus("ead1");
      expect(rows.get("ead1")!.initial_prompt_sent_at).toBe(clock - 1_000);
      expect(mockDb.markSessionInitialPromptSent).toHaveBeenCalledTimes(1);
    });

    it("deletes a session's staged files once its Initial prompt is marked delivered", async () => {
      rows.set("ead1", podRow("ead1", { created_at: 0, initial_prompt: "/home/claws/.claws-session/uploads/abcdef-board.png" }));
      stagedAttachment(SAT_A, { session_id: "ead1", pod_name: "abcdef-board.png" });
      stagedAttachment(SAT_B);
      cluster.store.pods.set("claws-session-ead1", podObject("ead1"));
      await backend().reconcile();
      expect(rows.get("ead1")!.initial_prompt_sent_at).toBe(clock);
      expect(attachments.has(SAT_A)).toBe(false);
      expect(attachments.has(SAT_B)).toBe(true);
    });

    it("leaves an Initial prompt pending while the pod is not ready, and marks it from a startup-status read", async () => {
      rows.set("5a01", podRow("5a01", { created_at: clock - 1_000, initial_prompt: "Fix the build" }));
      cluster.store.pods.set("claws-session-5a01", podObject("5a01", { phase: "Pending" }));
      const b = backend();
      expect(await b.getStartupStatus("5a01")).toMatchObject({ ok: true, status: { state: "pending" } });
      expect(rows.get("5a01")!.initial_prompt_sent_at).toBeNull();

      cluster.store.pods.set("claws-session-5a01", podObject("5a01"));
      expect(await b.getStartupStatus("5a01")).toMatchObject({ ok: true, status: { state: "ready" } });
      expect(rows.get("5a01")!.initial_prompt_sent_at).toBe(clock);
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

    it("samples ready Claude pod usage and updates the DB row", async () => {
      const usage = {
        tokensUsed: 1234,
        costUsd: 0.42,
        lastContextTokens: 98_765,
        usageUpdatedAt: clock + 7,
        warningLevel: "warn",
      };
      const requests: Array<{ url: string | undefined; authorization: string | undefined }> = [];
      const server = http.createServer((req, res) => {
        requests.push({ url: req.url, authorization: req.headers.authorization });
        if (req.method !== "GET" || req.url !== "/usage") {
          res.writeHead(404).end();
          return;
        }
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(usage));
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("test server did not bind a TCP port");
      const b = backend({
        podBaseUrl: () => `http://127.0.0.1:${address.port}`,
        reconcileIntervalMs: 60_000,
        summaryIntervalMs: 60_000,
        usageIntervalMs: 5,
      });
      try {
        const created = await b.create({ repo: "org/app", mode: "repo-claude", capabilities: [], provider: "claude", model: null });
        expect(created.ok).toBe(true);
        const id = (created as { id: string }).id;

        await b.start();
        await vi.waitFor(() => expect(mockDb.updateSessionUsage).toHaveBeenCalledWith(id, expect.objectContaining(usage)));

        expect(requests).toContainEqual({ url: "/usage", authorization: "Bearer term-token" });
        expect(rows.get(id)).toMatchObject({
          tokens_used: usage.tokensUsed,
          cost_usd: usage.costUsd,
          last_context_tokens: usage.lastContextTokens,
          usage_updated_at: usage.usageUpdatedAt,
        });
      } finally {
        await b.shutdown();
        await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
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

    it("leaves a pre-upgrade pod's github-token slot alone: no mint, no patch", async () => {
      rows.set("aa11", podRow("aa11", { capabilities: '["github-auth"]' }));
      cluster.store.pods.set("claws-session-aa11", podObject("aa11"));
      cluster.store.secrets.set("claws-session-aa11", { metadata: { name: "claws-session-aa11" }, data: { "github-token": "b2xk" } });
      const b = backend();

      await b.reconcile();
      await b.reconcile();
      expect(cluster.calls.filter((c) => c.startsWith("PATCH"))).toEqual([]);
      const secret = cluster.store.secrets.get("claws-session-aa11") as unknown as { data: Record<string, string> };
      expect(secret.data["github-token"]).toBe("b2xk");
      expect(cluster.store.pods.has("claws-session-aa11")).toBe(true);
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

  describe("recordPodExit (#3311)", () => {
    const terminalSecret = (id: string, token: string): Obj => ({
      metadata: { name: `claws-session-${id}` },
      data: { "terminal-token": Buffer.from(`${token}\n`).toString("base64") },
    });

    it("accepts the session's terminal token and persists the code and stripped output tail", async () => {
      rows.set("aa11", podRow("aa11"));
      cluster.store.secrets.set("claws-session-aa11", terminalSecret("aa11", "term-tok"));
      const b = backend();

      const output = `${"x".repeat(60_000)}\u001b[31mError: EACCES\u001b[0m`;
      expect(await b.recordPodExit("aa11", "term-tok", { code: 2, scrollback: output })).toBe("ok");
      const row = rows.get("aa11")!;
      expect(row.exit_code).toBe(2);
      expect(row.last_output).toHaveLength(50_000);
      expect(row.last_output!.endsWith("xError: EACCES")).toBe(true);
    });

    it("stores an empty output as null", async () => {
      rows.set("aa11", podRow("aa11"));
      cluster.store.secrets.set("claws-session-aa11", terminalSecret("aa11", "term-tok"));
      expect(await backend().recordPodExit("aa11", "term-tok", { code: 0, scrollback: "" })).toBe("ok");
      expect(rows.get("aa11")).toMatchObject({ exit_code: 0, last_output: null });
    });

    it("ends the row at once, deleting its Service and Secret but leaving the pod (#clw_01M52FEC8QSM9P57WWSEBYFB7D)", async () => {
      rows.set("aa11", podRow("aa11"));
      rows.set("bb22", podRow("bb22"));
      for (const id of ["aa11", "bb22"]) {
        cluster.store.secrets.set(`claws-session-${id}`, terminalSecret(id, "term-tok"));
        cluster.store.services.set(`claws-session-${id}`, podObject(id));
        cluster.store.pods.set(`claws-session-${id}`, podObject(id));
      }
      const b = backend();

      expect(await b.recordPodExit("aa11", "term-tok", { code: 0, scrollback: "bye" })).toBe("ok");
      expect(rows.get("aa11")).toMatchObject({ ended_at: clock, startup_state: "ended", startup_step: "Session exited" });
      expect(await b.recordPodExit("bb22", "term-tok", { code: 2, scrollback: "boom" })).toBe("ok");
      expect(rows.get("bb22")).toMatchObject({ ended_at: clock, startup_state: "failed", startup_step: "Session exited with code 2", startup_failure: "process exited" });
      for (const id of ["aa11", "bb22"]) {
        expect(cluster.store.secrets.has(`claws-session-${id}`)).toBe(false);
        expect(cluster.store.services.has(`claws-session-${id}`)).toBe(false);
        expect(cluster.store.pods.has(`claws-session-${id}`)).toBe(true);
      }
      expect(mockDb.markSessionEnded).toHaveBeenCalledTimes(2);
      // A second report for the now-ended row is refused.
      expect(await b.recordPodExit("aa11", "term-tok", { code: 0, scrollback: "" })).toBe("denied");

      // The next reconcile pass deletes the exited pods without ending the rows again.
      for (const id of ["aa11", "bb22"]) cluster.store.pods.set(`claws-session-${id}`, podObject(id, { phase: "Succeeded" }));
      await b.reconcile();
      expect(cluster.store.pods.size).toBe(0);
      expect(mockDb.markSessionEnded).toHaveBeenCalledTimes(2);
    });

    it("leaves the row open for reconcile when another operation holds the session", async () => {
      rows.set("aa11", podRow("aa11"));
      cluster.store.secrets.set("claws-session-aa11", terminalSecret("aa11", "term-tok"));
      cluster.store.pods.set("claws-session-aa11", podObject("aa11"));
      const held = holdCall("DELETE", "/pods/claws-session-aa11");
      const b = backend();

      const ending = b.end("aa11");
      await vi.waitFor(() => expect(held.reached).toBe(true));
      expect(await b.recordPodExit("aa11", "term-tok", { code: 1, scrollback: "x" })).toBe("ok");
      expect(rows.get("aa11")).toMatchObject({ ended_at: null, exit_code: 1 });
      expect(mockDb.markSessionEnded).not.toHaveBeenCalled();

      held.release();
      expect(await ending).toEqual({ ok: true });
      expect(mockDb.markSessionEnded).toHaveBeenCalledTimes(1);
    });

    it("rejects a wrong token, an ended row, a host-tmux row and an unknown id", async () => {
      rows.set("aa11", podRow("aa11"));
      rows.set("ended", podRow("ended", { ended_at: 5 }));
      rows.set("host", podRow("host", { backend: "local-tmux" }));
      for (const id of ["aa11", "ended", "host"]) cluster.store.secrets.set(`claws-session-${id}`, terminalSecret(id, "term-tok"));
      const b = backend();

      expect(await b.recordPodExit("aa11", "term-tokx", { code: 1, scrollback: "x" })).toBe("denied");
      expect(await b.recordPodExit("aa11", "", { code: 1, scrollback: "x" })).toBe("denied");
      expect(await b.recordPodExit("ended", "term-tok", { code: 1, scrollback: "x" })).toBe("denied");
      expect(await b.recordPodExit("host", "term-tok", { code: 1, scrollback: "x" })).toBe("denied");
      expect(await b.recordPodExit("nope", "term-tok", { code: 1, scrollback: "x" })).toBe("denied");
      expect(mockDb.recordSessionExit).not.toHaveBeenCalled();
    });

    it("denies when the Secret is gone and is unavailable when it cannot be read", async () => {
      rows.set("aa11", podRow("aa11"));
      const b = backend();
      expect(await b.recordPodExit("aa11", "term-tok", { code: 1, scrollback: "x" })).toBe("denied");

      cluster.store.secrets.set("claws-session-aa11", terminalSecret("aa11", "term-tok"));
      cluster.fail("GET", "secrets", 500);
      expect(await b.recordPodExit("aa11", "term-tok", { code: 1, scrollback: "x" })).toBe("unavailable");
      cluster.clearFailures();
      mockDb.getPersistedSession.mockRejectedValueOnce(new Error("db down"));
      expect(await b.recordPodExit("aa11", "term-tok", { code: 1, scrollback: "x" })).toBe("unavailable");
      expect(await b.recordPodExit("aa11", "term-tok", { code: 1, scrollback: "x" })).toBe("ok");
    });
  });

  describe("grantCapability (#3072)", () => {
    const secretName = (id: string) => `claws-session-${id}`;
    const backend = (overrides: Partial<Parameters<typeof createK8sSessionBackend>[0]> = {}) => outerBackend({ podBaseUrl: () => grantPod.url, ...overrides });
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

    it("patches the granted-env slot in one write, then records the grant", async () => {
      const { b, id } = await createLive();
      let callsAtDbWrite: string[] = [];
      mockDb.updateSessionCapabilities.mockImplementationOnce(async (sid: string, caps: string[]) => {
        callsAtDbWrite = [...cluster.calls];
        rows.set(sid, { ...rows.get(sid)!, capabilities: JSON.stringify(caps) });
      });

      // A pod launched before `GET /grants` keeps the sourcing guidance.
      expect(await b.grantCapability(id, "home-assistant")).toEqual({ ok: true, live: true, loadPath: "/etc/claws-workload/granted-env", marker: "# claws-granted: home-assistant", delayed: true, landed: true, restarted: false });

      expect(cluster.calls).toEqual([`GET secrets/${secretName(id)}`, `PATCH secrets/${secretName(id)}`, `PATCH pods/${secretName(id)}`]);
      expect(callsAtDbWrite).toContain(`PATCH secrets/${secretName(id)}`);
      expect(mockDb.updateSessionCapabilities).toHaveBeenCalledWith(id, ["cross-repo", "home-assistant"]);
      expect(decoded(id, "granted-env")).toBe("# granted\nexport GRANTED_cross_repo='1'\nexport GRANTED_home_assistant='1'\n");
      // Keys outside the slots are untouched.
      expect(decoded(id, "terminal-token")).toBe("term-token");
      const live = await b.getLive(id);
      expect(live.ok && live.session.capabilities).toEqual(["cross-repo", "home-assistant"]);
    });

    it("patches Forgejo grant slots and records the live grant", async () => {
      const { b, id } = await createLive();

      expect(await b.grantCapability(id, "forgejo")).toEqual({ ok: true, live: true, loadPath: "/etc/claws-workload/granted-env", marker: "# claws-granted: forgejo", delayed: true, landed: true, restarted: false });

      expect(cluster.calls).toEqual([`GET secrets/${secretName(id)}`, `PATCH secrets/${secretName(id)}`, `PATCH pods/${secretName(id)}`]);
      expect(decoded(id, "granted-env")).toBe("# granted\nexport GRANTED_cross_repo='1'\nexport GRANTED_forgejo='1'\nexport CLAWS_FORGEJO_TOKEN='forge-token'\n");
      expect(mockDb.updateSessionCapabilities).toHaveBeenCalledWith(id, ["cross-repo", "forgejo"]);
      const live = await b.getLive(id);
      expect(live.ok && live.session.capabilities).toEqual(["cross-repo", "forgejo"]);
    });

    it("rolls the Secret back to the previous grant when the database write fails", async () => {
      const { b, id } = await createLive();
      mockDb.updateSessionCapabilities.mockRejectedValueOnce(new Error("db down"));

      expect(await b.grantCapability(id, "home-assistant")).toEqual({ ok: false, reason: "unavailable", detail: "database: Error: db down" });

      expect(cluster.calls.filter((c) => c.startsWith("PATCH"))).toHaveLength(2);
      expect(decoded(id, "granted-env")).toBe("# granted\nexport GRANTED_cross_repo='1'\n");
      expect(JSON.parse(rows.get(id)!.capabilities!)).toEqual(["cross-repo"]);
    });

    it("writes nothing to the database when the Secret read or the patch fails", async () => {
      const { b, id } = await createLive();

      cluster.fail("GET", "secrets", 500);
      expect(await b.grantCapability(id, "home-assistant")).toMatchObject({ ok: false, reason: "unavailable" });
      expect(cluster.calls.some((c) => c.startsWith("PATCH"))).toBe(false);
      cluster.clearFailures();

      cluster.fail("PATCH", "secrets", 500);
      expect(await b.grantCapability(id, "home-assistant")).toMatchObject({ ok: false, reason: "unavailable" });
      expect(mockDb.updateSessionCapabilities).not.toHaveBeenCalled();
      expect(JSON.parse(rows.get(id)!.capabilities!)).toEqual(["cross-repo"]);
      expect(decoded(id, "granted-env")).toBe("# Capabilities granted mid-session are written here by Claws\n");
    });

    it("records the grant for the next resume when the Secret predates the slot keys", async () => {
      rows.set("aa11", podRow("aa11"));
      cluster.store.secrets.set(secretName("aa11"), { metadata: { name: secretName("aa11") }, data: { "terminal-token": Buffer.from("t").toString("base64") } });
      const b = backend();

      expect(await b.grantCapability("aa11", "home-assistant")).toEqual({ ok: true, live: false, loadPath: null, marker: null, delayed: false, landed: false, restarted: false });
      expect(cluster.calls.some((c) => c.startsWith("PATCH"))).toBe(false);
      expect(mockDb.updateSessionCapabilities).toHaveBeenCalledWith("aa11", ["cross-repo", "home-assistant"]);
    });

    it("records an ssh:* grant for the next resume, without patching, on a pod launched without SSH key slots", async () => {
      rows.set("aa11", podRow("aa11"));
      cluster.store.secrets.set(secretName("aa11"), { metadata: { name: secretName("aa11") }, data: { "granted-env": "" } });
      const b = backend();

      expect(await b.grantCapability("aa11", "ssh:nas")).toEqual({ ok: true, live: false, loadPath: null, marker: null, delayed: false, landed: false, restarted: false });
      expect(cluster.calls.some((c) => c.startsWith("PATCH"))).toBe(false);
      expect(mockDb.updateSessionCapabilities).toHaveBeenCalledWith("aa11", ["cross-repo", "ssh:nas"]);
      expect(JSON.parse(rows.get("aa11")!.capabilities!)).toEqual(["cross-repo", "ssh:nas"]);
    });

    it("fills the empty SSH key slots with the service keys and reports the grant live and delayed", async () => {
      rows.set("aa11", podRow("aa11"));
      cluster.store.secrets.set(secretName("aa11"), { metadata: { name: secretName("aa11") }, data: { "terminal-token": "dA==", "granted-env": "", "ssh-slots": "MQ==", "ssh-id_ed25519": "", "ssh-id_rsa": "" } });
      const b = backend();

      expect(await b.grantCapability("aa11", "ssh:nas")).toEqual({ ok: true, live: true, loadPath: null, marker: null, delayed: true, landed: true, restarted: false });
      expect(decoded("aa11", "ssh-id_ed25519")).toBe("SERVICE-ED");
      expect(decoded("aa11", "ssh-id_rsa")).toBe("SERVICE-RSA");
      expect(mockDb.updateSessionCapabilities).toHaveBeenCalledWith("aa11", ["cross-repo", "ssh:nas"]);
    });

    it("patches only the slots the pod mounted and the service has a key for", async () => {
      rows.set("aa11", podRow("aa11"));
      cluster.store.secrets.set(secretName("aa11"), { metadata: { name: secretName("aa11") }, data: { "granted-env": "", "ssh-slots": "MQ==", "ssh-id_ed25519": "" } });
      const b = backend({ readServiceSshKeys: () => ({ "ssh-id_ed25519": "SERVICE-ED", "ssh-id_rsa": "SERVICE-RSA" }) });

      expect(await b.grantCapability("aa11", "ssh:nas")).toMatchObject({ ok: true, live: true, delayed: true });
      expect(decoded("aa11", "ssh-id_ed25519")).toBe("SERVICE-ED");
      expect(decoded("aa11", "ssh-id_rsa")).toBeUndefined();
    });

    it("reports a grant to a pod already holding SSH keys as not delayed, keeping the existing hosts", async () => {
      rows.set("aa11", podRow("aa11", { capabilities: JSON.stringify(["ssh:ryzen"]) }));
      cluster.store.secrets.set(secretName("aa11"), {
        metadata: { name: secretName("aa11") },
        data: { "granted-env": "", "ssh-slots": "MQ==", "ssh-id_ed25519": Buffer.from("SERVICE-ED").toString("base64"), "ssh-id_rsa": Buffer.from("SERVICE-RSA").toString("base64") },
      });

      expect(await backend().grantCapability("aa11", "ssh:nas")).toEqual({ ok: true, live: true, loadPath: null, marker: null, delayed: false, landed: true, restarted: false });
      // Nothing changed in the mounted slots, so there is nothing to re-sync.
      expect(cluster.calls.some((c) => c.startsWith("PATCH pods"))).toBe(false);
      expect(decoded("aa11", "ssh-id_ed25519")).toBe("SERVICE-ED");
      expect(mockDb.updateSessionCapabilities).toHaveBeenCalledWith("aa11", ["ssh:ryzen", "cross-repo", "ssh:nas"]);
    });

    it("records a grant on a pod launched before the slot poller for the next resume, even with filled slots", async () => {
      rows.set("aa11", podRow("aa11", { capabilities: JSON.stringify(["ssh:ryzen"]) }));
      cluster.store.secrets.set(secretName("aa11"), {
        metadata: { name: secretName("aa11") },
        data: { "granted-env": "", "ssh-id_ed25519": Buffer.from("SERVICE-ED").toString("base64") },
      });

      expect(await backend().grantCapability("aa11", "ssh:nas")).toEqual({ ok: true, live: false, loadPath: null, marker: null, delayed: false, landed: false, restarted: false });
      expect(cluster.calls.some((c) => c.startsWith("PATCH"))).toBe(false);
    });

    it("fails the grant, recording nothing, when the service has no SSH key to deliver", async () => {
      rows.set("aa11", podRow("aa11"));
      cluster.store.secrets.set(secretName("aa11"), { metadata: { name: secretName("aa11") }, data: { "granted-env": "", "ssh-slots": "MQ==", "ssh-id_ed25519": "", "ssh-id_rsa": "" } });

      expect(await backend({ readServiceSshKeys: () => ({}) }).grantCapability("aa11", "ssh:nas"))
        .toEqual({ ok: false, reason: "unavailable", detail: "the service has no SSH private key to deliver" });
      expect(cluster.calls.some((c) => c.startsWith("PATCH"))).toBe(false);
      expect(mockDb.updateSessionCapabilities).not.toHaveBeenCalled();
    });

    it("rolls the SSH key slots back when the database write fails", async () => {
      rows.set("aa11", podRow("aa11"));
      cluster.store.secrets.set(secretName("aa11"), { metadata: { name: secretName("aa11") }, data: { "granted-env": "", "ssh-slots": "MQ==", "ssh-id_ed25519": "", "ssh-id_rsa": "" } });
      mockDb.updateSessionCapabilities.mockRejectedValueOnce(new Error("db down"));

      expect(await backend().grantCapability("aa11", "ssh:nas")).toEqual({ ok: false, reason: "unavailable", detail: "database: Error: db down" });
      expect(cluster.calls.filter((c) => c.startsWith("PATCH"))).toHaveLength(2);
      expect(decoded("aa11", "ssh-id_ed25519")).toBe("");
      expect(decoded("aa11", "ssh-id_rsa")).toBe("");
    });

    it("is invalid for a capability that is not live-grantable and not-found for an unknown or ended session", async () => {
      const { b, id } = await createLive(["home-assistant"]);
      rows.set("ended", podRow("ended", { ended_at: 5 }));

      expect(await b.grantCapability(id, "home-assistant")).toMatchObject({ ok: false, reason: "invalid" });
      rows.set("cx11", podRow("cx11", { provider: "codex" }));
      expect(await b.grantCapability("cx11", "browser")).toMatchObject({ ok: false, reason: "invalid" });
      expect(await b.grantCapability("nope", "home-assistant")).toEqual({ ok: false, reason: "not-found" });
      expect(await b.grantCapability("ended", "home-assistant")).toEqual({ ok: false, reason: "not-found" });
      expect(cluster.calls).toEqual([]);
      expect(mockDb.updateSessionCapabilities).not.toHaveBeenCalled();
    });

    describe("forcing the pod's Secret re-sync", () => {
      const NONE: MountedGrants = { envMarkers: [], sshKeys: false };
      const HA: MountedGrants = { ...NONE, envMarkers: ["# claws-granted: home-assistant"] };
      /** Bodies of the pod annotation patches, in order. */
      function recordPodPatches(): unknown[] {
        const bodies: unknown[] = [];
        const transport = cluster.transport;
        cluster.transport = async (req) => {
          if (req.method === "PATCH" && req.path.includes("/pods/")) bodies.push(JSON.parse(req.body!));
          return transport(req);
        };
        return bodies;
      }
      const grantsProbes = () => grantPod.requests.filter((r) => r.path === "/grants");

      it("bumps the pod annotation after the Secret PATCH and reports a grant the pod already holds as landed, nothing to source", async () => {
        const patches = recordPodPatches();
        const { b, id } = await createLive();
        grantPod.grants = HA;

        expect(await b.grantCapability(id, "home-assistant")).toEqual({ ok: true, live: true, loadPath: null, marker: null, delayed: false, landed: true, restarted: false });
        expect(cluster.calls).toEqual([`GET secrets/${secretName(id)}`, `PATCH secrets/${secretName(id)}`, `PATCH pods/${secretName(id)}`]);
        expect(patches).toEqual([{ metadata: { annotations: { [SECRET_REVISION_ANNOTATION]: String(clock) } } }]);
        expect(grantsProbes()).toEqual([expect.objectContaining({ method: "GET", auth: "Bearer term-token" })]);
      });

      it("polls until the grant lands, bumping the annotation once more after two seconds", async () => {
        const patches = recordPodPatches();
        const { b, id } = await createLive();
        let probes = 0;
        grantPod.grants = () => (++probes >= 6 ? HA : NONE);

        expect(await b.grantCapability(id, "home-assistant")).toMatchObject({ live: true, landed: true, delayed: false, loadPath: null });
        expect(probes).toBe(6);
        expect(patches).toHaveLength(2);
      });

      it("reports a grant that has not landed by the deadline as not landed, with nothing to source", async () => {
        const patches = recordPodPatches();
        const { b, id } = await createLive();
        grantPod.grants = NONE;

        expect(await b.grantCapability(id, "home-assistant")).toEqual({ ok: true, live: true, loadPath: null, marker: null, delayed: true, landed: false, restarted: false });
        expect(grantsProbes()).toHaveLength(GRANT_LANDED_TIMEOUT_MS / 500 + 1);
        expect(patches).toHaveLength(2);
      });

      it("falls back to the kubelet's schedule when RBAC lacks patch on pods, warning once", async () => {
        const { b, id } = await createLive();
        cluster.fail("PATCH", "pods", 403);
        grantPod.grants = NONE;

        expect(await b.grantCapability(id, "home-assistant")).toEqual({ ok: true, live: true, loadPath: null, marker: null, delayed: true, landed: false, restarted: false });
        expect(grantsProbes()).toHaveLength(1);
        expect(mockDb.updateSessionCapabilities).toHaveBeenCalledWith(id, ["cross-repo", "home-assistant"]);
        expect(await b.grantCapability(id, "forgejo")).toMatchObject({ ok: true, landed: false, restarted: false });
        const rbacWarnings = mockLog.warn.mock.calls.filter(([m]) => String(m).includes("RBAC lacks patch on pods; grants land on the kubelet's schedule"));
        expect(rbacWarnings).toHaveLength(1);
      });

      it("checks ssh:* grants by the pod's key flag", async () => {
        rows.set("aa11", podRow("aa11"));
        cluster.store.secrets.set(secretName("aa11"), { metadata: { name: secretName("aa11") }, data: { "terminal-token": "dA==", "granted-env": "", "ssh-slots": "MQ==", "ssh-id_ed25519": "", "ssh-id_rsa": "" } });
        grantPod.grants = { ...NONE, sshKeys: true };
        expect(await backend().grantCapability("aa11", "ssh:nas")).toMatchObject({ live: true, landed: true, delayed: false });
      });
    });

    describe("browser (#clw_01M4RASNVDKH2YBHZMGR0SM0RA)", () => {
      it("relaunches a claude pod on its storage with --continue and the grant in its launch config", async () => {
        const { b, id } = await createLive();
        buildLaunch.mockClear();

        expect(await b.grantCapability(id, "browser")).toEqual({ ok: true, live: true, loadPath: null, marker: null, delayed: true, landed: false, restarted: true });

        expect(mockDb.updateSessionCapabilities).toHaveBeenCalledWith(id, ["cross-repo", "browser"]);
        expect(buildLaunch).toHaveBeenCalledWith(expect.objectContaining({ id, resume: true, provider: "claude", capabilities: ["cross-repo", "browser"] }));
        const deleted = cluster.calls.filter((c) => c.startsWith("DELETE"));
        expect(deleted).toEqual([`DELETE pods/${secretName(id)}`, `DELETE services/${secretName(id)}`, `DELETE secrets/${secretName(id)}`]);
        // The PVC, and so the conversation, is kept.
        expect(cluster.calls.filter((c) => c.startsWith("POST"))).toEqual(["POST secrets", "POST services", "POST pods"]);
        expect(cluster.store.persistentvolumeclaims.has(secretName(id))).toBe(true);
        expect(rows.get(id)!.ended_at).toBeNull();
        const live = await b.getLive(id);
        expect(live.ok && live.session.capabilities).toEqual(["cross-repo", "browser"]);
      });

      it("is invalid on a codex, opencode, pi or shell session, writing nothing", async () => {
        rows.set("cx11", podRow("cx11", { provider: "codex" }));
        rows.set("oc11", podRow("oc11", { provider: "opencode" }));
        rows.set("pi11", podRow("pi11", { provider: "pi" }));
        rows.set("zs11", podRow("zs11", { mode: "repo-zsh" }));
        const b = backend();
        for (const id of ["cx11", "oc11", "pi11", "zs11"]) {
          expect(await b.grantCapability(id, "browser")).toMatchObject({ ok: false, reason: "invalid" });
        }
        expect(cluster.calls).toEqual([]);
        expect(buildLaunch).not.toHaveBeenCalled();
        expect(mockDb.updateSessionCapabilities).not.toHaveBeenCalled();
      });

      it("restores the previous capability list when the relaunch fails", async () => {
        const { b, id } = await createLive();
        const before = rows.get(id)!.capabilities;
        cluster.fail("POST", "pods", 500);

        const res = await b.grantCapability(id, "browser");
        expect(res).toMatchObject({ ok: false, reason: "unavailable" });
        // The old pod is gone, so the operator is told the agent stopped and how to bring it back.
        expect((res as { detail: string }).detail).toContain("the agent was stopped; resume the session from the sessions list");
        expect(cluster.store.pods.has(secretName(id))).toBe(false);
        expect(rows.get(id)!.capabilities).toBe(before);
        const live = await b.getLive(id);
        expect(live.ok && live.session.capabilities).not.toContain("browser");

        // A resume relaunches it with the restored list.
        buildLaunch.mockClear();
        cluster.clearFailures();
        expect(await b.resume(id)).toMatchObject({ ok: true });
        expect(buildLaunch).toHaveBeenCalledWith(expect.objectContaining({ id, resume: true, capabilities: ["cross-repo"] }));
      });

      it("does not say the agent stopped when the old pod could not be deleted", async () => {
        const { b, id } = await createLive();
        cluster.fail("DELETE", "pods", 500);
        const res = await b.grantCapability(id, "browser");
        expect(res).toMatchObject({ ok: false, reason: "unavailable" });
        expect((res as { detail: string }).detail).not.toContain("the agent was stopped");
        expect(cluster.store.pods.has(secretName(id))).toBe(true);
      });

      it("holds the session lock while relaunching: End and a second grant are refused until it finishes", async () => {
        const id = "aa11";
        rows.set(id, podRow(id));
        cluster.store.pods.set(secretName(id), podObject(id));
        cluster.store.secrets.set(secretName(id), { metadata: { name: secretName(id) }, data: { "terminal-token": "dA==", "granted-env": "" } });
        const held = holdCall("POST", "/pods");
        const b = backend();
        const granting = b.grantCapability(id, "browser");
        await vi.waitFor(() => expect(held.reached).toBe(true));
        const busy = { ok: false, reason: "unavailable", detail: "a capability is being granted to this session — try again shortly" };
        expect(await b.end(id)).toEqual(busy);
        expect(await b.grantCapability(id, "home-assistant")).toEqual(busy);
        held.release();
        expect(await granting).toMatchObject({ ok: true, restarted: true });
        expect(cluster.store.pods.has(secretName(id))).toBe(true);
        expect(await b.grantCapability(id, "home-assistant")).toMatchObject({ ok: true });
      });

      it("a browser session can still be granted other capabilities live", async () => {
        const { b, id } = await createLive(["browser"]);
        expect(await b.grantCapability(id, "home-assistant")).toMatchObject({ ok: true, live: true, restarted: false });
        expect(cluster.calls.filter((c) => c.startsWith("DELETE"))).toEqual([]);
      });
    });

    describe("switchClaudeAccount (#clw_01M623AMK66JB6TBB4PP55Q2V6)", () => {
      beforeEach(() => {
        claudeAccounts.list = [{ id: "a", label: "Work" }, { id: "b", label: "Personal" }, { id: "c", label: "Spare" }];
        claudeAccounts.held = new Set();
      });

      it("relaunches on another account with --continue: the new Secret has its token and not the old one", async () => {
        const { b, id } = await createLive(["claude-auth"]);
        expect(rows.get(id)!.claude_account).toBe("a");
        expect(decoded(id, "session.env")).toContain("tok-a");
        buildLaunch.mockClear();

        expect(await b.switchClaudeAccount(id)).toEqual({ ok: true, from: "a", to: "b" });

        expect(buildLaunch).toHaveBeenCalledWith(expect.objectContaining({ id, resume: true, claudeAccountId: "b" }));
        expect(cluster.calls.filter((c) => c.startsWith("DELETE"))).toEqual([`DELETE pods/${secretName(id)}`, `DELETE services/${secretName(id)}`, `DELETE secrets/${secretName(id)}`]);
        expect(cluster.store.persistentvolumeclaims.has(secretName(id))).toBe(true);
        expect(decoded(id, "session.env")).toContain("tok-b");
        expect(decoded(id, "session.env")).not.toContain("tok-a");
        expect(mockDb.setSessionClaudeAccount).toHaveBeenCalledWith(id, "b");
        expect(rows.get(id)!.claude_account).toBe("b");
        expect(rows.get(id)!.ended_at).toBeNull();
        expect(mockLog.info).toHaveBeenCalledWith(`[sessions-k8s] Switched session ${id} from Claude account a to b`);
        const listed = (await b.listLive()).find((e) => e.id === id);
        expect(listed).toMatchObject({ claudeAccount: { id: "b", label: "Personal" }, accountSwitchable: true, accountSwitchBlocked: null });
      });

      it("skips a held account in favour of an unheld one", async () => {
        const { b, id } = await createLive(["claude-auth"]);
        claudeAccounts.held = new Set(["b"]);
        expect(await b.switchClaudeAccount(id)).toEqual({ ok: true, from: "a", to: "c" });
      });

      it("falls back to a held account when every other one is held", async () => {
        const { b, id } = await createLive(["claude-auth"]);
        claudeAccounts.held = new Set(["b", "c"]);
        expect(await b.switchClaudeAccount(id)).toMatchObject({ ok: true, to: "b" });
      });

      it("switches a pi session with the Anthropic login", async () => {
        const b = backend();
        const res = await b.create({ repo: "org/app", mode: "worktree-claude", capabilities: ["pi-auth"], provider: "pi", model: null });
        const id = (res as { id: string }).id;
        expect(await b.switchClaudeAccount(id)).toEqual({ ok: true, from: "a", to: "b" });
      });

      it("with no other account it is invalid, leaving the pod untouched", async () => {
        claudeAccounts.list = [{ id: "a", label: "Work" }];
        const { b, id } = await createLive(["claude-auth"]);
        buildLaunch.mockClear();
        expect(await b.switchClaudeAccount(id)).toEqual({ ok: false, reason: "invalid", detail: "No other Claude account with a token is configured" });
        expect(cluster.calls).toEqual([]);
        expect(buildLaunch).not.toHaveBeenCalled();
        const listed = (await b.listLive()).find((e) => e.id === id);
        expect(listed).toMatchObject({ claudeAccount: { id: "a", label: "Work" }, accountSwitchable: false, accountSwitchBlocked: "No other Claude account with a token is configured" });
      });

      it("is invalid for a session without a Claude account, writing nothing", async () => {
        rows.set("cx11", podRow("cx11", { provider: "codex", capabilities: JSON.stringify(["claude-auth"]) }));
        rows.set("pi11", podRow("pi11", { provider: "pi" }));
        rows.set("cl11", podRow("cl11"));
        rows.set("zs11", podRow("zs11", { mode: "repo-zsh", capabilities: JSON.stringify(["claude-auth"]) }));
        const b = backend();
        for (const id of ["cx11", "pi11", "cl11", "zs11"]) {
          expect(await b.switchClaudeAccount(id)).toMatchObject({ ok: false, reason: "invalid" });
        }
        expect(cluster.calls).toEqual([]);
        const listed = await b.listLive();
        for (const e of listed) expect(e).toMatchObject({ accountSwitchable: false, accountSwitchBlocked: null });
      });

      it("picks from every account for a row with no recorded account", async () => {
        rows.set("aa11", podRow("aa11", { capabilities: JSON.stringify(["claude-auth"]) }));
        cluster.store.pods.set(secretName("aa11"), podObject("aa11"));
        const b = backend();
        expect((await b.listLive())[0]).toMatchObject({ claudeAccount: null, accountSwitchable: true });
        expect(await b.switchClaudeAccount("aa11")).toEqual({ ok: true, from: null, to: "a" });
        expect(mockLog.info).toHaveBeenCalledWith("[sessions-k8s] Switched session aa11 from Claude account unknown to a");
      });

      it("reports a failed relaunch with the resume hint, leaving the storage and the row open", async () => {
        const { b, id } = await createLive(["claude-auth"]);
        cluster.fail("POST", "pods", 500);
        const res = await b.switchClaudeAccount(id);
        expect(res).toMatchObject({ ok: false, reason: "unavailable" });
        expect((res as { detail: string }).detail).toContain("the agent was stopped; resume the session from the sessions list");
        expect(cluster.store.persistentvolumeclaims.has(secretName(id))).toBe(true);
        expect(mockLog.warn).toHaveBeenCalledWith(expect.stringContaining(`Switching session ${id} from Claude account a to b failed`));
        cluster.clearFailures();
        expect(await b.resume(id)).toMatchObject({ ok: true });
      });

      it("reports unavailable when the launch fell back to the same account", async () => {
        const { b, id } = await createLive(["claude-auth"]);
        // The chosen account's token vanished after the pick, so the launch falls back to the first account.
        buildLaunch.mockImplementationOnce(async (req: PodLaunchRequest) => fakeLaunch({ ...req, claudeAccountId: undefined }));
        mockLog.info.mockClear();
        expect(await b.switchClaudeAccount(id)).toEqual({ ok: false, reason: "unavailable", detail: "the chosen account lost its token during the switch — try again" });
        expect(mockLog.info).not.toHaveBeenCalledWith(expect.stringContaining("Switched session"));
      });

      it("is refused while another operation holds the session, and holds it while switching", async () => {
        const id = "aa11";
        rows.set(id, podRow(id, { capabilities: JSON.stringify(["claude-auth"]), claude_account: "a" }));
        cluster.store.pods.set(secretName(id), podObject(id));
        cluster.store.secrets.set(secretName(id), { metadata: { name: secretName(id) }, data: { "terminal-token": "dA==", "granted-env": "" } });
        const held = holdCall("POST", "/pods");
        const b = backend();
        const switching = b.switchClaudeAccount(id);
        await vi.waitFor(() => expect(held.reached).toBe(true));
        const busy = { ok: false, reason: "unavailable", detail: "this session is being switched to another Claude account — try again shortly" };
        expect(await b.end(id)).toEqual(busy);
        expect(await b.switchClaudeAccount(id)).toEqual(busy);
        expect(await b.grantCapability(id, "home-assistant")).toEqual(busy);
        held.release();
        expect(await switching).toEqual({ ok: true, from: "a", to: "b" });
      });
    });

    it("holds the session lock: End and a second grant are refused until it finishes", async () => {
      rows.set("aa11", podRow("aa11"));
      cluster.store.pods.set(secretName("aa11"), podObject("aa11"));
      cluster.store.secrets.set(secretName("aa11"), { metadata: { name: secretName("aa11") }, data: { "terminal-token": "dA==", "granted-env": "" } });
      const held = holdCall("GET", `/secrets/${secretName("aa11")}`);
      const b = backend();

      const granting = b.grantCapability("aa11", "home-assistant");
      await vi.waitFor(() => expect(held.reached).toBe(true));
      const busy = { ok: false, reason: "unavailable", detail: "a capability is being granted to this session — try again shortly" };
      expect(await b.end("aa11")).toEqual(busy);
      expect(await b.grantCapability("aa11", "forgejo")).toEqual(busy);
      expect(cluster.store.pods.has(secretName("aa11"))).toBe(true);

      held.release();
      expect(await granting).toEqual({ ok: true, live: true, loadPath: "/etc/claws-workload/granted-env", marker: "# claws-granted: home-assistant", delayed: true, landed: true, restarted: false });
      expect(await b.grantCapability("aa11", "forgejo")).toMatchObject({ ok: true });
      expect(JSON.parse(rows.get("aa11")!.capabilities!)).toEqual(["cross-repo", "home-assistant", "forgejo"]);
    });
  });

  describe("revokeCapability", () => {
    const secretName = (id: string) => `claws-session-${id}`;
    const backend = () => outerBackend({ podBaseUrl: () => grantPod.url });
    const b64 = (v: string) => Buffer.from(v).toString("base64");
    const decoded = (id: string, key: string) => {
      const data = (cluster.store.secrets.get(secretName(id)) as unknown as { data: Record<string, string> }).data;
      return data[key] === undefined ? undefined : Buffer.from(data[key], "base64").toString("utf8");
    };
    const setKeys = (id: string, data: Record<string, string> = { "ssh-slots": b64("1"), "ssh-id_ed25519": b64("SERVICE-ED"), "ssh-id_rsa": b64("SERVICE-RSA") }) => {
      cluster.store.secrets.set(secretName(id), { metadata: { name: secretName(id) }, data: { "granted-env": "", ...data } });
    };

    it("empties the SSH key slots when the last ssh:* host is revoked", async () => {
      rows.set("aa11", podRow("aa11", { capabilities: JSON.stringify(["cross-repo", "ssh:nas"]) }));
      setKeys("aa11");

      expect(await backend().revokeCapability("aa11", "ssh:nas")).toEqual({ ok: true, live: true, keysRemoved: true });
      expect(decoded("aa11", "ssh-id_ed25519")).toBe("");
      expect(decoded("aa11", "ssh-id_rsa")).toBe("");
      expect(mockDb.updateSessionCapabilities).toHaveBeenCalledWith("aa11", ["cross-repo"]);
      expect(JSON.parse(rows.get("aa11")!.capabilities!)).toEqual(["cross-repo"]);
    });

    it("forces the pod's re-sync after emptying the slots, and not when the keys stay", async () => {
      rows.set("aa11", podRow("aa11", { capabilities: JSON.stringify(["cross-repo", "ssh:nas"]) }));
      cluster.store.pods.set(secretName("aa11"), podObject("aa11"));
      setKeys("aa11");
      expect(await backend().revokeCapability("aa11", "ssh:nas")).toMatchObject({ ok: true, keysRemoved: true });
      expect(cluster.calls.filter((c) => c.startsWith("PATCH"))).toEqual([`PATCH secrets/${secretName("aa11")}`, `PATCH pods/${secretName("aa11")}`]);

      cluster.calls.splice(0);
      rows.set("aa11", podRow("aa11", { capabilities: JSON.stringify(["ssh:nas", "ssh:ryzen"]) }));
      setKeys("aa11");
      expect(await backend().revokeCapability("aa11", "ssh:nas")).toMatchObject({ ok: true, keysRemoved: false });
      expect(cluster.calls.some((c) => c.startsWith("PATCH pods"))).toBe(false);
    });

    it("keeps the shared keys when another ssh:* host remains", async () => {
      rows.set("aa11", podRow("aa11", { capabilities: JSON.stringify(["ssh:nas", "ssh:ryzen"]) }));
      setKeys("aa11");

      expect(await backend().revokeCapability("aa11", "ssh:nas")).toEqual({ ok: true, live: true, keysRemoved: false });
      expect(cluster.calls.some((c) => c.startsWith("PATCH"))).toBe(false);
      expect(decoded("aa11", "ssh-id_ed25519")).toBe("SERVICE-ED");
      expect(mockDb.updateSessionCapabilities).toHaveBeenCalledWith("aa11", ["ssh:ryzen"]);
    });

    it("records the revoke for the next resume on a pod launched without SSH key slots", async () => {
      rows.set("aa11", podRow("aa11", { capabilities: JSON.stringify(["ssh:nas"]) }));
      setKeys("aa11", {});

      expect(await backend().revokeCapability("aa11", "ssh:nas")).toEqual({ ok: true, live: false, keysRemoved: true });
      expect(cluster.calls.some((c) => c.startsWith("PATCH"))).toBe(false);
      expect(mockDb.updateSessionCapabilities).toHaveBeenCalledWith("aa11", []);
    });

    it("reports a revoke on a pod launched before the slot poller as waiting for a resume, even with filled slots", async () => {
      rows.set("aa11", podRow("aa11", { capabilities: JSON.stringify(["ssh:nas"]) }));
      setKeys("aa11", { "ssh-id_ed25519": b64("SERVICE-ED"), "ssh-id_rsa": b64("SERVICE-RSA") });

      expect(await backend().revokeCapability("aa11", "ssh:nas")).toEqual({ ok: true, live: false, keysRemoved: true });
      expect(cluster.calls.some((c) => c.startsWith("PATCH"))).toBe(false);
      expect(decoded("aa11", "ssh-id_ed25519")).toBe("SERVICE-ED");
    });

    it("restores the SSH key slots when the database write fails", async () => {
      rows.set("aa11", podRow("aa11", { capabilities: JSON.stringify(["ssh:nas"]) }));
      setKeys("aa11");
      mockDb.updateSessionCapabilities.mockRejectedValueOnce(new Error("db down"));

      expect(await backend().revokeCapability("aa11", "ssh:nas")).toEqual({ ok: false, reason: "unavailable", detail: "database: Error: db down" });
      expect(decoded("aa11", "ssh-id_ed25519")).toBe("SERVICE-ED");
      expect(decoded("aa11", "ssh-id_rsa")).toBe("SERVICE-RSA");
    });

    it("is invalid for a non-ssh or unheld capability and not-found for an ended session", async () => {
      rows.set("aa11", podRow("aa11", { capabilities: JSON.stringify(["home-assistant", "ssh:nas"]) }));
      rows.set("ended", podRow("ended", { ended_at: 5, capabilities: JSON.stringify(["ssh:nas"]) }));
      setKeys("aa11");
      const b = backend();

      expect(await b.revokeCapability("aa11", "home-assistant")).toMatchObject({ ok: false, reason: "invalid" });
      expect(await b.revokeCapability("aa11", "ssh:ryzen")).toMatchObject({ ok: false, reason: "invalid" });
      expect(await b.revokeCapability("ended", "ssh:nas")).toEqual({ ok: false, reason: "not-found" });
      expect(mockDb.updateSessionCapabilities).not.toHaveBeenCalled();
    });
  });

  describe("grantDelivery (#3072)", () => {
    const secretName = (id: string) => `claws-session-${id}`;
    const backend = () => outerBackend({ podBaseUrl: () => grantPod.url });
    const b64 = (v: string) => Buffer.from(v).toString("base64");
    const setSecret = (id: string, data: Record<string, string>) => {
      cluster.store.secrets.set(secretName(id), { metadata: { name: secretName(id) }, data });
    };

    it("reports the granted-env file while the Secret carries the capability's marker", async () => {
      rows.set("aa11", podRow("aa11", { capabilities: JSON.stringify(["home-assistant"]) }));
      setSecret("aa11", { "terminal-token": b64("t"), "granted-env": b64("# header\n# claws-granted: home-assistant\nexport HOME_ASSISTANT_TOKEN=x\n") });
      expect(await backend().grantDelivery("aa11", "home-assistant")).toEqual({
        ok: true, live: true, loadPath: "/etc/claws-workload/granted-env", marker: "# claws-granted: home-assistant", delayed: true, landed: true, restarted: false,
      });
    });

    it("reports nothing to load once a resume has rewritten the slots without the marker", async () => {
      rows.set("aa11", podRow("aa11", { capabilities: JSON.stringify(["home-assistant"]) }));
      setSecret("aa11", { "granted-env": b64("# header\n") });
      expect(await backend().grantDelivery("aa11", "home-assistant")).toEqual({ ok: true, live: true, loadPath: null, marker: null, delayed: false, landed: true, restarted: false });
    });

    it("reports a grant waiting for a resume only when the pod lacks the granted-env slot", async () => {
      rows.set("aa11", podRow("aa11", { capabilities: JSON.stringify(["home-assistant"]) }));
      setSecret("aa11", { "terminal-token": b64("t") });
      expect(await backend().grantDelivery("aa11", "home-assistant")).toEqual({ ok: true, live: false, loadPath: null, marker: null, delayed: false, landed: false, restarted: false });
      setSecret("aa11", { "granted-env": b64("# header\n") });
      expect(await backend().grantDelivery("aa11", "home-assistant")).toMatchObject({ ok: true, live: true, loadPath: null });
    });

    it("reports an ssh:* grant as live and delayed only once an SSH key slot is filled", async () => {
      rows.set("aa11", podRow("aa11", { capabilities: JSON.stringify(["ssh:nas"]) }));
      setSecret("aa11", { "granted-env": b64("# header\n") });
      expect(await backend().grantDelivery("aa11", "ssh:nas")).toEqual({ ok: true, live: false, loadPath: null, marker: null, delayed: false, landed: false, restarted: false });
      setSecret("aa11", { "granted-env": b64("# header\n"), "ssh-slots": b64("1"), "ssh-id_ed25519": "", "ssh-id_rsa": "" });
      expect(await backend().grantDelivery("aa11", "ssh:nas")).toEqual({ ok: true, live: false, loadPath: null, marker: null, delayed: false, landed: false, restarted: false });
      // A pod launched before the slot poller has no marker: its filled launch-time slot is never re-read.
      setSecret("aa11", { "granted-env": b64("# header\n"), "ssh-id_ed25519": "", "ssh-id_rsa": b64("key") });
      expect(await backend().grantDelivery("aa11", "ssh:nas")).toEqual({ ok: true, live: false, loadPath: null, marker: null, delayed: false, landed: false, restarted: false });
      setSecret("aa11", { "terminal-token": b64("t"), "granted-env": b64("# header\n"), "ssh-slots": b64("1"), "ssh-id_ed25519": "", "ssh-id_rsa": b64("key") });
      expect(await backend().grantDelivery("aa11", "ssh:nas")).toEqual({ ok: true, live: true, loadPath: null, marker: null, delayed: true, landed: true, restarted: false });
    });

    it("asks a pod that reports its grants whether a mounted grant has landed", async () => {
      rows.set("aa11", podRow("aa11", { capabilities: JSON.stringify(["home-assistant"]) }));
      setSecret("aa11", { "terminal-token": b64("t"), "granted-env": b64("# header\n# claws-granted: home-assistant\n") });
      grantPod.grants = { envMarkers: ["# claws-granted: home-assistant"], sshKeys: false };
      expect(await backend().grantDelivery("aa11", "home-assistant")).toEqual({ ok: true, live: true, loadPath: null, marker: null, delayed: false, landed: true, restarted: false });
      // A pod launched before github-auth was retired still reports githubToken; that is ignored.
      grantPod.grants = { envMarkers: ["# claws-granted: home-assistant"], githubToken: true, sshKeys: false } as MountedGrants;
      expect(await backend().grantDelivery("aa11", "home-assistant")).toMatchObject({ ok: true, landed: true });
      grantPod.grants = { envMarkers: [], githubToken: true, sshKeys: false } as MountedGrants;
      expect(await backend().grantDelivery("aa11", "home-assistant")).toMatchObject({ ok: true, landed: false });
      grantPod.grants = { envMarkers: [], sshKeys: false };
      expect(await backend().grantDelivery("aa11", "home-assistant")).toEqual({ ok: true, live: true, loadPath: null, marker: null, delayed: true, landed: false, restarted: false });
      expect(grantPod.requests.filter((r) => r.path === "/grants")).toHaveLength(4);
      expect(cluster.calls.some((c) => c.startsWith("PATCH"))).toBe(false);
    });

    it("does not ask the pod about a grant injected at launch", async () => {
      rows.set("aa11", podRow("aa11", { capabilities: JSON.stringify(["home-assistant"]) }));
      setSecret("aa11", { "terminal-token": b64("t"), "granted-env": b64("# header\n") });
      grantPod.grants = { envMarkers: [], sshKeys: false };
      expect(await backend().grantDelivery("aa11", "home-assistant")).toMatchObject({ live: true, landed: true, restarted: false });
      expect(grantPod.requests).toEqual([]);
    });

    it("is not-found for an unknown session and unavailable when the Secret cannot be read", async () => {
      expect(await backend().grantDelivery("nope", "home-assistant")).toEqual({ ok: false, reason: "not-found" });
      rows.set("aa11", podRow("aa11"));
      cluster.fail("GET", "secrets", 500);
      expect(await backend().grantDelivery("aa11", "home-assistant")).toMatchObject({ ok: false, reason: "unavailable" });
    });
  });

  describe("notifyAgent", () => {
    async function readyPod() {
      rows.set("aa11", podRow("aa11"));
      cluster.store.pods.set("claws-session-aa11", podObject("aa11"));
      cluster.store.secrets.set("claws-session-aa11", { metadata: { name: "claws-session-aa11" }, data: { "terminal-token": Buffer.from("tok-123").toString("base64") } });
      const b = backend({ podBaseUrl: () => grantPod.url });
      await b.reconcile();
      return b;
    }

    it("POSTs the text to the pod's /notify with the terminal token", async () => {
      const b = await readyPod();
      expect(await b.notifyAgent("aa11", "[Claws] hello")).toBe("ok");
      expect(grantPod.requests).toEqual([{ method: "POST", path: "/notify", auth: "Bearer tok-123", body: "[Claws] hello" }]);
    });

    it("is unsupported on a pod without the route and unreachable otherwise", async () => {
      const b = await readyPod();
      grantPod.notifyStatus = 404;
      expect(await b.notifyAgent("aa11", "x")).toBe("unsupported");
      grantPod.notifyStatus = 503;
      expect(await b.notifyAgent("aa11", "x")).toBe("unreachable");
      expect(await b.notifyAgent("nope", "x")).toBe("unreachable");
      expect(await backend().notifyAgent("aa11", "x")).toBe("unreachable");
    });
  });

  describe("notifyAgentOnceReady (#clw_01M4RASNVDKH2YBHZMGR0SM0RA)", () => {
    function relaunchedPod(sleep: (b: ReturnType<typeof backend>) => Promise<void> = async () => {}) {
      rows.set("aa11", podRow("aa11"));
      cluster.store.pods.set("claws-session-aa11", podObject("aa11"));
      cluster.store.secrets.set("claws-session-aa11", { metadata: { name: "claws-session-aa11" }, data: { "terminal-token": Buffer.from("tok-123").toString("base64") } });
      const sleeps: number[] = [];
      const b: ReturnType<typeof backend> = backend({
        podBaseUrl: () => grantPod.url,
        sleep: async (ms: number) => { sleeps.push(ms); await sleep(b); },
      });
      return { b, sleeps };
    }

    it("waits for the pod to be ready and the agent to settle, then posts the notice once", async () => {
      // The pod is observed ready only by the first poll's reconcile.
      const { b, sleeps } = relaunchedPod(async (backendUnderTest) => { await backendUnderTest.reconcile(); });
      b.notifyAgentOnceReady("aa11", "[Claws] back");
      await vi.waitFor(() => expect(grantPod.requests).toHaveLength(1));
      expect(grantPod.requests[0]).toEqual({ method: "POST", path: "/notify", auth: "Bearer tok-123", body: "[Claws] back" });
      expect(sleeps).toEqual([RELAUNCH_NOTICE_POLL_MS, RELAUNCH_NOTICE_SETTLE_MS]);
      await vi.waitFor(() => expect(mockLog.info).toHaveBeenCalledWith(expect.stringContaining("Told the agent of session aa11")));
    });

    it("retries an unreachable agent three times, then warns", async () => {
      const { b, sleeps } = relaunchedPod();
      await b.reconcile();
      grantPod.notifyStatus = 503;
      b.notifyAgentOnceReady("aa11", "[Claws] back");
      await vi.waitFor(() => expect(mockLog.warn).toHaveBeenCalledWith(expect.stringContaining("Could not tell the agent of session aa11")));
      expect(grantPod.requests.filter((r) => r.path === "/notify")).toHaveLength(4);
      expect(sleeps).toEqual([RELAUNCH_NOTICE_SETTLE_MS, RELAUNCH_NOTICE_POLL_MS, RELAUNCH_NOTICE_POLL_MS, RELAUNCH_NOTICE_POLL_MS]);
    });

    it("gives up with a warning when the pod is never ready", async () => {
      rows.set("aa11", podRow("aa11"));
      cluster.store.pods.set("claws-session-aa11", podObject("aa11", { phase: "Pending" }));
      const sleeps: number[] = [];
      const b = backend({
        podBaseUrl: () => grantPod.url,
        sleep: async (ms: number) => { sleeps.push(ms); clock += ms; },
      });
      await b.reconcile();
      b.notifyAgentOnceReady("aa11", "[Claws] back");
      await vi.waitFor(() => expect(mockLog.warn).toHaveBeenCalledWith(expect.stringContaining("Gave up telling the agent of session aa11")));
      expect(grantPod.requests).toEqual([]);
      expect(sleeps).toEqual(Array(RELAUNCH_NOTICE_TIMEOUT_MS / RELAUNCH_NOTICE_POLL_MS).fill(RELAUNCH_NOTICE_POLL_MS));
    });

    it("stops silently when the session is gone", async () => {
      const sleep = vi.fn(async () => {});
      const b = backend({ podBaseUrl: () => grantPod.url, sleep });
      b.notifyAgentOnceReady("nope", "[Claws] back");
      await vi.waitFor(() => expect(mockDb.getPersistedSession).toHaveBeenCalledWith("nope"));
      await new Promise(setImmediate);
      expect(sleep).not.toHaveBeenCalled();
      expect(grantPod.requests).toEqual([]);
      expect(mockLog.warn).not.toHaveBeenCalled();
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

  describe("startup status (#3198)", () => {
    it("listLive reports the reconcile pass's startup view, with no per-session read or write", async () => {
      rows.set("aa11", podRow("aa11", { created_at: clock - 5_000, launched_at: clock - 5_000 }));
      cluster.store.pods.set("claws-session-aa11", podObject("aa11", {
        phase: "Pending",
        containerStatuses: [{ name: "session", state: { waiting: { reason: "ContainerCreating" } } }],
      }));
      const b = backend();
      await b.reconcile();
      cluster.calls.splice(0);
      mockDb.updateSessionStartup.mockClear();

      const live = await b.listLive();

      expect(live[0].startupStatus).toMatchObject({ state: "pending", step: "Waiting for volume", detail: "ContainerCreating", elapsedMs: 5_000 });
      // The 15s pass already listed every pod; a list render costs no Kubernetes call and no write.
      expect(cluster.calls).toEqual([]);
      expect(mockDb.updateSessionStartup).not.toHaveBeenCalled();

      // The single open terminal's poll is the one caller that may read the pod live.
      await b.getStartupStatus("aa11");
      expect(cluster.calls).toEqual(["GET pods/claws-session-aa11"]);
    });

    it("listLive falls back to what the row recorded before the first reconcile pass", async () => {
      rows.set("aa11", podRow("aa11", {
        created_at: clock - 2_000,
        startup_state: "creating",
        startup_step: "Creating session pod",
        startup_started_at: clock - 2_000,
      }));

      const live = await backend().listLive();

      expect(live[0].startupStatus).toMatchObject({ state: "creating", step: "Creating session pod", elapsedMs: 2_000 });
      expect(cluster.calls).toEqual([]);
    });

    it("reconcile records why it ended a row, even with no client polling the session", async () => {
      rows.set("died", podRow("died", { created_at: 0 }));
      rows.set("done", podRow("done", { created_at: 0 }));
      rows.set("gone", podRow("gone", { created_at: 0 }));
      cluster.store.pods.set("claws-session-died", podObject("died", { phase: "Failed", reason: "Evicted" }));
      cluster.store.pods.set("claws-session-done", podObject("done", {
        phase: "Succeeded",
        containerStatuses: [{ name: "session", state: { terminated: { exitCode: 0 } } }],
      }));

      await backend().reconcile();

      expect(rows.get("died")).toMatchObject({ startup_state: "failed", startup_step: "Session pod failed", startup_failure: "pod failed: Evicted", startup_failed_at: clock });
      expect(rows.get("gone")).toMatchObject({ startup_state: "failed", startup_failure: "pod not found" });
      expect(rows.get("done")).toMatchObject({ startup_state: "ended", startup_step: "Session ended", startup_failure: null });
    });

    it("reconcile captures a pod's fatal log text when its process never reported its own exit (#clw_01M3HHA3KY0AMHDMH6C2F2X34Z)", async () => {
      rows.set("crashed", podRow("crashed", { created_at: 0 }));
      const message = [
        JSON.stringify({ level: "info", msg: "starting" }),
        JSON.stringify({ level: "error", msg: "Terminal server failed to start: tmux new-session failed: command too long" }),
      ].join("\n");
      cluster.store.pods.set("claws-session-crashed", podObject("crashed", {
        phase: "Failed",
        containerStatuses: [{ name: "session", state: { terminated: { exitCode: 1, message } } }],
      }));

      await backend().reconcile();

      expect(rows.get("crashed")).toMatchObject({
        startup_state: "failed",
        startup_failure: "pod failed: exit code 1: Terminal server failed to start: tmux new-session failed: command too long",
        exit_code: null,
        last_output: "[INFO] starting\n[ERROR] Terminal server failed to start: tmux new-session failed: command too long",
      });
    });

    it("does not overwrite a session's own exit report with the pod's termination message", async () => {
      rows.set("reported", podRow("reported", { created_at: 0, exit_code: 3, last_output: "already recorded" }));
      const message = JSON.stringify({ level: "error", msg: "should not appear" });
      cluster.store.pods.set("claws-session-reported", podObject("reported", {
        phase: "Failed",
        containerStatuses: [{ name: "session", state: { terminated: { exitCode: 3, message } } }],
      }));

      await backend().reconcile();

      expect(mockDb.recordSessionExit).not.toHaveBeenCalled();
      expect(rows.get("reported")).toMatchObject({ exit_code: 3, last_output: "already recorded" });
    });

    it("falls back to the exit-code-only message when a failed pod carries no termination message", async () => {
      rows.set("silent", podRow("silent", { created_at: 0 }));
      cluster.store.pods.set("claws-session-silent", podObject("silent", {
        phase: "Failed",
        containerStatuses: [{ name: "session", state: { terminated: { exitCode: 1 } } }],
      }));

      await backend().reconcile();

      expect(mockDb.recordSessionExit).not.toHaveBeenCalled();
      expect(rows.get("silent")).toMatchObject({ startup_failure: "pod failed: exit code 1", exit_code: null, last_output: null });
    });

    it("still ends the row when capturing the pod's fatal log text fails", async () => {
      rows.set("crashed2", podRow("crashed2", { created_at: 0 }));
      const message = JSON.stringify({ level: "error", msg: "boom" });
      cluster.store.pods.set("claws-session-crashed2", podObject("crashed2", {
        phase: "Failed",
        containerStatuses: [{ name: "session", state: { terminated: { exitCode: 1, message } } }],
      }));
      mockDb.recordSessionExit.mockRejectedValueOnce(new Error("db down"));

      await backend().reconcile();

      expect(rows.get("crashed2")).toMatchObject({ ended_at: clock, startup_state: "failed", startup_failure: "pod failed: exit code 1: boom" });
      expect(mockLog.warn).toHaveBeenCalledWith(expect.stringContaining("Failed to keep session crashed2's startup error output"));
    });

    it("reconcile uses the exit code the pod reported (#3311)", async () => {
      rows.set("c3", podRow("c3", { created_at: 0, exit_code: 3, last_output: "boom" }));
      rows.set("c0", podRow("c0", { created_at: 0, exit_code: 0 }));
      cluster.store.pods.set("claws-session-c3", podObject("c3", {
        phase: "Failed",
        containerStatuses: [{ name: "session", state: { terminated: { exitCode: 3, reason: "Error" } } }],
      }));
      cluster.store.pods.set("claws-session-c0", podObject("c0", {
        phase: "Succeeded",
        containerStatuses: [{ name: "session", state: { terminated: { exitCode: 0 } } }],
      }));
      const b = backend();

      await b.reconcile();

      expect(rows.get("c3")).toMatchObject({ startup_state: "failed", startup_step: "Session exited with code 3", exit_code: 3, last_output: "boom" });
      expect(rows.get("c3")!.ended_at).toBe(clock);
      expect(rows.get("c0")).toMatchObject({ startup_state: "ended", startup_step: "Session exited", startup_failure: null });
      expect(await b.getStartupStatus("c3")).toMatchObject({ ok: true, status: { state: "ended", step: "Session exited (code 3)" } });
    });

    it("a status poll landing mid-reconcile cannot wipe the failure reconcile just recorded", async () => {
      rows.set("dead11", podRow("dead11", { created_at: 0 }));
      cluster.store.pods.set("claws-session-dead11", podObject("dead11", { phase: "Failed", reason: "Evicted" }));
      const b = backend();

      let polled: unknown;
      // Reconcile holds `dead11`'s lock from here until it has ended the row; the terminal's
      // once-a-second poll runs inside that window, off a pod read that raced the eviction
      // and still looks healthy. Its write must not land.
      mockDb.markSessionEnded.mockImplementationOnce(async (id: string, endedAt: number, resumeRepos: string | null) => {
        cluster.store.pods.set("claws-session-dead11", podObject("dead11"));
        polled = await b.getStartupStatus("dead11");
        const r = rows.get(id);
        if (r) rows.set(id, { ...r, ended_at: endedAt, resume_repos: resumeRepos });
      });

      await b.reconcile();

      // The poll still gets an answer — it just does not persist one.
      expect(polled).toMatchObject({ ok: true, status: { state: "ready" } });
      expect(rows.get("dead11")).toMatchObject({
        ended_at: clock,
        startup_state: "failed",
        startup_step: "Session pod failed",
        startup_failure: "pod failed: Evicted",
      });
    });

    it("a status poll whose read predates a whole reconcile pass cannot wipe the failure it recorded", async () => {
      rows.set("dead22", podRow("dead22", { created_at: 0, startup_updated_at: 0 }));
      cluster.store.pods.set("claws-session-dead22", podObject("dead22", { phase: "Failed", reason: "Evicted" }));

      // The poll gets the pod as it looked a moment before the eviction, and stalls there.
      // Reconcile then takes the lock, records the eviction and releases it — entirely inside
      // the poll's await window, so the poll finds the lock free again when it resumes and the
      // `busy` check alone cannot stop its stale write. Only the row-version guard can.
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const healthy = podObject("dead22");
      const transport = cluster.transport;
      cluster.transport = async (req) => {
        if (req.method === "GET" && req.path.endsWith("pods/claws-session-dead22")) {
          await gate;
          return { status: 200, body: JSON.stringify(healthy) };
        }
        return await transport(req);
      };

      const b = backend();
      const poll = b.getStartupStatus("dead22");
      await b.reconcile();
      release();

      // The poll still gets an answer off the pod it read — it just does not persist one.
      expect(await poll).toMatchObject({ ok: true, status: { state: "ready" } });
      expect(rows.get("dead22")).toMatchObject({
        ended_at: clock,
        startup_state: "failed",
        startup_failure: "pod failed: Evicted",
      });
    });

    it("a status poll whose write fails still answers with the status it read", async () => {
      rows.set("aa11", podRow("aa11", { created_at: 0 }));
      cluster.store.pods.set("claws-session-aa11", podObject("aa11"));
      mockDb.updateSessionStartup.mockRejectedValueOnce(new Error("db busy"));

      expect(await backend().getStartupStatus("aa11")).toMatchObject({ ok: true, status: { state: "ready", step: "Terminal ready" } });
      expect(mockLog.warn).toHaveBeenCalledWith(expect.stringContaining("Failed to persist derived startup status for session aa11"));
    });

    it("ends the row even when recording the reason fails", async () => {
      rows.set("died", podRow("died", { created_at: 0 }));
      cluster.store.pods.set("claws-session-died", podObject("died", { phase: "Failed", reason: "Evicted" }));
      mockDb.updateSessionStartup.mockRejectedValueOnce(new Error("db down"));

      await backend().reconcile();

      expect(rows.get("died")!.ended_at).toBe(clock);
      expect(mockLog.warn).toHaveBeenCalledWith(expect.stringContaining("Failed to record why session died ended"));
    });
  });

  describe("web role (#clw_01M5APX7YF3AGWHV1S1WMHJDR6)", () => {
    it("start() learns open rows and pods but ends, deletes and writes nothing", async () => {
      rows.set("gone", podRow("gone", { created_at: 0 }));
      rows.set("died", podRow("died", { created_at: 0, initial_prompt: "Fix the build" }));
      rows.set("live", podRow("live", { created_at: 0, initial_prompt: "Fix the build" }));
      rows.set("old1", podRow("old1", { ended_at: 1 }));
      cluster.store.pods.set("claws-session-died", podObject("died", { phase: "Failed", reason: "Evicted" }));
      cluster.store.pods.set("claws-session-live", podObject("live"));
      for (const r of ["services", "secrets"] as const) cluster.store[r].set("claws-session-old1", podObject("old1"));
      const b = backend({ role: "web" });
      await b.start();
      await b.shutdown();

      expect(cluster.calls.filter((c) => c.startsWith("DELETE") || c.startsWith("PATCH") || c.startsWith("POST"))).toEqual([]);
      expect(mockDb.markSessionEnded).not.toHaveBeenCalled();
      expect(mockDb.updateSessionStartup).not.toHaveBeenCalled();
      expect(mockDb.markSessionInitialPromptSent).not.toHaveBeenCalled();
      expect(rows.get("gone")!.ended_at).toBeNull();
      expect(rows.get("died")!.ended_at).toBeNull();
      expect(await b.checkAttach("live")).toEqual({ ok: true });
      // The list column renders from the pod list the pass already read.
      expect((await b.listLive()).find((s) => s.id === "live")?.startupStatus?.state).toBe("ready");
    });

    it("attach resolves an id another process launched after the last refresh", async () => {
      const web = backend({ role: "web" });
      await web.start();
      rows.set("late", podRow("late", { created_at: clock }));
      cluster.store.pods.set("claws-session-late", podObject("late"));

      expect(await web.checkAttach("late")).toEqual({ ok: true });
      expect(await web.getLive("late")).toMatchObject({ ok: true, session: { id: "late" } });
      await web.shutdown();

      // The controller learns it only from its own reconcile pass.
      rows.set("late2", podRow("late2", { created_at: clock }));
      cluster.store.pods.set("claws-session-late2", podObject("late2"));
      const controller = backend();
      expect(await controller.checkAttach("late2")).toMatchObject({ ok: false, reason: "unavailable" });
    });

    it("shows the summary the controller wrote after the entry was learned", async () => {
      rows.set("live", podRow("live", { created_at: 0, summary: "Old summary" }));
      cluster.store.pods.set("claws-session-live", podObject("live"));
      const b = backend({ role: "web", reconcileIntervalMs: 5 });
      await b.start();
      try {
        expect((await b.listLive()).find((s) => s.id === "live")?.summary).toBe("Old summary");
        rows.set("live", { ...rows.get("live")!, summary: "New summary", summary_updated_at: 2 });
        await vi.waitFor(async () => expect((await b.listLive()).find((s) => s.id === "live")?.summary).toBe("New summary"));
      } finally {
        await b.shutdown();
      }
    });

    it("the controller adopts a description pinned or cleared by another process", async () => {
      rows.set("live", podRow("live", { created_at: 0, summary: "Auto summary" }));
      cluster.store.pods.set("claws-session-live", podObject("live"));
      const b = backend();
      await b.reconcile();
      rows.set("live", { ...rows.get("live")!, summary: "Pinned by hand", summary_manual: 1, summary_updated_at: 2 });
      await b.reconcile();
      expect((await b.listLive()).find((s) => s.id === "live")?.summary).toBe("Pinned by hand");
      // Cleared on the web tier: the summariser may write a fresh one again.
      rows.set("live", { ...rows.get("live")!, summary: null, summary_manual: 0, summary_updated_at: null });
      await b.reconcile();
      expect((await b.listLive()).find((s) => s.id === "live")?.summary).toBeNull();
    });

    it("forgets an entry once the controller has ended its row", async () => {
      rows.set("live", podRow("live", { created_at: 0 }));
      cluster.store.pods.set("claws-session-live", podObject("live"));
      const b = backend({ role: "web", reconcileIntervalMs: 60_000 });
      await b.start();
      expect(await b.checkAttach("live")).toEqual({ ok: true });
      rows.set("live", { ...rows.get("live")!, ended_at: clock });
      expect(await b.checkAttach("live")).toMatchObject({ ok: false, reason: "not-found" });
      await b.shutdown();
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
        settings, now: () => clock, sleep: async () => {}, podBaseUrl: () => baseUrl, buildLaunch: buildLaunch as never, ...extra,
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

    it("web role: bridges a session it has no entry for after learning it from the database", async () => {
      rows.set("aa11", podRow("aa11"));
      cluster.store.pods.set("claws-session-aa11", podObject("aa11"));
      cluster.store.secrets.set("claws-session-aa11", { metadata: { name: "claws-session-aa11" }, data: { "terminal-token": Buffer.from("tok-123").toString("base64") } });
      const b = createK8sSessionBackend({
        client: createK8sClient({ transport: cluster.transport, saDir }),
        settings, now: () => clock, sleep: async () => {}, podBaseUrl: () => podUrl, buildLaunch: buildLaunch as never, role: "web",
      });
      const client = fakeClient();
      b.attach("aa11", client as unknown as WsSocket);
      await vi.waitFor(() => expect(client.send).toHaveBeenCalledWith(JSON.stringify({ type: "scrollback", data: "hello" })));
      expect(authHeader).toBe("Bearer tok-123");
      expect(client.close).not.toHaveBeenCalled();

      const stranger = fakeClient();
      b.attach("ffff", stranger as unknown as WsSocket);
      await vi.waitFor(() => expect(stranger.close).toHaveBeenCalledWith(1008, "Session not found"));
      client.emit("close");
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

    it("a browser grant's relaunch closes terminals with 1012 and withholds the old pod's exit frame (#clw_01M4RASNVDKH2YBHZMGR0SM0RA)", async () => {
      const held = holdCall("DELETE", "/pods/claws-session-aa11");
      const b = await readyBackend(podUrl);
      const open = fakeClient();
      b.attach("aa11", open as unknown as WsSocket);
      await vi.waitFor(() => expect(wss.clients.size).toBe(1));

      const granting = b.grantCapability("aa11", "browser");
      await vi.waitFor(() => expect(held.reached).toBe(true));
      expect(open.close).toHaveBeenCalledWith(1012, "Agent restarting");

      // A terminal that reattaches before the old pod has gone sees it shut down.
      const late = fakeClient();
      b.attach("aa11", late as unknown as WsSocket);
      await vi.waitFor(() => expect(late.send).toHaveBeenCalledWith(JSON.stringify({ type: "scrollback", data: "hello" })));
      for (const sock of wss.clients) {
        sock.send(JSON.stringify({ type: "exit", code: 0 }));
        sock.close(1001);
      }
      await vi.waitFor(() => expect(late.close).toHaveBeenCalled());
      expect(late.close).toHaveBeenCalledWith(1012, "Agent restarting");
      for (const client of [open, late]) {
        expect(client.send).not.toHaveBeenCalledWith(JSON.stringify({ type: "exit", code: 0 }));
      }

      held.release();
      expect(await granting).toMatchObject({ ok: true, restarted: true });
    });

    it("ends the row on the exit report and leaves the exit frame to the pod (#clw_01M52FEC8QSM9P57WWSEBYFB7D)", async () => {
      const b = await readyBackend(podUrl);
      const client = fakeClient();
      b.attach("aa11", client as unknown as WsSocket);
      await vi.waitFor(() => expect(wss.clients.size).toBe(1));
      expect(await b.recordPodExit("aa11", "tok-123", { code: 3, scrollback: "boom" })).toBe("ok");
      expect(rows.get("aa11")).toMatchObject({ ended_at: clock, startup_state: "failed", startup_step: "Session exited with code 3", last_output: "boom" });
      expect(client.send).not.toHaveBeenCalledWith(JSON.stringify({ type: "exit", code: 3 }));
      expect(client.close).not.toHaveBeenCalled();
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
