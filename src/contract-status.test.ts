import { describe, it, expect, vi } from "vitest";

vi.mock("./db.js", () => ({ saveContractStatus: vi.fn() }));

// contract-drift must load before security-audit (they import each other).
import { CONTRACT_AUDITS } from "./contract-drift.js";
import {
  CONTRACTS,
  SNAPSHOT_LIST_CAP,
  SNAPSHOT_TEXT_CAP,
  buildContractRows,
  buildSnapshot,
  contractRequirementsWaived,
  contractWaivers,
  gapCounts,
  needsAttention,
  optOutFor,
  optOutJobs,
  orderContractRows,
  parseSnapshot,
  type ContractStatusSnapshot,
} from "./contract-status.js";
import { KNOWN_GAPS_DEDUPE_KEY as OBS_KEY, OBSERVABILITY_AUDIT } from "./observability-audit.js";
import { SECURITY_AUDIT } from "./security-audit.js";
import { KNOWN_GAPS_DEDUPE_KEY as SEC_KEY } from "./jobs/security-contract-scanner.js";
import { jobAliases } from "./jobs/scanner-dispatcher.js";

const snap = (over: Partial<ContractStatusSnapshot> = {}): ContractStatusSnapshot => ({
  policy: { status: "complete", path: "docs/x.md", missingRules: [] },
  gaps: [],
  drift: [],
  driftUnavailable: [],
  audit: null,
  ...over,
});

describe("CONTRACTS", () => {
  it("matches the scanners' own constants", () => {
    const obs = CONTRACTS.find((c) => c.contract === "observability")!;
    const sec = CONTRACTS.find((c) => c.contract === "security")!;
    expect(obs.dedupeKey).toBe(OBS_KEY);
    expect(obs.scannerJob).toBe(OBSERVABILITY_AUDIT.scannerJob);
    expect(obs.aliases).toEqual(jobAliases(obs.scannerJob));
    expect(sec.dedupeKey).toBe(SEC_KEY);
    expect(sec.aliases).toEqual(jobAliases(sec.scannerJob));
    expect(sec.scannerJob).toBe(SECURITY_AUDIT.scannerJob);
    for (const spec of CONTRACTS) {
      expect(spec.auditJob !== null).toBe(CONTRACT_AUDITS.some((a) => a.contract === spec.contract && a.scannerJob === spec.scannerJob));
    }
  });
});

describe("buildSnapshot / parseSnapshot", () => {
  it("caps lists and texts and maps gap states", () => {
    const long = "x".repeat(SNAPSHOT_TEXT_CAP + 50);
    const s = buildSnapshot({
      policy: { status: "incomplete", path: "AGENTS.md", missingRules: ["a"] },
      gaps: [{ text: long, state: "unaccepted" as const }, ...Array.from({ length: SNAPSHOT_LIST_CAP + 5 }, () => ({ text: "Accepted: y", state: "accepted" as const }))],
      drift: [{ rule: "r", key: "k", message: "m", file: "f", line: 2 }],
      driftUnavailable: ["r: no clone"],
      audit: null,
    });
    expect(s.gaps).toHaveLength(SNAPSHOT_LIST_CAP);
    expect(s.gaps[0]!.text).toHaveLength(SNAPSHOT_TEXT_CAP);
    expect(s.gaps[0]!.state).toBe("unaccepted");
    expect(s.gaps[1]!.state).toBe("accepted");
    expect(parseSnapshot(JSON.parse(JSON.stringify(s)))).toEqual(s);
  });

  it("round-trips a deferred gap and maps an unknown or missing state to unaccepted", () => {
    const s = buildSnapshot({
      policy: { status: "complete", path: "docs/observability.md", missingRules: [] },
      gaps: [{ text: "Deferred until 2026-12-01: x", state: "deferred" }, { text: "y", state: "accepted" }],
      drift: [],
      driftUnavailable: [],
      audit: null,
    });
    expect(parseSnapshot(JSON.parse(JSON.stringify(s)))).toEqual(s);
    expect(gapCounts(s)).toEqual({ unaccepted: 0, deferred: 1, accepted: 1 });
    const old = parseSnapshot({ policy: { status: "complete" }, gaps: [{ text: "a", state: "accepted" }, { text: "b", state: "snoozed" }] });
    expect(old!.gaps).toEqual([{ text: "a", state: "accepted" }, { text: "b", state: "unaccepted" }]);
    expect(gapCounts(old!)).toEqual({ unaccepted: 1, deferred: 0, accepted: 1 });
  });

  it("rejects a snapshot without a valid policy status", () => {
    expect(parseSnapshot(null)).toBeNull();
    expect(parseSnapshot({ policy: { status: "bogus" } })).toBeNull();
    expect(parseSnapshot({ policy: { status: "missing" } })).toEqual(snap({ policy: { status: "missing", path: null, missingRules: [] } }));
  });
});

describe("optOutFor", () => {
  const names = optOutJobs(CONTRACTS[0]!);

  it("names the disabled job, preferring the repo config", () => {
    expect(optOutFor(names, [], [])).toBeNull();
    expect(optOutFor(names, [], ["logging-conventions-scanner"])).toEqual({ job: "logging-conventions-scanner", source: "repo" });
    expect(optOutFor(names, ["scanner-dispatcher"], [])).toEqual({ job: "scanner-dispatcher", source: "host" });
    expect(optOutFor(names, ["observability-contract-scanner"], ["scanner-dispatcher"])).toEqual({ job: "scanner-dispatcher", source: "repo" });
    expect(optOutFor(names, ["doc-maintainer"], [])).toBeNull();
  });
});

