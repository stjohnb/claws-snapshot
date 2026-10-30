import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../config.js", () => ({
  LABELS: { blocked: "Blocked" },
  prUrl: (fullName: string, prNumber: number) => `https://git.example.com/${fullName}/pulls/${prNumber}`,
}));
vi.mock("../log.js", () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn() }));
const mockTracking = vi.hoisted(() => ({ upsertAlertIssue: vi.fn(), closeAlertIssueIfResolved: vi.fn() }));
vi.mock("../occurrence-tracking.js", () => mockTracking);

import {
  STALL_ALERT_TITLE, STALL_THRESHOLD_MS, clearAutoBumpStallState, reconcileStallAlert, recordSweep, type StallEvaluation,
} from "./auto-bump-stall.js";
import * as log from "../log.js";

const REPO = "St-John-Software/production-infra";
const T0 = Date.parse("2026-10-29T12:04:00Z");
const MIN = 60_000;

const gateBlocked = (number: number, autoBumpReason: "non-bump-files" | "not-image-pin-only" = "non-bump-files"): StallEvaluation => ({
  number,
  title: `Bump bonkus #${number}`,
  refusal: { merged: false, code: "auto-bump-gate", message: "held", autoBumpReason },
});
const merged = (number: number): StallEvaluation => ({ number, title: `Bump bonkus #${number}`, refusal: null });

/** One sweep at `at`: record the evaluated PRs (open = evaluated plus `alsoOpen`), then reconcile. */
async function sweep(at: number, evaluated: StallEvaluation[], alsoOpen: number[] = []): Promise<void> {
  recordSweep(REPO, evaluated, [...evaluated.map((e) => e.number), ...alsoOpen], at);
  await reconcileStallAlert(REPO, at);
}

describe("stalled auto-bump alert", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearAutoBumpStallState();
    mockTracking.upsertAlertIssue.mockResolvedValue("created");
    mockTracking.closeAlertIssueIfResolved.mockResolvedValue(null);
  });

  it("raises no alert while a PR is held for less than the threshold", async () => {
    await sweep(T0, [gateBlocked(464)]);
    await sweep(T0 + STALL_THRESHOLD_MS - MIN, [gateBlocked(464)]);

    expect(mockTracking.upsertAlertIssue).not.toHaveBeenCalled();
    expect(mockTracking.closeAlertIssueIfResolved).not.toHaveBeenCalled();
  });

  it("upserts one Blocked alert naming the repo, PR and reason once past the threshold", async () => {
    await sweep(T0, [gateBlocked(464)]);
    await sweep(T0 + STALL_THRESHOLD_MS, [gateBlocked(464)]);

    expect(mockTracking.upsertAlertIssue).toHaveBeenCalledTimes(1);
    const opts = mockTracking.upsertAlertIssue.mock.calls[0][0];
    expect(opts).toMatchObject({ repo: REPO, title: STALL_ALERT_TITLE, labels: ["Blocked"], blockedReason: expect.stringContaining("merge gate") });
    expect(opts.body).toContain(REPO);
    expect(opts.body).toContain(`https://git.example.com/${REPO}/pulls/464`);
    expect(opts.body).toContain("touches files beyond YAML image pins");
    expect(opts.body).toContain(new Date(T0).toISOString());
    expect(log.info).toHaveBeenCalledWith(expect.any(String), "auto_bump_stall", { repo: REPO, heldCount: 1, overThreshold: 1 });
  });

  it("files one alert listing every held PR, with the same title and body on the next sweep", async () => {
    await sweep(T0, [gateBlocked(466, "not-image-pin-only"), gateBlocked(464)]);
    await sweep(T0 + STALL_THRESHOLD_MS, [gateBlocked(466, "not-image-pin-only"), gateBlocked(464)]);
    await sweep(T0 + STALL_THRESHOLD_MS + 3 * MIN, [gateBlocked(466, "not-image-pin-only"), gateBlocked(464)]);

    expect(mockTracking.upsertAlertIssue).toHaveBeenCalledTimes(2);
    const [first, second] = mockTracking.upsertAlertIssue.mock.calls.map((c) => c[0]);
    expect(second.title).toBe(first.title);
    expect(second.body).toBe(first.body);
    expect(first.body.indexOf("/pulls/464")).toBeLessThan(first.body.indexOf("/pulls/466"));
    expect(first.body).toContain("not an image-pin-only bump");
    // The over-threshold set did not change on the third sweep: one log line, not two.
    expect(vi.mocked(log.info).mock.calls.filter((c) => c[1] === "auto_bump_stall")).toHaveLength(1);
  });

  it("keeps a newer bump's clock running and closes the alert only once none is held", async () => {
    await sweep(T0, [gateBlocked(464)]);
    await sweep(T0 + STALL_THRESHOLD_MS, [gateBlocked(464)]);
    // #464 is closed as superseded; #466 is newly held, so the alert stays open.
    await sweep(T0 + STALL_THRESHOLD_MS + 3 * MIN, [gateBlocked(466)]);
    expect(mockTracking.closeAlertIssueIfResolved).not.toHaveBeenCalled();
    // An approved merge takes #466 off the gate path.
    await sweep(T0 + STALL_THRESHOLD_MS + 6 * MIN, [merged(466)]);

    expect(mockTracking.closeAlertIssueIfResolved).toHaveBeenCalledTimes(1);
    expect(mockTracking.closeAlertIssueIfResolved).toHaveBeenCalledWith(expect.objectContaining({ repo: REPO, title: STALL_ALERT_TITLE }));
    // An idle repo is not re-checked every sweep.
    await sweep(T0 + STALL_THRESHOLD_MS + 9 * MIN, []);
    expect(mockTracking.closeAlertIssueIfResolved).toHaveBeenCalledTimes(1);
  });

  it("drops a PR that is no longer open", async () => {
    await sweep(T0, [gateBlocked(464)]);
    await sweep(T0 + STALL_THRESHOLD_MS, []);

    expect(mockTracking.upsertAlertIssue).not.toHaveBeenCalled();
    expect(mockTracking.closeAlertIssueIfResolved).toHaveBeenCalledTimes(1);
  });

  it("keeps the entry of a PR the sweep skipped for other work", async () => {
    await sweep(T0, [gateBlocked(464)]);
    // Still open but not judged (dispatch guard / other work running).
    await sweep(T0 + STALL_THRESHOLD_MS, [], [464]);

    expect(mockTracking.upsertAlertIssue).toHaveBeenCalledTimes(1);
    expect(mockTracking.upsertAlertIssue.mock.calls[0][0].body).toContain(new Date(T0).toISOString());
  });

  it("does not count transient gate failures or other refusals as held", async () => {
    const transient: StallEvaluation = { number: 464, title: "t", refusal: { merged: false, code: "auto-bump-gate", message: "m", autoBumpReason: "pin-scan-failed" } };
    const checks: StallEvaluation = { number: 466, title: "t", refusal: { merged: false, code: "checks-pending", message: "m" } };
    await sweep(T0, [transient, checks]);
    await sweep(T0 + STALL_THRESHOLD_MS, [transient, checks]);

    expect(mockTracking.upsertAlertIssue).not.toHaveBeenCalled();
  });

  it("logs and swallows an alert failure", async () => {
    mockTracking.upsertAlertIssue.mockRejectedValue(new Error("forge down"));
    await sweep(T0, [gateBlocked(464)]);
    await expect(sweep(T0 + STALL_THRESHOLD_MS, [gateBlocked(464)])).resolves.toBeUndefined();

    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("forge down"));
  });
});
