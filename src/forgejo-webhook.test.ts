import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import crypto from "node:crypto";

vi.mock("./log.js", () => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

import type { SqlDriver } from "./db-driver.js";
import { CLAWS_EVENTS_DDL, getEventsSince, setGitHubEventsDriver } from "./github-events.js";
import { CLAWS_GATE_STATE_DDL, setGateEventsDriver } from "./gate-events.js";
import type { CheckStatus } from "./github.js";
import {
  handleForgejoDelivery,
  mapForgejoDelivery,
  verifyForgejoSignature,
  type ForgejoDeliveryContext,
  type HeadPr,
} from "./forgejo-webhook.js";

/** PGlite on the Postgres lane, else in-memory SQLite. */
async function openDriver(): Promise<SqlDriver> {
  if (process.env["CLAWS_TEST_PGLITE"] === "1") {
    const { createPgLiteDriver } = await import("./db-driver-pg.js");
    return await createPgLiteDriver();
  }
  const { createSqliteDriver } = await import("./db-driver.js");
  return createSqliteDriver(":memory:");
}

const REPO = "St-John-Software/claws";
const ISSUE = "clw_01JBQ7X4M2K8NV3TYRW9GZ5PDC";
const SHA = "0123456789abcdef0123456789abcdef01234567";
const SHA2 = "fedcba9876543210fedcba9876543210fedcba98";

function ctx(overrides: Partial<ForgejoDeliveryContext> = {}): ForgejoDeliveryContext {
  return {
    selfLogins: new Set(["claws-bot", "claws-reader"]),
    isManagedRepo: (name) => name === REPO,
    findPrForHead: async (_repo, sha): Promise<HeadPr | null> =>
      sha === SHA || sha === SHA2 ? { number: 42, issueId: ISSUE, title: "Fix it", body: "Closes #7" } : null,
    readCombinedStatus: async (): Promise<CheckStatus> => "passing",
    ...overrides,
  };
}

const repository = { full_name: REPO };
const human = { login: "alice" };

describe("verifyForgejoSignature", () => {
  const body = '{"action":"created"}';
  const sign = (secret: string) => crypto.createHmac("sha256", secret).update(body).digest("hex");

  it("accepts the HMAC-SHA256 of the raw body under the secret", () => {
    expect(verifyForgejoSignature(body, sign("s3cret"), "s3cret")).toBe(true);
  });

  it("rejects a signature made with another secret", () => {
    expect(verifyForgejoSignature(body, sign("other"), "s3cret")).toBe(false);
  });

  it("rejects a missing header or an empty secret", () => {
    expect(verifyForgejoSignature(body, undefined, "s3cret")).toBe(false);
    expect(verifyForgejoSignature(body, "", "s3cret")).toBe(false);
    expect(verifyForgejoSignature(body, sign(""), "")).toBe(false);
  });
});

describe("mapForgejoDelivery", () => {
  const map = async (event: string, payload: unknown, c = ctx()) =>
    (await mapForgejoDelivery(event, payload, c)).events.map((e) => e.event);

  it("maps a created comment to forge-comment with the comment's refs in related", async () => {
    const events = await map("issue_comment", {
      action: "created", issue: { number: 7 }, comment: { body: `see #${ISSUE} and #7` }, repository, sender: human,
    });
    expect(events).toEqual([{ kind: "forge-comment", repo: REPO, number: 7, related: [ISSUE], detail: "alice" }]);
  });

  it("ignores an edited or deleted comment", async () => {
    expect(await map("issue_comment", { action: "edited", issue: { number: 7 }, comment: { body: "" }, repository, sender: human })).toEqual([]);
  });

  it.each([
    ["label_updated", "forge-label-changed", "Ready,Refined"],
    ["label_cleared", "forge-label-changed", "Ready,Refined"],
    ["closed", "forge-issue-closed", "alice"],
    ["reopened", "forge-issue-reopened", "alice"],
  ])("maps issues %s to %s", async (action, kind, detail) => {
    const events = await map("issues", {
      action, number: 7, issue: { number: 7, title: "t", body: `For #${ISSUE}`, labels: [{ name: "Refined" }, { name: "Ready" }] }, repository, sender: human,
    });
    expect(events).toEqual([{ kind, repo: REPO, number: 7, related: [ISSUE], detail }]);
  });

  it("omits the label detail when the item has no labels", async () => {
    const events = await map("issues", { action: "label_updated", number: 7, issue: { number: 7 }, repository, sender: human });
    expect(events).toEqual([{ kind: "forge-label-changed", repo: REPO, number: 7, related: [] }]);
  });

  const pr = (extra: Record<string, unknown> = {}) => ({
    number: 42, title: "Fix it", body: `Closes #${ISSUE}`, head: { sha: SHA }, merged: false, ...extra,
  });

  it.each([
    ["label_updated"],
    ["label_cleared"],
  ])("maps pull_request %s to forge-label-changed", async (action) => {
    const events = await map("pull_request", { action, number: 42, pull_request: pr({ labels: [{ name: "Automerge" }] }), repository, sender: human });
    expect(events).toEqual([{ kind: "forge-label-changed", repo: REPO, number: 42, related: [ISSUE], detail: "Automerge" }]);
  });

  it("maps a PR branch push to forge-push with the head sha12", async () => {
    const events = await map("pull_request", { action: "synchronized", number: 42, pull_request: pr(), repository, sender: human });
    expect(events).toEqual([{ kind: "forge-push", repo: REPO, number: 42, related: [ISSUE], detail: SHA.slice(0, 12) }]);
  });

  it("splits a closed PR into forge-pr-merged and forge-pr-closed", async () => {
    const merged = await map("pull_request", { action: "closed", number: 42, pull_request: pr({ merged: true }), repository, sender: human });
    const closed = await map("pull_request", { action: "closed", number: 42, pull_request: pr(), repository, sender: human });
    expect(merged.map((e) => [e.kind, e.detail])).toEqual([["forge-pr-merged", "alice"]]);
    expect(closed.map((e) => [e.kind, e.detail])).toEqual([["forge-pr-closed", "alice"]]);
  });

  it.each([
    ["pull_request_approved", "approved"],
    ["pull_request_rejected", "rejected"],
    ["pull_request_comment", "comment"],
  ])("maps %s to forge-review:%s", async (event, detail) => {
    const events = await map(event, { action: "reviewed", number: 42, pull_request: pr(), repository, sender: human });
    expect(events).toEqual([{ kind: "forge-review", repo: REPO, number: 42, related: [ISSUE], detail }]);
  });

  it("drops a human-kind event sent by one of Claws' own logins, case-insensitively", async () => {
    for (const login of ["claws-bot", "Claws-Reader"]) {
      const events = await map("issue_comment", {
        action: "created", issue: { number: 7 }, comment: { body: "" }, repository, sender: { login },
      });
      expect(events).toEqual([]);
    }
  });

  it("drops a delivery for a repo that is not a managed Forgejo repo", async () => {
    const mapped = await mapForgejoDelivery("issue_comment", {
      action: "created", issue: { number: 7 }, comment: { body: "" }, repository: { full_name: "someone/else" }, sender: human,
    }, ctx());
    expect(mapped).toEqual({ managed: false, events: [] });
  });

  it("maps an unknown event to nothing", async () => {
    expect(await map("push", { repository, sender: human })).toEqual([]);
  });

  it.each(["action_run_success", "action_run_failure", "action_run_recover"])("maps %s to a ci-status gate event on the head's PR", async (event) => {
    const mapped = await mapForgejoDelivery(event, {
      action: "success", run: { commit_sha: SHA, repository }, prior_status: "running",
    }, ctx({ readCombinedStatus: async () => "failing" }));
    expect(mapped.events).toEqual([{
      event: { kind: "ci-status", repo: REPO, number: 42, related: [ISSUE, 7], detail: `failing:${SHA.slice(0, 12)}` },
      gate: { item: 42, name: "ci-status" },
    }]);
  });

  it("keeps a ci-status from a Claws-triggered run", async () => {
    const events = await map("action_run_success", { run: { commit_sha: SHA, repository }, sender: { login: "claws-bot" } });
    expect(events.map((e) => e.kind)).toEqual(["ci-status"]);
  });

  it("drops a run whose head is no open PR's", async () => {
    const readCombinedStatus = vi.fn(async (): Promise<CheckStatus> => "passing");
    const events = await map("action_run_success", { run: { commit_sha: "beef", repository } }, ctx({ readCombinedStatus }));
    expect(events).toEqual([]);
    expect(readCombinedStatus).not.toHaveBeenCalled();
  });
});

describe("handleForgejoDelivery", () => {
  let driver: SqlDriver;

  beforeEach(async () => {
    driver = await openDriver();
    await driver.exec(CLAWS_EVENTS_DDL);
    await driver.exec(CLAWS_GATE_STATE_DDL);
    setGitHubEventsDriver(driver);
    setGateEventsDriver(driver);
  });

  afterEach(async () => {
    setGateEventsDriver(null);
    setGitHubEventsDriver(null);
    await driver.close();
  });

  const run = (sha: string) => ({ action: "success", run: { commit_sha: sha, repository } });

  it("emits ci-status once per aggregate transition and again on a new head", async () => {
    let status: CheckStatus = "passing";
    const c = ctx({ readCombinedStatus: async () => status });

    expect(await handleForgejoDelivery("action_run_success", run(SHA), c)).toEqual({ managed: true, recorded: 1 });
    expect(await handleForgejoDelivery("action_run_success", run(SHA), c)).toEqual({ managed: true, recorded: 0 });
    status = "failing";
    expect((await handleForgejoDelivery("action_run_failure", run(SHA), c)).recorded).toBe(1);
    expect((await handleForgejoDelivery("action_run_success", run(SHA2), c)).recorded).toBe(1);

    const events = await getEventsSince(0, { kinds: ["ci-status"] });
    expect(events.map((e) => e.detail)).toEqual([
      `passing:${SHA.slice(0, 12)}`,
      `failing:${SHA.slice(0, 12)}`,
      `failing:${SHA2.slice(0, 12)}`,
    ]);
  });

  it("is matched by a ci-status:<status> filter and by an item filter on the tracker issue", async () => {
    await handleForgejoDelivery("action_run_failure", run(SHA), ctx({ readCombinedStatus: async () => "failing" }));
    expect(await getEventsSince(0, { kinds: [{ kind: "ci-status", detail: "failing" }], items: [ISSUE] })).toHaveLength(1);
    expect(await getEventsSince(0, { kinds: [{ kind: "ci-status", detail: "passing" }] })).toHaveLength(0);
  });

  it("records a human comment and nothing for Claws' own", async () => {
    const payload = (login: string) => ({ action: "created", issue: { number: 7 }, comment: { body: "" }, repository, sender: { login } });
    expect((await handleForgejoDelivery("issue_comment", payload("claws-bot"), ctx())).recorded).toBe(0);
    expect((await handleForgejoDelivery("issue_comment", payload("alice"), ctx())).recorded).toBe(1);
    expect((await getEventsSince(0, {})).map((e) => [e.kind, e.detail])).toEqual([["forge-comment", "alice"]]);
  });
});
