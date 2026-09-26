import fs from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  agentPodWatchdogCapBytes,
  AgentMemoryReservationGate,
  AUXILIARY_AGENT_ADMISSION_BYTES,
  cgroupMemoryLimitBytes,
  computeAdmissionReservationBytes,
  computeAgentMemoryPolicy,
  computeRunCapBytes,
  MIN_PLAUSIBLE_AGENT_MEMORY_BYTES,
  DEFAULT_AGENT_WORKER_MEMORY_HEADROOM_BYTES,
  DEFAULT_AGENT_WORKER_MEMORY_MAX_BYTES,
  laneBudgetBytes,
  parseCgroupMemoryLimit,
  parseK8sMemoryQuantity,
  readCgroupMemoryLimitBytes,
  resetCgroupLimitCacheForTests,
} from "./agent-memory-budget.js";

describe("agent-memory-budget", () => {
  it("parses finite cgroup limits and ignores missing/unbounded/sentinel values", () => {
    expect(parseCgroupMemoryLimit("6442450944\n")).toBe(6 * 1024 * 1024 * 1024);
    expect(parseCgroupMemoryLimit("max")).toBeNull();
    expect(parseCgroupMemoryLimit("not-a-number")).toBeNull();
    expect(parseCgroupMemoryLimit("9223372036854771712")).toBeNull();
  });

  it("reads cgroup v2 before v1", () => {
    const reads: string[] = [];
    const fsLike = {
      readFileSync: (file: string) => {
        reads.push(file);
        if (file === "/sys/fs/cgroup/memory.max") return "6442450944";
        throw new Error("unexpected");
      },
    } as any;
    expect(readCgroupMemoryLimitBytes(fsLike)).toBe(6 * 1024 * 1024 * 1024);
    expect(reads).toEqual(["/sys/fs/cgroup/memory.max"]);
  });

  it("falls back to cgroup v1 when memory.max is missing", () => {
    const fsLike = {
      readFileSync: (file: string) => {
        if (file === "/sys/fs/cgroup/memory/memory.limit_in_bytes") return "4294967296\n";
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      },
    } as any;
    expect(readCgroupMemoryLimitBytes(fsLike)).toBe(4 * 1024 * 1024 * 1024);
  });

  it("treats the cgroup v1 unbounded sentinel as no limit", () => {
    const fsLike = {
      readFileSync: (file: string) => {
        if (file === "/sys/fs/cgroup/memory/memory.limit_in_bytes") return "9223372036854771712\n";
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      },
    } as any;
    expect(readCgroupMemoryLimitBytes(fsLike)).toBeNull();
  });

  it("keeps non-container defaults without derived admission", () => {
    const policy = computeAgentMemoryPolicy({
      defaultCapBytes: DEFAULT_AGENT_WORKER_MEMORY_MAX_BYTES,
      containerLimitBytes: null,
    });
    expect(policy.defaultCapBytes).toBe(DEFAULT_AGENT_WORKER_MEMORY_MAX_BYTES);
    expect(policy.sharedBudgetBytes).toBeNull();
    expect(policy.admissionActive).toBe(false);
  });

  it("derives a shared budget from cgroup limit minus headroom", () => {
    const policy = computeAgentMemoryPolicy({
      defaultCapBytes: 4 * 1024 * 1024 * 1024,
      containerLimitBytes: 6 * 1024 * 1024 * 1024,
    });
    expect(policy.sharedBudgetBytes).toBe((6 * 1024 * 1024 * 1024) - DEFAULT_AGENT_WORKER_MEMORY_HEADROOM_BYTES);
    expect(policy.admissionActive).toBe(true);
  });

  it("disables derived admission when the watchdog cap is 0 unless an explicit budget is set", () => {
    expect(computeAgentMemoryPolicy({
      defaultCapBytes: 0,
      containerLimitBytes: 6 * 1024 * 1024 * 1024,
    }).admissionActive).toBe(false);
    expect(computeAgentMemoryPolicy({
      defaultCapBytes: 0,
      explicitSharedBudgetBytes: 1024,
      containerLimitBytes: 6 * 1024 * 1024 * 1024,
    }).admissionActive).toBe(true);
  });

  it("parses Kubernetes memory quantities, keeping binary and decimal suffixes distinct", () => {
    expect(parseK8sMemoryQuantity("6Gi")).toBe(6 * 1024 ** 3);
    expect(parseK8sMemoryQuantity("8Gi")).toBe(8 * 1024 ** 3);
    expect(parseK8sMemoryQuantity("512Mi")).toBe(512 * 1024 ** 2);
    expect(parseK8sMemoryQuantity("1.5Gi")).toBe(Math.floor(1.5 * 1024 ** 3));
    expect(parseK8sMemoryQuantity("6G")).toBe(6 * 1000 ** 3);
    expect(parseK8sMemoryQuantity("6442450944")).toBe(6442450944);
    expect(parseK8sMemoryQuantity("100k")).toBe(100 * 1000);
  });

  it("rejects an empty, negative or unrecognised-suffix memory quantity", () => {
    expect(parseK8sMemoryQuantity("")).toBeNull();
    expect(parseK8sMemoryQuantity("abc")).toBeNull();
    expect(parseK8sMemoryQuantity("-1Gi")).toBeNull();
    expect(parseK8sMemoryQuantity("6GB")).toBeNull();
  });

  it("derives the agent pod watchdog cap from the pod's own memory limit", () => {
    expect(agentPodWatchdogCapBytes(6 * 1024 ** 3)).toBe(4 * 1024 ** 3);
    expect(agentPodWatchdogCapBytes(8 * 1024 ** 3)).toBe(6 * 1024 ** 3);
    expect(agentPodWatchdogCapBytes(3 * 1024 ** 3)).toBe(2 * 1024 ** 3);
    expect(agentPodWatchdogCapBytes(null)).toBe(2 * 1024 ** 3);
  });

  it("gives a 6 GiB pod's derived cap a laneBudgetBytes of exactly 4 GiB", () => {
    const policy = computeAgentMemoryPolicy({
      defaultCapBytes: agentPodWatchdogCapBytes(6 * 1024 ** 3),
      containerLimitBytes: 6 * 1024 ** 3,
    });
    expect(laneBudgetBytes(policy.sharedBudgetBytes, policy.auxiliaryBudgetBytes, "agent")).toBe(4 * 1024 ** 3);
  });

  it("reserves the effective cap, the per-call cap, or a whole-budget slot when uncapped", () => {
    const sharedBudgetBytes = 4 * 1024 * 1024 * 1024;
    expect(computeAdmissionReservationBytes({
      admissionActive: true,
      sharedBudgetBytes,
      effectiveLimitBytes: 2 * 1024 * 1024 * 1024,
    })).toBe(2 * 1024 * 1024 * 1024);
    // Watchdog disabled, per-call cap present — reserve the per-call cap.
    expect(computeAdmissionReservationBytes({
      admissionActive: true,
      sharedBudgetBytes,
      effectiveLimitBytes: 0,
      requestedMemoryMaxBytes: 3 * 1024 * 1024 * 1024,
    })).toBe(3 * 1024 * 1024 * 1024);
    // Watchdog disabled, no per-call cap — reserve the whole budget.
    expect(computeAdmissionReservationBytes({
      admissionActive: true,
      sharedBudgetBytes,
      effectiveLimitBytes: 0,
    })).toBe(sharedBudgetBytes);
    // Admission off — no reservation at all.
    expect(computeAdmissionReservationBytes({
      admissionActive: false,
      sharedBudgetBytes: null,
      effectiveLimitBytes: 2 * 1024 * 1024 * 1024,
    })).toBe(0);
  });

  it("clamps the run cap to a declared auxiliary slice, so the reservation is what the watchdog enforces", () => {
    // A declared slice lowers the cap the watchdog uses...
    expect(computeRunCapBytes(4 * 1024 * 1024 * 1024, AUXILIARY_AGENT_ADMISSION_BYTES))
      .toBe(AUXILIARY_AGENT_ADMISSION_BYTES);
    // ...and never raises it above the global/per-call cap.
    expect(computeRunCapBytes(512 * 1024 * 1024, AUXILIARY_AGENT_ADMISSION_BYTES)).toBe(512 * 1024 * 1024);
    // Undeclared runs keep the full cap.
    expect(computeRunCapBytes(4 * 1024 * 1024 * 1024)).toBe(4 * 1024 * 1024 * 1024);
    // Watchdog globally disabled: nothing would enforce the slice, so it is
    // ignored rather than shrinking the reservation to a promise.
    expect(computeRunCapBytes(0, AUXILIARY_AGENT_ADMISSION_BYTES)).toBe(0);

    // The reservation is then exactly that clamped cap.
    expect(computeAdmissionReservationBytes({
      admissionActive: true,
      sharedBudgetBytes: 4 * 1024 * 1024 * 1024,
      effectiveLimitBytes: computeRunCapBytes(4 * 1024 * 1024 * 1024, AUXILIARY_AGENT_ADMISSION_BYTES),
    })).toBe(AUXILIARY_AGENT_ADMISSION_BYTES);
  });

  it("clamps a headroom that swallows the container limit instead of disabling admission", () => {
    const containerLimitBytes = 10 * 1024 * 1024 * 1024;
    const defaultCapBytes = 4 * 1024 * 1024 * 1024;
    const policy = computeAgentMemoryPolicy({
      defaultCapBytes,
      headroomBytes: containerLimitBytes,
      containerLimitBytes,
    });
    expect(policy.headroomClamped).toBe(true);
    expect(policy.sharedBudgetBytes).toBe(defaultCapBytes);
    expect(policy.admissionActive).toBe(true);
    // Only an operator writing the budget (or the cap) as 0 turns admission off.
    expect(computeAgentMemoryPolicy({
      defaultCapBytes,
      explicitSharedBudgetBytes: 0,
      containerLimitBytes,
    }).admissionActive).toBe(false);
  });

  it("never clamps the derived budget above the real container limit, even when the cap alone exceeds it", () => {
    const containerLimitBytes = 2 * 1024 * 1024 * 1024;
    const headroomBytes = 2 * 1024 * 1024 * 1024;
    const defaultCapBytes = 4 * 1024 * 1024 * 1024;
    const policy = computeAgentMemoryPolicy({
      defaultCapBytes,
      headroomBytes,
      containerLimitBytes,
    });
    expect(policy.headroomClamped).toBe(true);
    expect(policy.sharedBudgetBytes).not.toBeGreaterThan(containerLimitBytes);
    expect(policy.sharedBudgetBytes).toBe(containerLimitBytes);
  });

  it("floors the clamped budget at the plausibility floor when the cap is tiny", () => {
    const policy = computeAgentMemoryPolicy({
      defaultCapBytes: MIN_PLAUSIBLE_AGENT_MEMORY_BYTES,
      headroomBytes: 8 * 1024 * 1024 * 1024,
      containerLimitBytes: 8 * 1024 * 1024 * 1024,
    });
    expect(policy.sharedBudgetBytes).toBe(MIN_PLAUSIBLE_AGENT_MEMORY_BYTES);
  });

  it("carves the auxiliary lane out of the derived budget, never more than half", () => {
    const tenGiB = computeAgentMemoryPolicy({
      defaultCapBytes: 4 * 1024 * 1024 * 1024,
      containerLimitBytes: 10 * 1024 * 1024 * 1024,
    });
    // The deployed policy: 10240 - 1280 headroom = 8960 MiB, of which 768 MiB
    // is the auxiliary lane and 8192 MiB is exactly two full-cap agent runs.
    expect(tenGiB.sharedBudgetBytes).toBe(8960 * 1024 * 1024);
    expect(tenGiB.auxiliaryBudgetBytes).toBe(AUXILIARY_AGENT_ADMISSION_BYTES);
    expect(tenGiB.sharedBudgetBytes! - tenGiB.auxiliaryBudgetBytes).toBe(2 * 4 * 1024 * 1024 * 1024);

    const tiny = computeAgentMemoryPolicy({
      defaultCapBytes: 512 * 1024 * 1024,
      explicitSharedBudgetBytes: 512 * 1024 * 1024,
      containerLimitBytes: null,
    });
    expect(tiny.auxiliaryBudgetBytes).toBe(256 * 1024 * 1024);
  });

  it("memoizes the cgroup limit and clears it for tests", () => {
    // Asserting only on the returned value proves nothing — the real
    // /sys/fs/cgroup value is constant whether or not the cache exists. Count
    // the reads instead.
    resetCgroupLimitCacheForTests();
    const readFileSync = vi.spyOn(fs, "readFileSync");
    try {
      const first = cgroupMemoryLimitBytes();
      const readsAfterFirst = readFileSync.mock.calls.length;
      expect(readsAfterFirst).toBeGreaterThan(0);

      expect(cgroupMemoryLimitBytes()).toBe(first);
      expect(readFileSync.mock.calls.length).toBe(readsAfterFirst);

      resetCgroupLimitCacheForTests();
      expect(cgroupMemoryLimitBytes()).toBe(first);
      expect(readFileSync.mock.calls.length).toBeGreaterThan(readsAfterFirst);
    } finally {
      readFileSync.mockRestore();
      resetCgroupLimitCacheForTests();
    }
  });

  it("retunes the live budget instead of orphaning in-flight reservations", async () => {
    const gate = new AgentMemoryReservationGate(4 * 1024 * 1024 * 1024, 0);
    const first = await gate.acquire(3 * 1024 * 1024 * 1024);
    let secondAcquired = false;
    const second = gate.acquire(3 * 1024 * 1024 * 1024).then((reservation) => {
      secondAcquired = true;
      return reservation;
    });
    await Promise.resolve();
    expect(secondAcquired).toBe(false);

    // Tightening the budget must not admit the waiter: the 3 GiB the first run
    // holds is still counted, which a replacement gate would have forgotten.
    gate.setBudget(3.5 * 1024 * 1024 * 1024, 0);
    await Promise.resolve();
    expect(secondAcquired).toBe(false);
    expect(gate.reserved).toBe(3 * 1024 * 1024 * 1024);

    // Raising it past the combined total drains immediately.
    gate.setBudget(8 * 1024 * 1024 * 1024, 0);
    (await second).release();
    expect(secondAcquired).toBe(true);
    first.release();
    expect(gate.reserved).toBe(0);
  });

  it("reports whether a run actually queued", async () => {
    const gate = new AgentMemoryReservationGate(4 * 1024 * 1024 * 1024, 0);
    const uncontended = gate.acquireCancellable(4 * 1024 * 1024 * 1024);
    expect(uncontended.queued).toBe(false);
    const contended = gate.acquireCancellable(4 * 1024 * 1024 * 1024);
    expect(contended.queued).toBe(true);
    (await uncontended.promise).release();
    expect(contended.queued).toBe(false);
    (await contended.promise).release();
  });

  it("cancels a queued waiter without admitting it when the reservation is released", async () => {
    const gate = new AgentMemoryReservationGate(4 * 1024 * 1024 * 1024, 0);
    const first = await gate.acquire(4 * 1024 * 1024 * 1024);
    const second = gate.acquireCancellable(4 * 1024 * 1024 * 1024);
    let secondAcquired = false;
    const settled = second.promise.then(
      () => { secondAcquired = true; },
      (err: unknown) => err,
    );
    await Promise.resolve();
    expect(secondAcquired).toBe(false);

    expect(second.cancel(new Error("cancelled"))).toBe(true);
    expect(await settled).toEqual(new Error("cancelled"));
    // Cancelling twice, or cancelling after admission, is a no-op.
    expect(second.cancel(new Error("again"))).toBe(false);

    first.release();
    await Promise.resolve();
    expect(secondAcquired).toBe(false);
    expect(gate.reserved).toBe(0);
  });

  it("lets a smaller waiter through once the blocking head is cancelled", async () => {
    const gate = new AgentMemoryReservationGate(4 * 1024 * 1024 * 1024, 0);
    const first = await gate.acquire(3 * 1024 * 1024 * 1024);
    const blocking = gate.acquireCancellable(3 * 1024 * 1024 * 1024);
    void blocking.promise.catch(() => {});
    let smallAcquired = false;
    const small = gate.acquire(1024 * 1024 * 1024).then((reservation) => {
      smallAcquired = true;
      return reservation;
    });
    await Promise.resolve();
    expect(smallAcquired).toBe(false);

    expect(blocking.cancel(new Error("cancelled"))).toBe(true);
    (await small).release();
    expect(smallAcquired).toBe(true);
    first.release();
  });

  it("admits an auxiliary run past a blocked agent-lane queue", async () => {
    // The deployed shape: two full-cap runs admitted, a third queued, and a
    // bookkeeping call arriving last. Under one FIFO queue it would wait for a
    // multi-hour implementer even though its bytes are free.
    const GiB = 1024 * 1024 * 1024;
    const gate = new AgentMemoryReservationGate(8960 * 1024 * 1024, AUXILIARY_AGENT_ADMISSION_BYTES);
    const a = await gate.acquire(4 * GiB);
    const b = await gate.acquire(4 * GiB);
    const blocked = gate.acquireCancellable(4 * GiB);
    void blocked.promise.then((r) => r.release());
    await Promise.resolve();
    expect(blocked.queued).toBe(true);

    const auxiliary = gate.acquireCancellable(AUXILIARY_AGENT_ADMISSION_BYTES, "auxiliary");
    expect(auxiliary.queued).toBe(false);
    expect(gate.reserved).toBe(8 * GiB + AUXILIARY_AGENT_ADMISSION_BYTES);
    expect(gate.reserved).toBeLessThanOrEqual(gate.budget!);

    (await auxiliary.promise).release();
    a.release();
    b.release();
  });

  it("keeps the auxiliary lane from crowding out agent-scale runs", async () => {
    const GiB = 1024 * 1024 * 1024;
    const gate = new AgentMemoryReservationGate(8960 * 1024 * 1024, AUXILIARY_AGENT_ADMISSION_BYTES);
    const first = await gate.acquire(AUXILIARY_AGENT_ADMISSION_BYTES, "auxiliary");
    // The lane holds exactly one slice, so a second auxiliary call queues —
    // behind another seconds-long call, never behind an implementer.
    const second = gate.acquireCancellable(AUXILIARY_AGENT_ADMISSION_BYTES, "auxiliary");
    expect(second.queued).toBe(true);
    // ...and the agent lane is untouched by either.
    const agent = gate.acquireCancellable(4 * GiB);
    expect(agent.queued).toBe(false);

    first.release();
    const admitted = await second.promise;
    expect(gate.reserved).toBe(4 * GiB + AUXILIARY_AGENT_ADMISSION_BYTES);
    admitted.release();
    (await agent.promise).release();
    expect(gate.reserved).toBe(0);
  });

  it("serializes reservations that cannot fit together and releases FIFO waiters", async () => {
    const gate = new AgentMemoryReservationGate(4.5 * 1024 * 1024 * 1024, 0);
    const first = await gate.acquire(4 * 1024 * 1024 * 1024);
    let secondAcquired = false;
    const secondPromise = gate.acquire(4 * 1024 * 1024 * 1024).then((reservation) => {
      secondAcquired = true;
      return reservation;
    });
    await Promise.resolve();
    expect(secondAcquired).toBe(false);
    first.release();
    const second = await secondPromise;
    expect(secondAcquired).toBe(true);
    second.release();
  });

  it("holds both lanes closed while an over-lane run uses the escape hatch", async () => {
    // The hatch exists so a cap larger than its own lane cannot deadlock. It
    // must not also be a way to exceed the budget: admitting a 768 MiB
    // auxiliary call alongside a run that is already wider than its lane is
    // exactly the over-commit the budget exists to prevent.
    const GiB = 1024 * 1024 * 1024;
    const gate = new AgentMemoryReservationGate(4 * GiB, AUXILIARY_AGENT_ADMISSION_BYTES);
    expect(gate.laneBudget("agent")).toBe(4 * GiB - AUXILIARY_AGENT_ADMISSION_BYTES);

    const solo = gate.acquireCancellable(4 * GiB);
    expect(solo.queued).toBe(false);
    const reservation = await solo.promise;
    expect(gate.reserved).toBe(4 * GiB);

    const auxiliary = gate.acquireCancellable(AUXILIARY_AGENT_ADMISSION_BYTES, "auxiliary");
    expect(auxiliary.queued).toBe(true);
    expect(gate.reserved).toBeLessThanOrEqual(gate.budget!);

    reservation.release();
    const admitted = await auxiliary.promise;
    expect(gate.reserved).toBe(AUXILIARY_AGENT_ADMISSION_BYTES);
    admitted.release();
  });

  it("does not admit an over-lane run alongside an auxiliary call already holding its lane", async () => {
    // The mirror of the case above: "runs alone" has to mean the gate is empty,
    // not merely that no *agent* run is admitted.
    const GiB = 1024 * 1024 * 1024;
    const gate = new AgentMemoryReservationGate(4 * GiB, AUXILIARY_AGENT_ADMISSION_BYTES);
    const auxiliary = await gate.acquire(AUXILIARY_AGENT_ADMISSION_BYTES, "auxiliary");

    const solo = gate.acquireCancellable(4 * GiB);
    expect(solo.queued).toBe(true);
    expect(gate.reserved).toBe(AUXILIARY_AGENT_ADMISSION_BYTES);

    auxiliary.release();
    const admitted = await solo.promise;
    expect(gate.reserved).toBe(4 * GiB);
    admitted.release();
  });

  it("laneBudgetBytes partitions the shared budget and never goes negative", () => {
    expect(laneBudgetBytes(null, AUXILIARY_AGENT_ADMISSION_BYTES, "agent")).toBe(0);
    expect(laneBudgetBytes(0, AUXILIARY_AGENT_ADMISSION_BYTES, "auxiliary")).toBe(0);
    const budget = 8960 * 1024 * 1024;
    expect(laneBudgetBytes(budget, AUXILIARY_AGENT_ADMISSION_BYTES, "auxiliary")).toBe(AUXILIARY_AGENT_ADMISSION_BYTES);
    expect(laneBudgetBytes(budget, AUXILIARY_AGENT_ADMISSION_BYTES, "agent")).toBe(budget - AUXILIARY_AGENT_ADMISSION_BYTES);
    // An auxiliary slice wider than the whole budget clamps rather than
    // handing the agent lane a negative budget.
    const tiny = 256 * 1024 * 1024;
    expect(laneBudgetBytes(tiny, AUXILIARY_AGENT_ADMISSION_BYTES, "auxiliary")).toBe(tiny);
    expect(laneBudgetBytes(tiny, AUXILIARY_AGENT_ADMISSION_BYTES, "agent")).toBe(0);
  });

  it("rejectAllWaiters drops every queued run instead of leaving it pending", async () => {
    const GiB = 1024 * 1024 * 1024;
    const gate = new AgentMemoryReservationGate(8960 * 1024 * 1024, AUXILIARY_AGENT_ADMISSION_BYTES);
    const holder = await gate.acquire(4 * GiB);
    const alsoHolder = await gate.acquire(4 * GiB);
    const queuedAgent = gate.acquireCancellable(4 * GiB);
    const agentSettled = queuedAgent.promise.catch((err: unknown) => err);
    const holdingAux = await gate.acquire(AUXILIARY_AGENT_ADMISSION_BYTES, "auxiliary");
    const queuedAux = gate.acquireCancellable(AUXILIARY_AGENT_ADMISSION_BYTES, "auxiliary");
    const auxSettled = queuedAux.promise.catch((err: unknown) => err);
    expect(gate.waiting).toBe(2);

    expect(gate.rejectAllWaiters(new Error("gate reset"))).toBe(2);
    expect(gate.waiting).toBe(0);
    expect(String(await agentSettled)).toContain("gate reset");
    expect(String(await auxSettled)).toContain("gate reset");

    holder.release();
    alsoHolder.release();
    holdingAux.release();
    expect(gate.reserved).toBe(0);
  });
});
