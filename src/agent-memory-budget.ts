import fs from "node:fs";

export const DEFAULT_AGENT_WORKER_MEMORY_MAX_BYTES = 2 * 1024 * 1024 * 1024;

/**
 * Bytes withheld from the container limit when deriving the shared budget —
 * the Claws service's own footprint (dashboard, scheduler, pollers, page
 * cache), which never passes through admission.
 *
 * Everything *else* in the container is accounted for by the budget: the
 * auxiliary lane is carved out of the budget (see
 * {@link AUXILIARY_AGENT_ADMISSION_BYTES}), not out of this headroom, so
 * raising the agent cap no longer silently squeezes the short bookkeeping
 * calls. At the deployed policy (10 GiB container, 4 GiB cap) the derived
 * budget is 8960 MiB = two full-cap agent reservations (8192 MiB) plus the
 * 768 MiB auxiliary lane, leaving this 1280 MiB for the service itself.
 */
export const DEFAULT_AGENT_WORKER_MEMORY_HEADROOM_BYTES = 1280 * 1024 * 1024;

/**
 * The auxiliary workload class: short bookkeeping CLI calls (PR descriptions,
 * no-commit diagnoses, complexity classification, text extraction from
 * email/WhatsApp). They run for seconds and never grow anywhere near the agent
 * cap, so they get their own lane in the gate and never queue behind a
 * multi-hour implementer.
 *
 * This is an *enforced* number, not an estimate: it is both the run's
 * reservation against the shared budget and the run's watchdog cap, so the sum
 * of live reservations stays an upper bound on the RSS the watchdogs tolerate.
 * An auxiliary run that genuinely needs more is killed with
 * `AgentMemoryLimitError` at this cap — a diagnosable outcome — rather than
 * silently overdrawing the budget. {@link AUXILIARY_NODE_MAX_OLD_SPACE_MB}
 * keeps the Claude CLI's own V8 ceiling below it so the cap has real slack.
 *
 * Some of these calls (`generatePRDescription`, `regeneratePRDescription`,
 * `diagnoseNoCommitsForRange`) run rooted in a worktree with the full tool set
 * rather than in a scratch dir with none, so 768 MiB is not free slack for
 * them: it is 512 MiB of V8 heap plus ~256 MiB for the process baseline and a
 * short-lived `git`/`gh` child. It is deliberately not raised to buy margin —
 * this slice is carved out of the shared budget, and at the deployed 10 GiB
 * policy anything above 768 MiB stops two full-cap agent runs from overlapping.
 * A call site that measurably needs more should pass a larger `admissionBytes`
 * (which also raises its watchdog cap) and the auxiliary lane should be resized
 * with it.
 */
export const AUXILIARY_AGENT_ADMISSION_BYTES = 768 * 1024 * 1024;

/**
 * V8 old-space ceiling handed to the Claude CLI for an auxiliary run.
 *
 * The ordinary 1024 MiB ceiling is larger than the whole auxiliary slice, so a
 * CLI that actually used its heap would be watchdog-killed at 768 MiB. These
 * calls summarise a truncated diff; 512 MiB is well above what that needs and
 * leaves ~256 MiB of the slice for the process baseline and any `git`/`gh`
 * child.
 */
export const AUXILIARY_NODE_MAX_OLD_SPACE_MB = 512;

/** The smallest watchdog cap or shared budget that could plausibly run an agent
 *  CLI. Anything lower is almost certainly a unit-suffix typo ("4.5GiB" parsed
 *  as 4) rather than a deliberate setting. */
export const MIN_PLAUSIBLE_AGENT_MEMORY_BYTES = 64 * 1024 * 1024;

/**
 * Bytes withheld from an agent pod's own memory limit when deriving its
 * watchdog cap (decision 5 of #clw_01M3A5BDFHK8C03Q8BP0NC37QC): the default
 * headroom plus the auxiliary lane. Sizing the margin to exactly those two
 * numbers means the shared budget `computeAgentMemoryPolicy()` derives from
 * the pod's own cgroup limit lands on the cap itself, so admission for a
 * single-row pod stays on without any explicit override.
 */
