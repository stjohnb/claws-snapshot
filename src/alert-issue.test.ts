import { describe, it, expect } from "vitest";
import {
  ALERT_BRIDGE_FOOTER,
  alertGroupKey,
  alertOwnerRepos,
  legacyAlertDedupeKey,
  serviceDedupeKey,
  splitAlertGroupName,
  isAlertBridgeOwned,
  isAlertInbox,
  isHeldAlertLifecycle,
} from "./alert-issue.js";

describe("isAlertBridgeOwned", () => {
  it("is true for the grafana-alert label", () => {
    expect(isAlertBridgeOwned({ labels: ["grafana-alert"], body: "" })).toBe(true);
  });

  it("is true for the alert label", () => {
    expect(isAlertBridgeOwned({ labels: ["bug", "alert"], body: "" })).toBe(true);
  });

  it("is true for the bridge footer, even behind an import prefix", () => {
    expect(isAlertBridgeOwned({ labels: [], body: `Imported from org/repo#1 (opened by bot)\n\nDisk full\n\n---\n_${ALERT_BRIDGE_FOOTER}_` })).toBe(true);
  });

  it("is true for a consolidated bridge body", () => {
    expect(isAlertBridgeOwned({ labels: [], body: "Imported from org/repo#1\n\n## Currently firing\n\n- X\n\n## Alerts\n\n### X\n" })).toBe(true);
  });

  it("is false for a plain issue", () => {
    expect(isAlertBridgeOwned({ labels: ["bug", "alerting"], body: "Alerts are noisy" })).toBe(false);
  });
});

describe("legacyAlertDedupeKey", () => {
  it.each([
    ["Workload CI Runner Evicted", "alert-workload-ci-runner-evicted"],
    ["  KubePod: CrashLooping (prod)!! ", "alert-kubepod-crashlooping-prod"],
    ["disk_space__low", "alert-disk-space-low"],
    ["!!!", "alert-unknown"],
    ["", "alert-unknown"],
    ["Ünïcode Alert", "alert-n-code-alert"],
  ])("slugs %j to %s", (name, key) => {
    expect(legacyAlertDedupeKey(name)).toBe(key);
  });

  it("cuts the slug to 90 characters before stripping a trailing dash", () => {
    expect(legacyAlertDedupeKey("a".repeat(120))).toBe(`alert-${"a".repeat(90)}`);
    expect(legacyAlertDedupeKey(`${"a".repeat(89)} b`)).toBe(`alert-${"a".repeat(89)}`);
  });
});

describe("per-service alert keys", () => {
  it("splits a group name on its first ` / `", () => {
    expect(splitAlertGroupName("namey / AppRequestLatencyP95Regression")).toEqual({ service: "namey", alert: "AppRequestLatencyP95Regression" });
    expect(splitAlertGroupName("claws / Claws error logged: api / poll")).toEqual({ service: "claws", alert: "Claws error logged: api / poll" });
    expect(splitAlertGroupName("FluxReconcileFailed")).toEqual({ service: "", alert: "FluxReconcileFailed" });
  });

  it("keys a legacy service issue by its service slug", () => {
    expect(serviceDedupeKey("namey-pet")).toBe("alert-service-namey-pet");
    expect(serviceDedupeKey("!!")).toBe("alert-service-unknown");
  });

  it("cuts the legacy service slug to 90 characters and trims it", () => {
    expect(serviceDedupeKey("A".repeat(120))).toBe(`alert-service-${"a".repeat(90)}`);
    expect(serviceDedupeKey(`${"a".repeat(89)} b`)).toBe(`alert-service-${"a".repeat(89)}`);
  });
});

