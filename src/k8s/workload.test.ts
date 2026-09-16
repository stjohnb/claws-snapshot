import { describe, it, expect } from "vitest";
import {
  buildSecretKeyPatch,
  buildWorkloadPod,
  buildWorkloadPvc,
  buildWorkloadSecret,
  buildWorkloadService,
  classifyPod,
  planWorkloadReconcile,
  workloadLabels,
  workloadName,
  workloadSelector,
  CLONE_ENV_KEY,
  LAUNCH_SPEC_KEY,
  TERMINAL_TOKEN_KEY,
  GITHUB_TOKEN_KEY,
  WORKLOAD_LAUNCH_GRACE_MS,
  type PodLike,
  type WorkloadRow,
} from "./workload.js";

const ref = { kind: "session", id: "abc123", namespace: "claws-sessions" };

type Loose = any;

function podSpec(overrides: Partial<Parameters<typeof buildWorkloadPod>[0]> = {}): Loose {
  return buildWorkloadPod({
    ...ref,
    image: "ghcr.io/st-john-software/claws:1.2.3",
    secretKeys: [LAUNCH_SPEC_KEY, CLONE_ENV_KEY, TERMINAL_TOKEN_KEY, GITHUB_TOKEN_KEY, "session.env"],
    ...overrides,
  });
}

function collectKeys(value: unknown, key: string, found: unknown[] = []): unknown[] {
  if (Array.isArray(value)) value.forEach((v) => collectKeys(v, key, found));
  else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      if (k === key) found.push(v);
      collectKeys(v, key, found);
    }
  }
  return found;
}

describe("naming and labels", () => {
  it("names workloads claws-<kind>-<id> and labels them", () => {
    expect(workloadName("session", "abc123")).toBe("claws-session-abc123");
    expect(workloadLabels("session", "abc123")).toEqual({
      "app.kubernetes.io/managed-by": "claws",
      "claws-workload": "session",
      "claws-workload-id": "abc123",
    });
    expect(workloadSelector("session")).toBe("app.kubernetes.io/managed-by=claws,claws-workload=session");
    expect(workloadSelector("session", "abc123")).toBe(
      "app.kubernetes.io/managed-by=claws,claws-workload=session,claws-workload-id=abc123",
    );
  });
});

