import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./config.js", async (importOriginal) => (await import("./test-helpers.js")).completeConfigMock(await importOriginal<typeof import("./config.js")>(), {
  DB_PATH: ":memory:",
  DATABASE_URL: "",
  DATABASE_PASSWORD: "",
}));

vi.mock("./log.js", async () => {
  const core = await vi.importActual<typeof import("./log-core.js")>("./log-core.js");
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), runContext: core.runContext, withRunContext: core.withRunContext };
});

import * as db from "./db.js";
import type { K8sClient, K8sObject, K8sResource, K8sResult } from "./k8s/api.js";
import {
  createSessionMoveController,
  endEvacuation,
  evacuationStatus,
  nextMoveClaimName,
  startEvacuation,
  type SessionMoveHooks,
} from "./session-move.js";

const NS = "claws-sessions";
const NODES = ["k3s-nas", "k3s"];
const settings = {
  namespace: NS, image: "claws:v1", imagePullSecrets: [], storageClassName: "local-path", storageSize: "20Gi",
  nodes: NODES, tolerations: [{ key: "node-role.kubernetes.io/storage", operator: "Equal" as const, value: "true", effect: "NoSchedule" as const }],
};

type Obj = K8sObject & { metadata: { name: string }; status?: Record<string, unknown>; spec?: Record<string, unknown> };

/** In-memory API: a receiver runs with an IP; a sender succeeds (and its receiver with it) unless `senderOutcomes` says fail. */
function fakeClient() {
  const store: Record<K8sResource, Map<string, Obj>> = { pods: new Map(), services: new Map(), secrets: new Map(), persistentvolumeclaims: new Map() };
  const calls: string[] = [];
  const senderOutcomes: Array<"Succeeded" | "Failed"> = [];
  const ok = <T>(value: T): K8sResult<T> => ({ ok: true, value });
  const notFound = { ok: false as const, kind: "not-found" as const, message: "not found", applied: "no" as const };
  const client = {
    async create(resource: K8sResource, _ns: string, obj: K8sObject) {
      const o = structuredClone(obj) as Obj;
      calls.push(`POST ${resource}/${o.metadata.name}`);
      if (resource === "pods" && o.metadata.name.includes("session-move-recv-")) o.status = { phase: "Running", podIP: "10.42.0.7" };
      if (resource === "pods" && o.metadata.name.includes("session-move-send-")) {
        const outcome = senderOutcomes.shift() ?? "Succeeded";
        o.status = { phase: outcome };
        if (outcome === "Succeeded") {
          const recv = store.pods.get(o.metadata.name.replace("session-move-send-", "session-move-recv-"));
          if (recv) recv.status = { phase: "Succeeded" };
        }
      }
      store[resource].set(o.metadata.name, o);
      return ok(o);
    },
    async get(resource: K8sResource, _ns: string, name: string) {
      calls.push(`GET ${resource}/${name}`);
      const o = store[resource].get(name);
      return o ? ok(o) : notFound;
    },
    async delete(resource: K8sResource, _ns: string, name: string) {
      calls.push(`DELETE ${resource}/${name}`);
      return store[resource].delete(name) ? ok(undefined) : notFound;
    },
    async podLog() {
      return ok(`${JSON.stringify({ ok: true, bytes: 4096, sha256: "x" })}\n`);
    },
  };
  return { client: client as unknown as K8sClient, store, calls, senderOutcomes };
}

function fakeHooks() {
  const locked = new Set<string>();
  const order: string[] = [];
  const hooks = {
    tryLock: vi.fn((id: string) => {
      if (locked.has(id)) return false;
      locked.add(id);
      order.push(id);
      return true;
    }),
    unlock: vi.fn((id: string) => { locked.delete(id); }),
    stopForMove: vi.fn(async () => ({ ok: true as const })),
    relaunch: vi.fn(async () => ({ ok: true as const })),
    endWithoutStorage: vi.fn(async () => {}),
    notifyAgentOnceReady: vi.fn(),
  } satisfies SessionMoveHooks;
  return { hooks, locked, order };
}

