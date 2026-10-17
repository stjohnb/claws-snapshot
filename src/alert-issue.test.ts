import { describe, it, expect } from "vitest";
import {
  ALERT_BRIDGE_FOOTER,
  alertDedupeKey,
  alertSectionNames,
  annotateAlertTriage,
  isAlertBridgeOwned,
  isHeldAlertLifecycle,
  untriagedAlertSections,
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

// Rendered by fleet-infra's grafana-github-alerts and production-infra's
// alert-issue-bridge (`render_body`): identical layouts, each with its footer.
function bridgeBody(footer: string, intro = "Alertmanager alerts for org/repo. One section per alert; this issue closes when every section is resolved."): string {
  return [
    intro,
    "",
    "## Currently firing",
    "",
    "- Workload CI Runner Evicted (warning)",
    "",
    "## Alerts",
    "",
    "### Workload CI Runner Evicted",
    "",
    "| Field | Value |",
    "|---|---|",
    "| Severity | warning |",
    "| Status | firing |",
    "| First occurrence | 2026-10-06T10:00:00Z |",
    "| Last occurrence | 2026-10-15T10:00:00Z |",
    "| Occurrences | 9 |",
    "| Resolved |  |",
    "| Source | https://grafana.example/a |",
    "",
    "<!-- firing-instances: a,b -->",
    "",
    "**Summary:** Runner pod evicted.",
    "",
    "**Description:** ### not a heading — the pod was evicted.",
    "",
    "### Disk Space Low",
    "",
    "| Field | Value |",
    "|---|---|",
    "| Severity | critical |",
    "| Status | resolved |",
    "| First occurrence | 2026-10-07T10:00:00Z |",
    "| Last occurrence | 2026-10-07T10:00:00Z |",
    "| Occurrences | 1 |",
    "| Resolved | 2026-10-07T11:00:00Z |",
    "",
    "<!-- firing-instances:  -->",
    "",
    "**Summary:** Disk low.",
    "",
    "**Description:** Volume full.",
    "",
    footer,
    "",
    "### After the footer",
    "",
    "---",
    "**First seen:** 2026-10-06T10:00:00Z",
    "**Last seen:** 2026-10-15T10:00:00Z",
    "**Occurrences:** 10",
  ].join("\n");
}

const FOOTERS = [
  ["fleet-infra", `*${ALERT_BRIDGE_FOOTER}. Closed when every alert above is resolved; reopened if an alert re-fires within 24 hours.*`],
  ["production-infra", `*${ALERT_BRIDGE_FOOTER}. Closed when every alert above is resolved; reopened if an alert re-fires within 6 hours.*`],
] as const;

describe("alertDedupeKey", () => {
  it.each([
    ["Workload CI Runner Evicted", "alert-workload-ci-runner-evicted"],
    ["  KubePod: CrashLooping (prod)!! ", "alert-kubepod-crashlooping-prod"],
    ["disk_space__low", "alert-disk-space-low"],
    ["!!!", "alert-unknown"],
    ["", "alert-unknown"],
    ["Ünïcode Alert", "alert-n-code-alert"],
  ])("slugs %j to %s", (name, key) => {
    expect(alertDedupeKey(name)).toBe(key);
  });

  it("cuts the slug to 90 characters before stripping a trailing dash", () => {
    expect(alertDedupeKey("a".repeat(120))).toBe(`alert-${"a".repeat(90)}`);
    expect(alertDedupeKey(`${"a".repeat(89)} b`)).toBe(`alert-${"a".repeat(89)}`);
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

describe.each(FOOTERS)("inbox sections with %s's footer", (_bridge, footer) => {
  const body = bridgeBody(footer);

  it("lists the sections between ## Alerts and the footer", () => {
    expect(alertSectionNames(body)).toEqual(["Workload CI Runner Evicted", "Disk Space Low"]);
    expect(untriagedAlertSections(body)).toEqual(["Workload CI Runner Evicted", "Disk Space Low"]);
  });

  it("parses a CRLF body the same way", () => {
    expect(alertSectionNames(body.replace(/\n/g, "\r\n"))).toEqual(["Workload CI Runner Evicted", "Disk Space Low"]);
  });

  it("annotates each section as its table's last row, and the rows mark it triaged", () => {
    const annotated = annotateAlertTriage(body, [
      { alertname: "Workload CI Runner Evicted", verdict: "tracked", issueId: "clw_01TRACKED" },
      { alertname: "Disk Space Low", verdict: "transient", reason: "Self-healed after\nlog rotation | cron." },
      { alertname: "Not a section", verdict: "transient", reason: "ignored" },
    ]);
    expect(annotated).toContain("| Source | https://grafana.example/a |\n| Tracked | #clw_01TRACKED |\n\n<!-- firing-instances: a,b -->");
    expect(annotated).toContain("| Resolved | 2026-10-07T11:00:00Z |\n| Triage | transient — Self-healed after log rotation \\| cron. |\n");
    expect(annotated).not.toContain("Not a section");
    expect(untriagedAlertSections(annotated)).toEqual([]);
    expect(alertSectionNames(annotated)).toEqual(["Workload CI Runner Evicted", "Disk Space Low"]);
  });

  it("replaces an existing verdict row instead of adding a second", () => {
    const once = annotateAlertTriage(body, [{ alertname: "Disk Space Low", verdict: "transient", reason: "flap" }]);
    expect(untriagedAlertSections(once)).toEqual(["Workload CI Runner Evicted"]);
    const twice = annotateAlertTriage(once, [{ alertname: "Disk Space Low", verdict: "tracked", issueId: "clw_01X" }]);
    expect(twice.match(/^\| (?:Triage|Tracked) \|/gm)).toEqual(["| Tracked |"]);
    expect(twice).toContain("| Resolved | 2026-10-07T11:00:00Z |\n| Tracked | #clw_01X |\n");
  });

  it("treats a section whose row was deleted as untriaged again", () => {
    const annotated = annotateAlertTriage(body, [{ alertname: "Disk Space Low", verdict: "transient", reason: "flap" }]);
    expect(untriagedAlertSections(annotated.replace(/^\| Triage \|.*\n/m, ""))).toEqual(["Workload CI Runner Evicted", "Disk Space Low"]);
  });
});

describe("inbox sections without a footer", () => {
  it("is empty for a body with no ## Alerts heading", () => {
    expect(alertSectionNames("### Lonely\n\n| Severity | x |")).toEqual([]);
  });

  it("stops at the next ## heading", () => {
    expect(alertSectionNames("## Alerts\n\n### One\n\n## Other\n\n### Two")).toEqual(["One"]);
  });
});