describe("builders", () => {
  it("builds an Opaque Secret with base64 data and a key patch", () => {
    const secret: Loose = buildWorkloadSecret({ ...ref, data: { [TERMINAL_TOKEN_KEY]: "tok" } });
    expect(secret.metadata).toEqual({ name: "claws-session-abc123", namespace: "claws-sessions", labels: workloadLabels("session", "abc123") });
    expect(secret.data[TERMINAL_TOKEN_KEY]).toBe(Buffer.from("tok").toString("base64"));
    expect(buildSecretKeyPatch(GITHUB_TOKEN_KEY, "ghs_x")).toEqual({ data: { [GITHUB_TOKEN_KEY]: Buffer.from("ghs_x").toString("base64") } });
  });

  it("builds a ReadWriteOnce PVC", () => {
    const pvc: Loose = buildWorkloadPvc({ ...ref, storageClassName: "local-path", size: "20Gi" });
    expect(pvc.spec).toEqual({ accessModes: ["ReadWriteOnce"], storageClassName: "local-path", resources: { requests: { storage: "20Gi" } } });
  });

  it("builds a ClusterIP Service on 7681 selecting only this workload", () => {
    const svc: Loose = buildWorkloadService(ref);
    expect(svc.spec.type).toBe("ClusterIP");
    expect(svc.spec.selector).toEqual(workloadLabels("session", "abc123"));
    expect(svc.spec.ports).toEqual([{ name: "terminal", port: 7681, targetPort: 7681, protocol: "TCP" }]);
  });

  it("never sets ownerReferences on any object", () => {
    for (const obj of [
      podSpec(),
      buildWorkloadService(ref),
      buildWorkloadPvc({ ...ref, size: "1Gi" }),
      buildWorkloadSecret({ ...ref, data: {} }),
    ]) {
      expect(collectKeys(obj, "ownerReferences")).toEqual([]);
    }
  });

  it("builds a pod with the lifecycle and PSA-restricted security settings", () => {
    const pod = podSpec();
    expect(pod.spec.restartPolicy).toBe("Never");
    expect(pod.spec.automountServiceAccountToken).toBe(false);
    expect(pod.spec.enableServiceLinks).toBe(false);
    expect(pod.spec.securityContext).toMatchObject({
      runAsNonRoot: true, runAsUser: 1000, runAsGroup: 1000, fsGroup: 1000, seccompProfile: { type: "RuntimeDefault" },
    });
    for (const c of [...pod.spec.containers, ...pod.spec.initContainers]) {
      expect(c.securityContext).toEqual({
        runAsNonRoot: true,
        runAsUser: 1000,
        runAsGroup: 1000,
        allowPrivilegeEscalation: false,
        capabilities: { drop: ["ALL"] },
        seccompProfile: { type: "RuntimeDefault" },
      });
      expect(c.command).toBeUndefined();
      expect(c.args).toBeDefined();
    }
  });

  it("mounts the PVC at HOME plus an in-memory runtime dir and probes /healthz", () => {
    const pod = podSpec();
    const main = pod.spec.containers[0];
    expect(pod.spec.volumes).toContainEqual({ name: "home", persistentVolumeClaim: { claimName: "claws-session-abc123" } });
    expect(pod.spec.volumes).toContainEqual({ name: "runtime", emptyDir: { medium: "Memory", sizeLimit: "16Mi" } });
    expect(main.volumeMounts).toContainEqual({ name: "home", mountPath: "/home/claws" });
    expect(main.readinessProbe.httpGet).toEqual({ path: "/healthz", port: 7681 });
    expect(main.args).toEqual(["node", "/opt/claws/dist/session-pod/main.js", "serve"]);
    expect(pod.spec.initContainers[0].args).toEqual(["node", "/opt/claws/dist/session-pod/main.js", "prepare"]);
    expect(pod.spec.initContainers[0].image).toBe(main.image);
  });

  it("projects the Secret by items, never via subPath, and keeps clone-env.json out of the main container", () => {
    const pod = podSpec();
    expect(collectKeys(pod, "subPath")).toEqual([]);

    const secretVolume = pod.spec.volumes.find((v: Loose) => v.name === "secret");
    const mainKeys = secretVolume.secret.items.map((i: Loose) => i.key);
    expect(mainKeys).not.toContain(CLONE_ENV_KEY);
    expect(mainKeys).toEqual([LAUNCH_SPEC_KEY, TERMINAL_TOKEN_KEY, GITHUB_TOKEN_KEY, "session.env"]);
    expect(pod.spec.containers[0].volumeMounts.map((m: Loose) => m.name)).not.toContain("init-secret");

    const initVolume = pod.spec.volumes.find((v: Loose) => v.name === "init-secret");
    expect(initVolume.secret.items.map((i: Loose) => i.key)).toEqual([LAUNCH_SPEC_KEY, CLONE_ENV_KEY]);
    expect(pod.spec.initContainers[0].volumeMounts.map((m: Loose) => m.name)).toEqual(["home", "init-secret"]);
  });

  it("applies scheduling and resource options, and omits the init container on request", () => {
    const pod = podSpec({
      imagePullSecrets: ["ghcr-pull"],
      nodeSelector: { "kubernetes.io/hostname": "k3s" },
      priorityClassName: "sessions",
      resources: { cpuRequest: "250m", memoryRequest: "1Gi", memoryLimit: "6Gi" },
      initArgs: null,
    });
    expect(pod.spec.imagePullSecrets).toEqual([{ name: "ghcr-pull" }]);
    expect(pod.spec.nodeSelector).toEqual({ "kubernetes.io/hostname": "k3s" });
    expect(pod.spec.priorityClassName).toBe("sessions");
    expect(pod.spec.containers[0].resources).toEqual({ requests: { cpu: "250m", memory: "1Gi" }, limits: { memory: "6Gi" } });
    expect(pod.spec.initContainers).toBeUndefined();
    expect(pod.spec.volumes.map((v: Loose) => v.name)).not.toContain("init-secret");
  });
});

describe("classifyPod", () => {
  it.each<[string, PodLike, ReturnType<typeof classifyPod>]>([
    ["no status", {}, { state: "unknown" }],
    ["Pending", { status: { phase: "Pending" } }, { state: "pending" }],
    [
      "Pending with image pull backoff",
      { status: { phase: "Pending", containerStatuses: [{ state: { waiting: { reason: "ImagePullBackOff" } } }] } },
      { state: "pending", detail: "ImagePullBackOff" },
    ],
    ["Running, not ready", { status: { phase: "Running", conditions: [{ type: "Ready", status: "False" }] } }, { state: "running" }],
    ["Running and ready", { status: { phase: "Running", conditions: [{ type: "Ready", status: "True" }] } }, { state: "ready" }],
    [
      "Succeeded",
      { status: { phase: "Succeeded", containerStatuses: [{ state: { terminated: { exitCode: 0 } } }] } },
      { state: "succeeded", exitCode: 0 },
    ],
    [
      "Failed with exit code",
      { status: { phase: "Failed", containerStatuses: [{ state: { terminated: { exitCode: 2, reason: "Error" } } }] } },
      { state: "failed", detail: "exit code 2", exitCode: 2 },
    ],
    ["Evicted", { status: { phase: "Failed", reason: "Evicted" } }, { state: "failed", detail: "Evicted" }],
    [
      "OOMKilled",
      { status: { phase: "Failed", containerStatuses: [{ state: { terminated: { exitCode: 137, reason: "OOMKilled" } } }] } },
      { state: "failed", detail: "OOMKilled", exitCode: 137 },
    ],
    [
      "init container failed",
      { status: { phase: "Failed", initContainerStatuses: [{ state: { terminated: { exitCode: 1 } } }] } },
      { state: "failed", detail: "exit code 1", exitCode: 1 },
    ],
    ["Unknown phase", { status: { phase: "Unknown" } }, { state: "unknown", detail: "Unknown" }],
  ])("%s", (_name, pod, expected) => {
    expect(classifyPod(pod)).toEqual(expected);
  });
});