describe("contractRequirementsWaived", () => {
  it("matches requirement keywords per contract", () => {
    expect(contractRequirementsWaived("observability", "Accepted: no metrics endpoint, single process")).toEqual(["Metrics endpoint"]);
    expect(contractRequirementsWaived("observability", "Accepted (waives: nonsense): no metrics endpoint")).toEqual(["Metrics endpoint"]);
    expect(contractRequirementsWaived("security", "Accepted: images are not scanned by trivy")).toEqual(["Image scan gate"]);
    expect(contractRequirementsWaived("security", "Accepted: CSP header missing")).toEqual([]);
    expect(contractRequirementsWaived("unknown", "metrics")).toEqual([]);
  });

  it("ignores gaps that only mention a requirement", () => {
    for (const t of [
      "Accepted: the agent CLIs' trees are resolved by npm, and the image scan gate scans the resolved tree before every push.",
      "Accepted: it is first-party, Renovate is deliberately disabled for the LAN registry images, and the image scan gate scans the store copied from it.",
      "Accepted: the Debian packages come from apt. Pinning Debian package versions breaks builds; the image scan gate checks every build.",
    ]) {
      expect(contractRequirementsWaived("security", t)).toEqual(t.includes("Renovate") ? ["Dependency updates"] : []);
    }
    expect(contractRequirementsWaived("observability", "Accepted: the dashboard shows metrics and the latency budget")).toEqual([]);
  });

  it("honours an explicit waives marker", () => {
    expect(contractRequirementsWaived("observability", "Accepted (waives: metrics-endpoint, Dashboard): batch job")).toEqual(["Metrics endpoint", "Dashboard"]);
  });
});

describe("buildContractRows", () => {
  const rows = buildContractRows({
    repos: ["o/a", "o/b", "o/c"],
    statuses: [
      { contract: "observability", repo: "o/a", scannedAt: "2026-11-09T00:00:00.000Z", snapshot: snap({ gaps: [{ text: "Accepted: no metrics endpoint", state: "accepted" }] }) },
      { contract: "observability", repo: "o/b", scannedAt: "2026-11-09T00:00:00.000Z", snapshot: snap({ gaps: [{ text: "x", state: "unaccepted" }] }) },
      { contract: "observability", repo: "o/c", scannedAt: "2026-11-09T00:00:00.000Z", snapshot: snap({ gaps: [{ text: "Accepted: no metrics endpoint", state: "accepted" }] }) },
      { contract: "observability", repo: "gone/x", scannedAt: "2026-11-09T00:00:00.000Z", snapshot: snap() },
    ],
    auditTimes: [{ contract: "observability", repo: "o/a", auditedAt: "2026-11-08T00:00:00.000Z" }],
    followUps: [{ contract: "observability", repo: "o/b", id: "clw_1", title: "t", stopsAt: "plan review" }],
    exclusions: [
      { repo: "o/c", job: "logging-conventions-scanner", hostDisabled: false, repositoryDisabled: true },
      { repo: "o/a", job: "contract-audit", hostDisabled: true, repositoryDisabled: false },
    ],
  });

  it("gives one row per managed repo and contract, ignoring removed repos", () => {
    expect(rows).toHaveLength(6);
    expect(rows.some((r) => r.repo === "gone/x")).toBe(false);
    const a = rows.find((r) => r.repo === "o/a" && r.contract === "observability")!;
    expect(a).toMatchObject({ auditedAt: "2026-11-08T00:00:00.000Z", auditOff: true, audited: true, optOut: null });
    const sec = rows.find((r) => r.repo === "o/a" && r.contract === "security")!;
    expect(sec).toMatchObject({ snapshot: null, audited: true, auditOff: true, auditedAt: null });
    expect(rows.find((r) => r.repo === "o/b" && r.contract === "observability")!.followUp).toEqual({ id: "clw_1", title: "t", stopsAt: "plan review" });
    expect(rows.find((r) => r.repo === "o/c" && r.contract === "observability")!.optOut).toEqual({ job: "logging-conventions-scanner", source: "repo" });
  });

  it("orders attention first and opted-out last", () => {
    const ordered = orderContractRows(rows).map((r) => `${r.repo}:${r.contract}`);
    expect(ordered[0]).toBe("o/b:observability");
    expect(ordered.at(-1)).toBe("o/c:observability");
  });

  it("does not count a deferred gap as needing attention", () => {
    const base = rows.find((r) => r.repo === "o/a" && r.contract === "observability")!;
    const snapshot = (state: "deferred" | "unaccepted"): ContractStatusSnapshot => ({
      policy: { status: "complete", path: "docs/observability.md", missingRules: [] },
      gaps: [{ text: "x", state }],
      drift: [],
      driftUnavailable: [],
      audit: null,
    });
    expect(needsAttention({ ...base, optOut: null, snapshot: snapshot("deferred") })).toBe(false);
    expect(needsAttention({ ...base, optOut: null, snapshot: snapshot("unaccepted") })).toBe(true);
  });

  it("lists waivers from accepted gaps, skipping opted-out rows", () => {
    expect(contractWaivers(rows)).toEqual([{ contract: "observability", requirement: "Metrics endpoint", repos: ["o/a"] }]);
  });

  it("derives waivers from the explicit marker, not stray keywords", () => {
    const base = rows.find((r) => r.repo === "o/a" && r.contract === "observability")!;
    const row = {
      ...base,
      repo: "o/m",
      snapshot: { ...base.snapshot!, gaps: [{ text: "Accepted (waives: Dashboard): no traces either, see below", state: "accepted" }] },
    } as typeof base;
    const w = contractWaivers([row]);
    expect(w).toEqual([{ contract: "observability", requirement: "Dashboard", repos: ["o/m"] }]);
  });
});