async function addSession(id: string, opts: { node?: string; ended?: boolean; agentStatus?: string } = {}): Promise<void> {
  await db.insertSession({
    id, tmux_name: `claws-${id}`, mode: "worktree-claude", repo: "org/app", cwd: "/home/claws", worktree_path: null,
    extra_worktrees: null, capabilities: "[]", created_at: 1, summary: null, summary_updated_at: null, provider: "claude",
    model: null, backend: "k8s-pod",
  });
  if (opts.node) await db.setSessionNode(id, opts.node);
  if (opts.ended) await db.markSessionEnded(id, 2, null);
  if (opts.agentStatus) await db._rawDb().run(`UPDATE sessions SET agent_status = ? WHERE id = ?`, [opts.agentStatus, id]);
}

describe("session moves", () => {
  let clock: number;
  let k8s: ReturnType<typeof fakeClient>;
  let h: ReturnType<typeof fakeHooks>;
  let seq: number;

  const controller = () => createSessionMoveController({
    client: k8s.client, settings, hooks: h.hooks, now: () => clock, sleep: async () => {}, pollMs: 1, tickMs: 60_000,
    newId: () => `mv${++seq}`, newToken: () => "token",
  });
  const pvc = (name: string) => k8s.store.persistentvolumeclaims.set(name, { metadata: { name }, spec: { resources: { requests: { storage: "30Gi" } } } });

  beforeEach(async () => {
    await db.initDb();
    clock = 1_000_000;
    k8s = fakeClient();
    h = fakeHooks();
    seq = 0;
  });

  afterEach(async () => {
    await db.closeDb();
  });

  it("names a fresh claim one above any used", () => {
    expect(nextMoveClaimName("aa", ["claws-session-aa", null])).toBe("claws-session-aa-m1");
    expect(nextMoveClaimName("aa", ["claws-session-aa-m1", "claws-session-aa-m3"])).toBe("claws-session-aa-m4");
  });

  it("moves a running session: stops it, copies HOME, switches the claim, relaunches and tells the agent", async () => {
    await addSession("aa", { node: "k3s-nas" });
    pvc("claws-session-aa");
    await startEvacuation("k3s-nas", "NAS shutdown", 300, clock);
    const c = controller();
    expect((await evacuationStatus("k3s-nas", NODES)).running.pending).toBe(1);

    await c.tick();
    await c.idle();

    expect(h.hooks.stopForMove).toHaveBeenCalledWith("aa");
    expect(h.hooks.relaunch).toHaveBeenCalledWith("aa");
    const row = await db.getPersistedSession("aa");
    expect(row?.home_claim).toBe("claws-session-aa-m1");
    expect(row?.node).toBe("k3s");
    expect(k8s.store.persistentvolumeclaims.has("claws-session-aa")).toBe(false);
    expect(k8s.store.persistentvolumeclaims.has("claws-session-aa-m1")).toBe(true);
    // The new claim keeps the old one's size; movers and their Secret are gone.
    expect((k8s.store.persistentvolumeclaims.get("claws-session-aa-m1")!.spec as { resources: { requests: { storage: string } } }).resources.requests.storage).toBe("30Gi");
    expect([...k8s.store.pods.keys()]).toEqual([]);
    expect([...k8s.store.secrets.keys()]).toEqual([]);
    // The sender was created after the receiver had an IP, and pointed at it.
    const sendCreate = k8s.calls.indexOf("POST pods/claws-session-move-send-aa");
    expect(sendCreate).toBeGreaterThan(k8s.calls.indexOf("POST pods/claws-session-move-recv-aa"));
    expect(h.hooks.notifyAgentOnceReady).toHaveBeenCalledWith("aa", expect.stringContaining("moved from node k3s-nas to k3s"));
    const move = await db.getLatestSessionMove("aa");
    expect(move).toMatchObject({ state: "done", kind: "evacuate", bytes: 4096, was_running: 1, error: null });
    expect(h.locked.size).toBe(0);
    expect(await evacuationStatus("k3s-nas", NODES)).toEqual({
      node: "k3s-nas", active: true, done: true, complete: true,
      running: { pending: 0, moving: 0, moved: 1, failed: 0 }, ended: { pending: 0, moving: 0, moved: 0, failed: 0 },
    });
  });

  it("waits for a working agent until the idle deadline", async () => {
    await addSession("aa", { node: "k3s-nas", agentStatus: "working" });
    pvc("claws-session-aa");
    await startEvacuation("k3s-nas", "NAS shutdown", 300, clock);
    const c = controller();

    await c.tick();
    await c.idle();
    expect(h.hooks.stopForMove).not.toHaveBeenCalled();
    expect((await db.getLatestSessionMove("aa"))?.state).toBe("waiting-idle");
    expect((await evacuationStatus("k3s-nas", NODES)).running.pending).toBe(1);

    clock += 299_000;
    await c.tick();
    expect(h.hooks.stopForMove).not.toHaveBeenCalled();

    clock += 1_000;
    await c.tick();
    await c.idle();
    expect(h.hooks.stopForMove).toHaveBeenCalled();
    expect((await db.getLatestSessionMove("aa"))?.state).toBe("done");
  });

  it("starts as soon as the agent goes idle", async () => {
    await addSession("aa", { node: "k3s-nas", agentStatus: "working" });
    pvc("claws-session-aa");
    await startEvacuation("k3s-nas", "NAS shutdown", 300, clock);
    const c = controller();
    await c.tick();
    await db._rawDb().run(`UPDATE sessions SET agent_status = 'waiting' WHERE id = 'aa'`);
    await c.tick();
    await c.idle();
    expect((await db.getLatestSessionMove("aa"))?.state).toBe("done");
  });

  it("copies an ended session without stopping or relaunching it", async () => {
    await addSession("ee", { node: "k3s-nas", ended: true });
    pvc("claws-session-ee");
    await startEvacuation("k3s-nas", "NAS shutdown", 300, clock);
    const c = controller();
    await c.tick();
    await c.idle();

    expect(h.hooks.stopForMove).not.toHaveBeenCalled();
    expect(h.hooks.relaunch).not.toHaveBeenCalled();
    expect(h.hooks.notifyAgentOnceReady).not.toHaveBeenCalled();
    expect((await db.getPersistedSession("ee"))?.home_claim).toBe("claws-session-ee-m1");
    expect(k8s.store.persistentvolumeclaims.has("claws-session-ee")).toBe(false);
    expect((await evacuationStatus("k3s-nas", NODES)).ended).toEqual({ pending: 0, moving: 0, moved: 1, failed: 0 });
  });

  it("moves running sessions before ended ones", async () => {
    await addSession("e1", { node: "k3s-nas", ended: true });
    await addSession("e2", { node: "k3s-nas", ended: true });
    await addSession("r1", { node: "k3s-nas" });
    for (const id of ["e1", "e2", "r1"]) pvc(`claws-session-${id}`);
    await startEvacuation("k3s-nas", "NAS shutdown", 300, clock);
    const c = controller();
    await c.tick();
    await c.idle();
    expect(h.order[0]).toBe("r1");
    expect(h.order).toHaveLength(2);
    await c.tick();
    await c.idle();
    expect(h.order).toHaveLength(3);
    expect((await evacuationStatus("k3s-nas", NODES)).done).toBe(true);
  });

  it("retries a failed copy once with a fresh claim", async () => {
    await addSession("aa", { node: "k3s-nas", ended: true });
    pvc("claws-session-aa");
    k8s.senderOutcomes.push("Failed");
    await startEvacuation("k3s-nas", "NAS shutdown", 300, clock);
    const c = controller();
    await c.tick();
    await c.idle();
    expect(await db.getLatestSessionMove("aa")).toMatchObject({ state: "done", attempts: 2, new_claim: "claws-session-aa-m2" });
    expect(k8s.store.persistentvolumeclaims.has("claws-session-aa-m1")).toBe(false);
    expect((await db.getPersistedSession("aa"))?.home_claim).toBe("claws-session-aa-m2");
  });

  it("after a second failure keeps the old claim and relaunches a running session on it", async () => {
    await addSession("aa", { node: "k3s-nas" });
    pvc("claws-session-aa");
    k8s.senderOutcomes.push("Failed", "Failed");
    await startEvacuation("k3s-nas", "NAS shutdown", 300, clock);
    const c = controller();
    await c.tick();
    await c.idle();
    const move = await db.getLatestSessionMove("aa");
    expect(move).toMatchObject({ state: "failed", attempts: 2 });
    expect(move?.error).toContain("sender failed");
    const row = await db.getPersistedSession("aa");
    expect(row?.home_claim).toBeNull();
    expect(row?.node).toBe("k3s-nas");
    expect(h.hooks.relaunch).toHaveBeenCalledWith("aa");
    expect(h.hooks.notifyAgentOnceReady).not.toHaveBeenCalled();
    expect(k8s.store.persistentvolumeclaims.has("claws-session-aa")).toBe(true);
    expect([...k8s.store.persistentvolumeclaims.keys()]).toEqual(["claws-session-aa"]);
    const status = await evacuationStatus("k3s-nas", NODES);
    expect(status.running.failed).toBe(1);
    expect(status.done).toBe(true);
    // A later pass does not retry it within this evacuation.
    await c.tick();
    await c.idle();
    expect(h.hooks.stopForMove).toHaveBeenCalledTimes(1);
  });

  it("restarts a move a Claws restart interrupted mid-copy with a fresh claim, holding the lock from start()", async () => {
    await addSession("aa", { node: "k3s-nas" });
    pvc("claws-session-aa");
    pvc("claws-session-aa-m1");
    await db.requestNodeEvacuation({ node: "k3s-nas", reason: "NAS shutdown", requested_at: clock, idle_deadline_seconds: 300 });
    await db.insertSessionMove({
      id: "old", session_id: "aa", kind: "evacuate", from_node: "k3s-nas", to_node: "k3s", reason: "NAS shutdown", state: "copying",
      was_running: 1, from_claim: "claws-session-aa", new_claim: "claws-session-aa-m1", attempts: 1, bytes: null,
      requested_at: clock, started_at: clock, finished_at: null, error: null,
    });
    const c = controller();
    let lockedAtStart = false;
    h.hooks.stopForMove.mockImplementation(async () => {
      lockedAtStart = h.locked.has("aa");
      return { ok: true as const };
    });
    // start() re-takes the lock before anything else can touch the session.
    const startPromise = c.start();
    await startPromise;
    expect(h.hooks.tryLock).toHaveBeenCalledWith("aa");
    await c.idle();
    expect(lockedAtStart).toBe(true);
    const move = await db.getLatestSessionMove("aa");
    // The copy the restart cut short does not use up the retry.
    expect(move).toMatchObject({ id: "old", state: "done", new_claim: "claws-session-aa-m2", attempts: 1 });
    expect(k8s.store.persistentvolumeclaims.has("claws-session-aa-m1")).toBe(false);
    expect((await db.getPersistedSession("aa"))?.home_claim).toBe("claws-session-aa-m2");
    expect(h.locked.size).toBe(0);
    c.stop();
  });

  it("evacuation requests are idempotent and clearing drops moves not yet under way", async () => {
    await addSession("aa", { node: "k3s-nas", agentStatus: "working" });
    await addSession("ee", { node: "k3s-nas", ended: true });
    const first = await startEvacuation("k3s-nas", "NAS shutdown", 9999, clock);
    expect(first.idle_deadline_seconds).toBe(1800);
    const again = await startEvacuation("k3s-nas", "other reason", 10, clock + 5);
    expect(again).toEqual(first);
    const c = controller();
    // Fill both slots with nothing: the running session waits for its agent, the ended one is blocked by a held lock.
    h.locked.add("ee");
    await c.tick();
    await c.idle();
    expect(await evacuationStatus("k3s-nas", NODES)).toMatchObject({ running: { pending: 1 }, ended: { pending: 1 }, done: false });
    expect(await endEvacuation("k3s-nas")).toBe(true);
    expect(await db.getLatestSessionMove("aa")).toBeUndefined();
    // Ended sessions' moves go too: nothing copies an ended session without an evacuation.
    expect(await db.getLatestSessionMove("ee")).toBeUndefined();
    // With no evacuation stored, the sessions still on the node count as pending.
    expect(await evacuationStatus("k3s-nas", NODES)).toMatchObject({ active: false, done: false, running: { pending: 1 }, ended: { pending: 1 } });
    expect(await endEvacuation("k3s-nas")).toBe(false);
  });

  it("a move claimed by the controller survives clearing the evacuation, and a dropped one cannot be claimed", async () => {
    await addSession("aa", { node: "k3s-nas", ended: true });
    await addSession("bb", { node: "k3s-nas", ended: true, agentStatus: "working" });
    await startEvacuation("k3s-nas", "NAS shutdown", 300, clock);
    const base = {
      kind: "evacuate" as const, from_node: "k3s-nas", to_node: "k3s", reason: "NAS shutdown", state: "queued" as const, was_running: 1,
      new_claim: null, attempts: 0, bytes: null, requested_at: clock, started_at: null, finished_at: null, error: null,
    };
    await db.insertSessionMove({ ...base, id: "m-aa", session_id: "aa", from_claim: "claws-session-aa" });
    await db.insertSessionMove({ ...base, id: "m-bb", session_id: "bb", from_claim: "claws-session-bb" });
    expect(await db.claimSessionMove("m-aa", clock, 1)).toBe(true);
    expect(await db.claimSessionMove("m-aa", clock, 1)).toBe(false);
    await endEvacuation("k3s-nas");
    expect(await db.getLatestSessionMove("aa")).toMatchObject({ id: "m-aa", kind: "evacuate" });
    expect(await db.getLatestSessionMove("bb")).toBeUndefined();
    expect(await db.claimSessionMove("m-bb", clock, 1)).toBe(false);
  });

  it("leaves an ended session off the home node where it is without an evacuation", async () => {
    await addSession("ss", { node: "k3s-nas", ended: true });
    pvc("claws-session-ss");
    const c = controller();
    await c.start();
    await c.tick();
    await c.idle();
    expect(await db.getLatestSessionMove("ss")).toBeUndefined();
    expect((await db.getPersistedSession("ss"))?.node).toBe("k3s-nas");
    expect(k8s.calls.some((call) => call.startsWith("POST"))).toBe(false);
    c.stop();
  });

  const legacySettle = (id: string, session: string, state: db.SessionMoveState, extra: Partial<db.SessionMove> = {}): db.SessionMove => ({
    id, session_id: session, kind: "settle", from_node: "k3s-nas", to_node: "k3s", reason: "session ended", state,
    was_running: 0, from_claim: `claws-session-${session}`, new_claim: null, attempts: 0, bytes: null,
    requested_at: clock, started_at: null, finished_at: null, error: null, ...extra,
  });

  it("start() deletes queued and failed legacy settles instead of running them", async () => {
    await addSession("q1", { node: "k3s-nas", ended: true });
    await addSession("f1", { node: "k3s-nas", ended: true });
    await addSession("d1", { node: "k3s", ended: true });
    pvc("claws-session-q1");
    pvc("claws-session-f1");
    await db.insertSessionMove(legacySettle("mq", "q1", "queued"));
    await db.insertSessionMove(legacySettle("mf", "f1", "failed", { attempts: 2, error: "sender failed", finished_at: clock }));
    await db.insertSessionMove(legacySettle("md", "d1", "done", { finished_at: clock }));
    const c = controller();
    await c.start();
    await c.idle();
    expect(await db.getLatestSessionMove("q1")).toBeUndefined();
    expect(await db.getLatestSessionMove("f1")).toBeUndefined();
    // A done settle stays as history.
    expect(await db.getLatestSessionMove("d1")).toMatchObject({ id: "md", state: "done" });
    expect(k8s.calls.some((call) => call.startsWith("POST"))).toBe(false);
    expect(h.locked.size).toBe(0);
    c.stop();
  });

  it("start() aborts a legacy settle a restart cut short mid-copy, leaving the session on its old claim", async () => {
    await addSession("ss", { node: "k3s-nas", ended: true });
    pvc("claws-session-ss");
    pvc("claws-session-ss-m1");
    k8s.store.pods.set("claws-session-move-recv-ss", { metadata: { name: "claws-session-move-recv-ss" } });
    k8s.store.pods.set("claws-session-move-send-ss", { metadata: { name: "claws-session-move-send-ss" } });
    await db.insertSessionMove(legacySettle("old", "ss", "copying", { new_claim: "claws-session-ss-m1", attempts: 1, started_at: clock }));
    const c = controller();
    await c.start();
    await c.idle();
    expect(await db.getLatestSessionMove("ss")).toBeUndefined();
    expect(k8s.store.persistentvolumeclaims.has("claws-session-ss-m1")).toBe(false);
    expect(k8s.store.persistentvolumeclaims.has("claws-session-ss")).toBe(true);
    expect([...k8s.store.pods.keys()]).toEqual([]);
    const row = await db.getPersistedSession("ss");
    expect(row?.home_claim).toBeNull();
    expect(row?.node).toBe("k3s-nas");
    expect(h.locked.size).toBe(0);
    c.stop();
  });

  it("start() lets a legacy settle already resuming finish", async () => {
    await addSession("ss", { node: "k3s-nas", ended: true });
    pvc("claws-session-ss");
    pvc("claws-session-ss-m1");
    await db.insertSessionMove(legacySettle("old", "ss", "resuming", { new_claim: "claws-session-ss-m1", attempts: 1, bytes: 10, started_at: clock }));
    const c = controller();
    await c.start();
    await c.idle();
    expect(await db.getLatestSessionMove("ss")).toMatchObject({ id: "old", state: "done" });
    const row = await db.getPersistedSession("ss");
    expect(row?.home_claim).toBe("claws-session-ss-m1");
    expect(row?.node).toBe("k3s");
    expect(k8s.store.persistentvolumeclaims.has("claws-session-ss")).toBe(false);
    expect(h.locked.size).toBe(0);
    c.stop();
  });

  it("a running session whose storage is gone is ended, not relaunched, and the move counts as failed", async () => {
    await addSession("aa", { node: "k3s-nas" });
    await startEvacuation("k3s-nas", "NAS shutdown", 300, clock);
    const c = controller();
    await c.tick();
    await c.idle();
    expect(await db.getLatestSessionMove("aa")).toMatchObject({ state: "failed", error: "its storage no longer exists" });
    expect(h.hooks.relaunch).not.toHaveBeenCalled();
    expect(h.hooks.endWithoutStorage).toHaveBeenCalledWith("aa", "its storage no longer exists");
    expect((await db.getPersistedSession("aa"))?.node).toBe("k3s");
    expect(await evacuationStatus("k3s-nas", NODES)).toMatchObject({ done: true, complete: false });
  });
});