describe("planWorkloadReconcile", () => {
  const now = 10_000_000;
  const graceMs = WORKLOAD_LAUNCH_GRACE_MS;

  function pod(id: string, phase: string, extra: Partial<NonNullable<PodLike["status"]>> = {}, meta: Partial<NonNullable<PodLike["metadata"]>> = {}): PodLike {
    return {
      metadata: { name: `claws-session-${id}`, labels: workloadLabels("session", id), ...meta },
      status: { phase, ...extra },
    };
  }
  function row(id: string, over: Partial<WorkloadRow> = {}): WorkloadRow {
    return { id, launched_at: now - graceMs - 1, ended_at: null, ...over };
  }
  function plan(rows: WorkloadRow[], pods: PodLike[], launching: string[] = []) {
    return planWorkloadReconcile({ rows, pods, launching: new Set(launching), now, graceMs });
  }

  it("keeps an open row with a running pod live", () => {
    const p = plan([row("a")], [pod("a", "Running", { conditions: [{ type: "Ready", status: "True" }] })]);
    expect(p).toEqual({
      live: [{ id: "a", podName: "claws-session-a", classification: { state: "ready" } }],
      markEnded: [], deletePodsForEndedRows: [], orphanPods: [],
    });
  });

  it("keeps a pending pod live", () => {
    expect(plan([row("a")], [pod("a", "Pending")]).live.map((l) => l.id)).toEqual(["a"]);
  });

  it.each([
    ["Succeeded", {}, "pod succeeded", 0],
    ["Failed", { reason: "Evicted" }, "pod failed: Evicted", 1],
    ["Failed", { containerStatuses: [{ state: { terminated: { exitCode: 2 } } }] }, "pod failed: exit code 2", 2],
  ])("marks a row ended when its pod is %s", (phase, extra, reason, exitCode) => {
    const p = plan([row("a")], [pod("a", phase, extra)]);
    expect(p.markEnded).toEqual([{ id: "a", reason, exitCode }]);
    expect(p.live).toEqual([]);
  });

  it("marks a row ended when its pod is missing past the grace window", () => {
    expect(plan([row("a")], []).markEnded).toEqual([{ id: "a", reason: "pod not found", exitCode: 1 }]);
  });

  it("leaves a podless row alone inside the grace window", () => {
    const p = plan([row("a", { launched_at: now - graceMs + 1000 })], []);
    expect(p.markEnded).toEqual([]);
    expect(p.live).toEqual([]);
  });

  it("gives a just-resumed row the launch grace even when its pod is missing from the list", () => {
    // Reconcile listed pods before the resume created one; by the DB read the
    // row had reopened and left `launching`. Its recent launch must protect it.
    const p = plan([row("a", { launched_at: now - 1000 })], []);
    expect(p).toEqual({ live: [], markEnded: [], deletePodsForEndedRows: [], orphanPods: [] });
  });

  it("leaves a launching id alone: no pod, terminal pod, or ended row", () => {
    const p = plan(
      [row("a"), row("b"), row("c", { ended_at: now - 5 })],
      [pod("b", "Failed"), pod("c", "Running")],
      ["a", "b", "c"],
    );
    expect(p).toEqual({ live: [], markEnded: [], deletePodsForEndedRows: [], orphanPods: [] });
  });

  it("deletes the pod of an ended row, unless it is already terminating", () => {
    const p = plan(
      [row("a", { ended_at: now - 5 }), row("b", { ended_at: now - 5 })],
      [pod("a", "Running"), pod("b", "Running", {}, { deletionTimestamp: "2026-09-14T00:00:00Z" })],
    );
    expect(p.deletePodsForEndedRows).toEqual(["claws-session-a"]);
    expect(p.markEnded).toEqual([]);
  });

  it("reports pods with no row as orphans only", () => {
    const unlabeled: PodLike = { metadata: { name: "claws-session-mystery", labels: {} }, status: { phase: "Running" } };
    const p = plan([], [pod("zzz", "Running"), unlabeled]);
    expect(p).toEqual({ live: [], markEnded: [], deletePodsForEndedRows: [], orphanPods: ["claws-session-zzz", "claws-session-mystery"] });
  });

  it("does not report a terminating pod with no row as an orphan", () => {
    const p = plan([], [pod("zzz", "Running", {}, { deletionTimestamp: "2026-09-14T00:00:00Z" })]);
    expect(p.orphanPods).toEqual([]);
  });

  it("never plans a PVC action", () => {
    const p = plan(
      [row("a"), row("b", { ended_at: now - 5 }), row("c")],
      [pod("b", "Running"), pod("c", "Failed"), pod("orphan", "Running")],
    );
    expect(Object.keys(p).sort()).toEqual(["deletePodsForEndedRows", "live", "markEnded", "orphanPods"]);
    expect(JSON.stringify(p).toLowerCase()).not.toContain("pvc");
    expect(JSON.stringify(p).toLowerCase()).not.toContain("persistentvolumeclaim");
  });
});