export const AGENT_POD_WATCHDOG_MARGIN_BYTES = DEFAULT_AGENT_WORKER_MEMORY_HEADROOM_BYTES + AUXILIARY_AGENT_ADMISSION_BYTES;

/**
 * The in-pod memory watchdog cap, derived from the pod's own container limit
 * rather than inherited from the service's env (which is tuned for the
 * service's own, differently-sized container). Floors at
 * {@link DEFAULT_AGENT_WORKER_MEMORY_MAX_BYTES} — including when
 * `podLimitBytes` is null, e.g. an unparseable `CLAWS_AGENT_POD_MEMORY_LIMIT`.
 */
export function agentPodWatchdogCapBytes(podLimitBytes: number | null): number {
  if (podLimitBytes === null) return DEFAULT_AGENT_WORKER_MEMORY_MAX_BYTES;
  return Math.max(DEFAULT_AGENT_WORKER_MEMORY_MAX_BYTES, podLimitBytes - AGENT_POD_WATCHDOG_MARGIN_BYTES);
}

/**
 * Which lane of the gate a run draws from. The lanes have independent budgets
 * and independent FIFO queues, so an auxiliary call is never blocked by a
 * queued agent-scale run (and vice versa).
 */
export type AgentMemoryLane = "agent" | "auxiliary";

const HOST_LIMIT_SENTINEL_BYTES = 1_000_000_000_000_000;

export interface AgentMemoryPolicy {
  defaultCapBytes: number;
  containerLimitBytes: number | null;
  headroomBytes: number;
  sharedBudgetBytes: number | null;
  /** Slice of the shared budget reserved for the auxiliary lane. */
  auxiliaryBudgetBytes: number;
  admissionActive: boolean;
  /** True when `headroom` swallowed the container limit and the derived budget
   *  was clamped to a floor instead of collapsing to `0` (which would disable
   *  admission entirely, silently). */
  headroomClamped: boolean;
}

export interface AgentMemoryDiagnostics {
  effectiveLimitBytes: number;
  sharedBudgetBytes: number | null;
  containerLimitBytes: number | null;
  headroomBytes: number;
  admissionActive: boolean;
  auxiliaryBudgetBytes: number;
  lane: AgentMemoryLane;
  headroomClamped: boolean;
}

const K8S_BINARY_SUFFIXES: Record<string, number> = { Ki: 1024, Mi: 1024 ** 2, Gi: 1024 ** 3, Ti: 1024 ** 4 };
const K8S_DECIMAL_SUFFIXES: Record<string, number> = { k: 1000, M: 1000 ** 2, G: 1000 ** 3, T: 1000 ** 4 };

/**
 * Parses a Kubernetes resource quantity (e.g. a pod's `memory` limit as
 * reported in its manifest — `"6Gi"`, `"512Mi"`, `"6G"`) into bytes.
 *
 * Binary suffixes (`Ki Mi Gi Ti`, ×1024ⁿ) and decimal suffixes (`k M G T`,
 * ×1000ⁿ) are deliberately kept distinct — `"6G"` is 6×10⁹ bytes, not 6 GiB —
 * matching Kubernetes' own quantity format. A decimal mantissa (`"1.5Gi"`) is
 * floored. Returns null for an empty, negative, or otherwise unparseable value
 * (including a non-Kubernetes unit like `"6GB"`).
 */
export function parseK8sMemoryQuantity(raw: string | undefined | null): number | null {
  const value = (raw ?? "").trim();
  if (!value) return null;
  const match = /^(\d+(?:\.\d+)?)(Ki|Mi|Gi|Ti|k|M|G|T)?$/.exec(value);
  if (!match) return null;
  const mantissa = Number(match[1]);
  if (!Number.isFinite(mantissa) || mantissa < 0) return null;
  const suffix = match[2];
  const multiplier = suffix ? (K8S_BINARY_SUFFIXES[suffix] ?? K8S_DECIMAL_SUFFIXES[suffix]) : 1;
  return Math.floor(mantissa * multiplier);
}