describe("alertOwnerRepos", () => {
  const bridge = { serviceRepos: { "bonkus-player-reports": ["o/bonkus"], "Bonkus Player Reports": ["O/Bonkus", "o/extra"], bonkus: ["o/bonkus"], namey: ["o/namey"] } };

  it("resolves an alert-group key by its service slug, never a service that only shares a prefix", () => {
    expect(alertOwnerRepos(bridge, alertGroupKey("Bonkus Player Reports / ErrorLogged"))).toEqual(["o/bonkus", "o/extra"]);
    expect(alertOwnerRepos(bridge, alertGroupKey("bonkus / BonkusErrorLogged"))).toEqual(["o/bonkus"]);
    expect(alertOwnerRepos(bridge, alertGroupKey("plausible / Down"))).toEqual([]);
  });

  it("is empty for a legacy service key, a bare alert key or a missing map", () => {
    expect(alertOwnerRepos(bridge, "alert-service-bonkus")).toEqual([]);
    expect(alertOwnerRepos(bridge, "alert-namey")).toEqual([]);
    expect(alertOwnerRepos({}, alertGroupKey("bonkus / X"))).toEqual([]);
    expect(alertOwnerRepos(null, alertGroupKey("bonkus / X"))).toEqual([]);
  });
});

describe("alertGroupKey", () => {
  it("keys a <service> / <alert> group exactly, and a bare alert by its legacy key", () => {
    expect(alertGroupKey("namey / KubePodCrashLooping")).toBe("alert-group-namey.kubepodcrashlooping");
    expect(alertGroupKey("Bonkus Player Reports / Error: DB timeout")).toBe("alert-group-bonkus-player-reports.error-db-timeout");
    expect(alertGroupKey("KubeJobFailed")).toBe(legacyAlertDedupeKey("KubeJobFailed"));
    expect(alertGroupKey("namey / A")).not.toBe(alertGroupKey("namey / B"));
  });

  it("bounds the service slug at 40 and the alert slug at 45 with a hash suffix, so long names never collide", () => {
    const long = (tail: string) => alertGroupKey(`${"s".repeat(60)} / ${"error-".repeat(12)}${tail}`);
    const a = long("alpha");
    const b = long("beta");
    expect(a).not.toBe(b);
    const [service, alert] = a.slice("alert-group-".length).split(".");
    expect(service).toHaveLength(40);
    expect(service).toMatch(/^s{31}-[0-9a-f]{8}$/);
    expect(alert).toHaveLength(45);
    expect(alert).toMatch(/-[0-9a-f]{8}$/);
    expect(alertGroupKey("x".repeat(40) + " / y")).toBe(`alert-group-${"x".repeat(40)}.y`);
  });
});

describe("isHeldAlertLifecycle", () => {
  it("holds only ideas and backlog", () => {
    expect(isHeldAlertLifecycle("ideas")).toBe(true);
    expect(isHeldAlertLifecycle("backlog")).toBe(true);
    expect(isHeldAlertLifecycle("blocked")).toBe(false);
    expect(isHeldAlertLifecycle("planning")).toBe(false);
  });
});

describe("isAlertInbox", () => {
  const bridge = { label: "grafana-alert-x", title: "Grafana alerts" };
  const plain = { title: "Fix the PVC", filedTitle: null, labels: ["bug"], body: "text" };

  it("is true for an alert label alone", () => {
    expect(isAlertInbox({ ...plain, labels: ["grafana-alert"] })).toBe(true);
  });

  it("is true for a consolidated body alone", () => {
    expect(isAlertInbox({ ...plain, body: "## Currently firing\n\n## Alerts\n" })).toBe(true);
  });

  it("is true for the bridge label plus filed title after a retitle", () => {
    expect(isAlertInbox({ ...plain, labels: ["grafana-alert-x"], filedTitle: "Grafana alerts" }, bridge)).toBe(true);
  });

  it("is false for the bridge label without the filed title, or with no bridge", () => {
    expect(isAlertInbox({ ...plain, labels: ["grafana-alert-x"] }, bridge)).toBe(false);
    expect(isAlertInbox({ ...plain, labels: ["grafana-alert-x"], filedTitle: "Grafana alerts" })).toBe(false);
  });

  it("is false for a plain dedicated issue", () => {
    expect(isAlertInbox(plain, bridge)).toBe(false);
  });
});
