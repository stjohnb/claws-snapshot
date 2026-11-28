import type { AgentMemoryLimitError } from "./claude.js";
import type { AgentPodClass } from "./agent-pod-class.js";

/**
 * A run killed for memory, described independently of how it was killed, so
 * the in-process watchdog (an `AgentMemoryLimitError`) and the service-side
 * agent pod launcher (a Kubernetes `OOMKilled` pod) share one strike, escalate
 * and skip path (`handleMemoryLimitKill`) and one item comment.
 */
export interface MemoryLimitKill {
  /** `pss`: the shared-container watchdog killed on summed PSS.
   *  `kubernetes-oom`: Kubernetes OOM-killed the agent pod at its memory limit. */
  measurement: "pss" | "kubernetes-oom";
  /** The cap (watchdog) or pod memory limit (OOM) breached, in bytes; 0 when unknown. */
  limitBytes: number;
  /** The measured usage that breached it; null for an OOM, which records only the limit. */
  observedBytes: number | null;
  /** Summed per-process RSS at the kill, for diagnostics only. */
  rssBytes: number | null;
  /** Bytes of CLI output before the kill; null when unknown. */
  outputBytes: number | null;
  /** The agent pod class the run used; omitted for an in-process run, which has none. */
  podClass?: AgentPodClass;
  /** A default-class kill at the class's full limit, which escalates to large instead of counting a strike. */
  escalatable: boolean;
  sharedBudgetBytes: number | null;
  containerLimitBytes: number | null;
  headroomBytes: number | null;
}

/** Describe a watchdog kill. `escalatable` is the caller's decision. */
export function memoryLimitKillFromError(
  err: AgentMemoryLimitError,
  podClass: AgentPodClass | undefined,
  escalatable = false,
): MemoryLimitKill {
  return {
    measurement: err.measurement,
    limitBytes: err.limitBytes,
    observedBytes: err.observedBytes,
    rssBytes: err.rssBytes,
    outputBytes: err.outputBytes,
    ...(podClass ? { podClass } : {}),
    escalatable,
    sharedBudgetBytes: err.sharedBudgetBytes,
    containerLimitBytes: err.containerLimitBytes,
    headroomBytes: err.headroomBytes,
  };
}