export function parseCgroupMemoryLimit(raw: string | undefined | null): number | null {
  const value = (raw ?? "").trim();
  if (!value || value === "max") return null;
  if (!/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return null;
  if (parsed >= HOST_LIMIT_SENTINEL_BYTES) return null;
  return parsed;
}

export function readCgroupMemoryLimitBytes(fsLike: Pick<typeof fs, "readFileSync"> = fs): number | null {
  for (const file of ["/sys/fs/cgroup/memory.max", "/sys/fs/cgroup/memory/memory.limit_in_bytes"]) {
    try {
      const parsed = parseCgroupMemoryLimit(String(fsLike.readFileSync(file, "utf8")));
      if (parsed !== null) return parsed;
    } catch {
      // Missing cgroup files are normal outside containers.
    }
  }
  return null;
}

let cachedCgroupLimitBytes: number | null | undefined = undefined;

/**
 * The container's memory limit cannot change for the life of the process, so
 * read it once instead of on every agent spawn — `computeAgentMemoryPolicy()`
 * runs per `runCliProcess()` call and would otherwise hit `/sys/fs/cgroup`
 * twice each time.
 */
export function cgroupMemoryLimitBytes(): number | null {
  if (cachedCgroupLimitBytes === undefined) {
    cachedCgroupLimitBytes = readCgroupMemoryLimitBytes();
  }
  return cachedCgroupLimitBytes;
}

/** Drops the memoized limit so a test can vary the mocked cgroup files. */
export function resetCgroupLimitCacheForTests(): void {
  cachedCgroupLimitBytes = undefined;
}

/** Slice of a shared budget reserved for the auxiliary lane. Never more than
 *  half the budget: on a small explicit budget the bookkeeping calls must not
 *  crowd out the agent runs they exist to serve. */
function auxiliaryLaneBytes(sharedBudgetBytes: number | null): number {
  if (sharedBudgetBytes === null || sharedBudgetBytes <= 0) return 0;
  return Math.min(AUXILIARY_AGENT_ADMISSION_BYTES, Math.floor(sharedBudgetBytes / 2));
}

/**
 * Bytes one lane of the gate may hold.
 *
 * The single definition of the denominator admission is decided against: the
 * gate uses it to admit, `claude.ts` uses it for the "cap exceeds its lane"
 * warning and for the wait log. Computing it separately at any of those sites
 * lets the log and the decision disagree, which is how a whole band of caps
 * came to serialize silently.
 */
export function laneBudgetBytes(
  sharedBudgetBytes: number | null,
  auxiliaryBudgetBytes: number,
  lane: AgentMemoryLane,
): number {
  if (sharedBudgetBytes === null || sharedBudgetBytes <= 0) return 0;
  const auxiliary = Math.max(0, Math.min(Math.floor(auxiliaryBudgetBytes), sharedBudgetBytes));
  return lane === "auxiliary" ? auxiliary : sharedBudgetBytes - auxiliary;
}

export function computeAgentMemoryPolicy(input: {
  defaultCapBytes: number;
  headroomBytes?: number;
  explicitSharedBudgetBytes?: number | null;
  containerLimitBytes?: number | null;
}): AgentMemoryPolicy {
  const defaultCapBytes = Math.max(0, Math.floor(input.defaultCapBytes));
  const headroomBytes = Math.max(0, Math.floor(input.headroomBytes ?? DEFAULT_AGENT_WORKER_MEMORY_HEADROOM_BYTES));
  const containerLimitBytes = input.containerLimitBytes === undefined
    ? cgroupMemoryLimitBytes()
    : input.containerLimitBytes;
  const explicitSharedBudgetBytes = input.explicitSharedBudgetBytes;
  // A headroom at or above the container limit must never derive a `0` budget:
  // `0` means "admission disabled", and an operator who over-reserved headroom
  // asked for *less* concurrency, not for none of the safety. Clamp to the cap
  // instead — that degrades to strict one-run-at-a-time — and report the clamp
  // so the caller can say so in the log.
  let headroomClamped = false;
  let derivedSharedBudgetBytes: number | null = null;
  if (defaultCapBytes > 0 && containerLimitBytes !== null) {
    const remaining = containerLimitBytes - headroomBytes;
    if (remaining < MIN_PLAUSIBLE_AGENT_MEMORY_BYTES) {
      headroomClamped = true;
      derivedSharedBudgetBytes = Math.min(
        containerLimitBytes,
        Math.max(defaultCapBytes, MIN_PLAUSIBLE_AGENT_MEMORY_BYTES),
      );
    } else {
      derivedSharedBudgetBytes = remaining;
    }
  }
  const sharedBudgetBytes =
    explicitSharedBudgetBytes !== undefined && explicitSharedBudgetBytes !== null
      ? Math.max(0, Math.floor(explicitSharedBudgetBytes))
      : derivedSharedBudgetBytes;
  return {
    defaultCapBytes,
    containerLimitBytes,
    headroomBytes,
    sharedBudgetBytes,
    auxiliaryBudgetBytes: auxiliaryLaneBytes(sharedBudgetBytes),
    admissionActive: sharedBudgetBytes !== null && sharedBudgetBytes > 0,
    // An explicit budget overrides the derivation entirely, so a clamp that did
    // not survive into the budget is not worth reporting.
    headroomClamped: headroomClamped && sharedBudgetBytes === derivedSharedBudgetBytes,
  };
}

/**
 * The single per-run ceiling, used for **both** the watchdog cap and the
 * admission reservation.
 *
 * Keeping them one number is what makes `sum(reservations) <= sharedBudget` a
 * real bound on container RSS: a run that declares a small auxiliary slice is
 * also *held* to it, so it cannot reserve 768 MiB and then grow to the 4 GiB
 * global cap.
 *
 * `admissionBytes` only ever lowers the ceiling, and it is ignored entirely
 * when the watchdog is globally disabled (`effectiveLimitBytes === 0`) — with
 * nothing enforcing the slice there is no basis for reserving less than a
 * full, unbounded run.
 */
export function computeRunCapBytes(effectiveLimitBytes: number, admissionBytes?: number): number {
  const effective = Math.max(0, Math.floor(effectiveLimitBytes));
  if (effective <= 0) return 0;
  const declared = Math.max(0, Math.floor(admissionBytes ?? 0));
  return declared > 0 ? Math.min(effective, declared) : effective;
}

/**
 * Bytes one run reserves against the shared budget.
 *
 * `effectiveLimitBytes` is the run's already-clamped cap from
 * {@link computeRunCapBytes}, so the reservation equals what the watchdog
 * enforces. The one exception is an operator-disabled watchdog
 * (`agentWorkerMemoryMaxBytes=0`) with an explicit shared budget: those runs
 * must still consume a slot, and having no known ceiling they conservatively
 * reserve their requested per-call cap, or the whole budget, and therefore run
 * alone.
 */
export function computeAdmissionReservationBytes(input: {
  admissionActive: boolean;
  sharedBudgetBytes: number | null;
  effectiveLimitBytes: number;
  requestedMemoryMaxBytes?: number;
}): number {
  const budget = input.sharedBudgetBytes;
  if (!input.admissionActive || budget === null || budget <= 0) return 0;
  const effective = Math.max(0, Math.floor(input.effectiveLimitBytes));
  if (effective > 0) return effective;
  const requested = Math.max(0, Math.floor(input.requestedMemoryMaxBytes ?? 0));
  return requested > 0 ? requested : budget;
}

interface Waiter {
  requestedBytes: number;
  lane: AgentMemoryLane;
  settled: boolean;
  resolve: (reservation: AgentMemoryReservation) => void;
  reject: (reason: Error) => void;
}

export interface AgentMemoryReservation {
  requestedBytes: number;
  lane: AgentMemoryLane;
  release: () => void;
}

export interface AgentMemoryAcquisition {
  /** Resolves once the run is admitted; rejects if `cancel()` wins the race. */
  readonly promise: Promise<AgentMemoryReservation>;
  /** True while the run is still waiting behind others. Admission is granted
   *  synchronously when the budget allows, so reading this immediately after
   *  `acquireCancellable()` distinguishes a contended run from the common
   *  uncontended one. */
  readonly queued: boolean;
  /** Drops a still-queued waiter and rejects its promise with `reason`.
   *  Returns false once the reservation has already been granted. */
  cancel: (reason: Error) => boolean;
}

/**
 * Two-lane admission gate.
 *
 * The agent lane holds the full-cap implementer/reviewer runs; the auxiliary
 * lane holds the short bookkeeping calls. Each lane has its own budget and its
 * own FIFO queue, so head-of-line blocking is confined to one workload class:
 * a 768 MiB PR-description call can never be stuck behind a queued 4 GiB
 * implementer, which is the whole point of the auxiliary class. The lane
 * budgets partition the shared budget, so the sum of live reservations is
 * still bounded by it — including on the escape-hatch path, where a run larger
 * than its own lane is admitted only with the gate completely empty and holds
 * *both* lanes closed until it releases.
 */
export class AgentMemoryReservationGate {
  private readonly queues: Record<AgentMemoryLane, Waiter[]> = { agent: [], auxiliary: [] };
  private readonly reservedByLane: Record<AgentMemoryLane, number> = { agent: 0, auxiliary: 0 };
  private running = 0;
  /** True while a run admitted through the over-lane escape hatch holds its
   *  reservation. That run is already larger than its lane, so nothing else may
   *  be admitted in *either* lane until it releases — see {@link canRun}. */
  private soloReservation = false;

  constructor(
    private sharedBudgetBytes: number | null,
    private auxiliaryBudgetBytes: number = auxiliaryLaneBytes(sharedBudgetBytes),
  ) {}

  get active(): boolean {
    return this.sharedBudgetBytes !== null && this.sharedBudgetBytes > 0;
  }

  get reserved(): number {
    return this.reservedByLane.agent + this.reservedByLane.auxiliary;
  }

  get budget(): number | null {
    return this.sharedBudgetBytes;
  }

  /** Portion of {@link budget} reserved for the auxiliary lane. */
  get auxiliaryBudget(): number {
    return this.laneBudget("auxiliary");
  }

  /** Bytes this lane may hold. The auxiliary slice is carved out of the shared
   *  budget, so the two lanes together can never exceed it. Public because the
   *  wait log and the cap warning must reason about the same number admission
   *  does. */
  laneBudget(lane: AgentMemoryLane): number {
    return laneBudgetBytes(this.sharedBudgetBytes, this.auxiliaryBudgetBytes, lane);
  }

  /** Runs admitted and still holding a reservation. */
  get admitted(): number {
    return this.running;
  }

  /** Runs parked in either queue. Non-zero means agents the dashboard reports
   *  as "running" are actually blocked on memory, not working. */
  get waiting(): number {
    return this.queues.agent.length + this.queues.auxiliary.length;
  }

  /**
   * Retune the live budget instead of replacing the gate.
   *
   * An operator editing `agentWorkerMemory*` mid-flight must not create a
   * second, empty accounting domain: a fresh gate cannot see the bytes the
   * in-flight runs already hold, so it would hand the whole budget out again —
   * over-committing the container at exactly the moment the operator was
   * tightening it. Raising the budget re-drains so anything now admissible goes
   * immediately; lowering it simply stops admitting until releases catch up.
   */
  setBudget(sharedBudgetBytes: number | null, auxiliaryBudgetBytes: number = auxiliaryLaneBytes(sharedBudgetBytes)): void {
    if (this.sharedBudgetBytes === sharedBudgetBytes && this.auxiliaryBudgetBytes === auxiliaryBudgetBytes) return;
    this.sharedBudgetBytes = sharedBudgetBytes;
    this.auxiliaryBudgetBytes = auxiliaryBudgetBytes;
    this.drain();
  }

  /**
   * Drop every still-queued waiter, rejecting each with `reason`. Returns how
   * many were dropped.
   *
   * Only the test reset uses this: discarding the gate with waiters still
   * parked in it leaves permanently-pending promises and a swallowed
   * `runClaude` call, so leakage has to fail loudly rather than vanish into the
   * next test.
   */
  rejectAllWaiters(reason: Error): number {
    let dropped = 0;
    for (const lane of ["agent", "auxiliary"] as const) {
      const queue = this.queues[lane];
      while (queue.length > 0) {
        const waiter = queue.shift()!;
        waiter.settled = true;
        waiter.reject(reason);
        dropped += 1;
      }
    }
    return dropped;
  }

  acquire(requestedBytes: number, lane: AgentMemoryLane = "agent"): Promise<AgentMemoryReservation> {
    return this.acquireCancellable(requestedBytes, lane).promise;
  }

  /** Like `acquire()`, but a still-queued waiter can be dropped — a run
   *  cancelled while waiting must never go on to spawn a process. */
  acquireCancellable(requestedBytes: number, lane: AgentMemoryLane = "agent"): AgentMemoryAcquisition {
    const request = Math.max(0, Math.floor(requestedBytes));
    if (!this.active || request === 0) {
      return {
        promise: Promise.resolve({ requestedBytes: request, lane, release: () => {} }),
        queued: false,
        cancel: () => false,
      };
    }
    let waiter: Waiter | undefined;
    const promise = new Promise<AgentMemoryReservation>((resolve, reject) => {
      waiter = { requestedBytes: request, lane, settled: false, resolve, reject };
      this.queues[lane].push(waiter);
      this.drain();
    });
    return {
      promise,
      get queued() { return waiter !== undefined && !waiter.settled; },
      cancel: (reason: Error) => {
        if (!waiter || waiter.settled) return false;
        const queue = this.queues[waiter.lane];
        const index = queue.indexOf(waiter);
        if (index === -1) return false;
        queue.splice(index, 1);
        waiter.settled = true;
        waiter.reject(reason);
        // Dropping the head can unblock a smaller waiter queued behind it.
        this.drain();
        return true;
      },
    };
  }

  private canRun(lane: AgentMemoryLane, requestedBytes: number): boolean {
    if (!this.active) return true;
    // An over-lane run really does run alone: it is already larger than its own
    // lane, so admitting anything alongside it — including an auxiliary call
    // that fits its own lane perfectly well — is exactly the over-commit the
    // budget exists to prevent.
    if (this.soloReservation) return false;
    const laneBudget = this.laneBudget(lane);
    // A single run whose cap exceeds its whole lane would otherwise deadlock.
    // Let it through only when nothing at all is reserved, and lock both lanes
    // for its duration.
    if (requestedBytes > laneBudget) return this.reserved === 0 && this.running === 0;
    return this.reservedByLane[lane] + requestedBytes <= laneBudget;
  }

  private drain(): void {
    // Agent-scale runs are the work Claws exists to do, so they get first
    // refusal on the "runs alone" escape hatch; the lanes are otherwise
    // independent and the order does not matter.
    this.drainLane("agent");
    this.drainLane("auxiliary");
  }

  private drainLane(lane: AgentMemoryLane): void {
    const queue = this.queues[lane];
    while (queue.length > 0) {
      const next = queue[0]!;
      if (!this.canRun(lane, next.requestedBytes)) return;
      queue.shift();
      next.settled = true;
      const solo = this.active && next.requestedBytes > this.laneBudget(lane);
      if (solo) this.soloReservation = true;
      this.running += 1;
      this.reservedByLane[lane] += next.requestedBytes;
      let released = false;
      next.resolve({
        requestedBytes: next.requestedBytes,
        lane,
        release: () => {
          if (released) return;
          released = true;
          if (solo) this.soloReservation = false;
          this.running -= 1;
          this.reservedByLane[lane] -= next.requestedBytes;
          this.drain();
        },
      });
    }
  }
}
