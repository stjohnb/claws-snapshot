import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const autoPromotePolicy = vi.hoisted(() => ({ current: {} as { attended?: boolean; unattended?: boolean } }));

vi.mock("./config.js", async () => ({
  WORK_DIR: (await import("node:path")).join((await import("node:os")).tmpdir(), "claws-issues-attachments-test"),
  DB_PATH: ":memory:",
  DATABASE_URL: "",
  DATABASE_PASSWORD: "",
  DASHBOARD_URL: "https://claws.example.invalid",
  LABELS: { duplicate: "Duplicate" },
  getAutoPromotePolicy: () => autoPromotePolicy.current,
}));

vi.mock("./log.js", () => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

import { initDb, closeDb, getIssueModelPlanRows, listExplicitIssueModelPlanRows, upsertIssueModelPlanCell, addClawsIssueRequirementsVersion, setRequirementsVersionListener, enqueueWork, getWorkRow, createShadowIssue, setClawsIssueLifecycle } from "./db.js";
import type { RequirementsRecord } from "./requirements-record.js";
import { getEventsSince, resetGitHubEventsForTest } from "./github-events.js";
import * as claws from "./claws-issues.js";
import { storeIssueAttachment } from "./issue-attachments.js";
import { getClawsIssueAttachment } from "./db.js";

beforeEach(async () => {
  await initDb();
  resetGitHubEventsForTest();
});

afterEach(async () => {
  await closeDb();
});

describe("claws-issues mapping", () => {
  it("maps a stored issue onto the façade's Issue shape with an ISO updatedAt", async () => {
    const id = await claws.createIssue({
      title: "Native",
      body: "Body",
      authorLogin: "stjohnb",
      repos: ["org/a"],
      labels: ["Ready"],
    });

    const [issue] = await claws.listOpenIssues("org/a");
    expect(issue).toMatchObject({
      number: id,
      title: "Native",
      body: "Body",
      labels: [{ name: "Ready" }],
      author: { login: "stjohnb" },
    });
    expect(issue!.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it("reports when the issue entered its column, falling back to updated_at for an older row", async () => {
    const id = await claws.createIssue({ title: "T", authorLogin: "stjohnb", repos: ["org/a"] });
    const { _rawDb } = await import("./db.js");
    await _rawDb().run(`UPDATE claws_issues SET stage_changed_at = ?, updated_at = ? WHERE id = ?`, ["2026-01-02 03:04:05", "2026-02-03 04:05:06", id]);
    expect((await claws.listOpenIssues("org/a"))[0]!.stageSince).toBe("2026-01-02T03:04:05.000Z");

    await _rawDb().run(`UPDATE claws_issues SET stage_changed_at = NULL WHERE id = ?`, [id]);
    expect((await claws.listOpenIssues("org/a"))[0]!.stageSince).toBe("2026-02-03T04:05:06.000Z");
  });

  it("mints a prefixed ULID id", async () => {
    const id = await claws.createIssue({ title: "T", authorLogin: "stjohnb" });
    expect(id).toMatch(/^clw_[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it("renders comment bodies to body_html", async () => {
    const id = await claws.createIssue({ title: "T", authorLogin: "stjohnb", repos: ["org/a"] });
    await claws.commentOnIssue("org/a", id, "some **bold** feedback", "stjohnb");

    const [comment] = await claws.getIssueComments(id);
    expect(comment).toMatchObject({ login: "stjohnb", body: "some **bold** feedback" });
    expect(comment!.body_html).toContain("<strong>bold</strong>");
  });

  it("drops a blank comment without inserting it or emitting an event", async () => {
    const id = await claws.createIssue({ title: "T", authorLogin: "stjohnb", repos: ["org/a"] });

    expect(await claws.commentOnIssue("org/a", id, "   ", "stjohnb")).toBeNull();
    expect(await claws.getIssueComments(id)).toEqual([]);
    expect(await claws.listCommentDetails(id)).toEqual([]);
    expect(getEventsSince(0, { kinds: ["issue-comment"] })).toEqual([]);
  });

  it("renders the body to HTML so the images pipeline still finds <img>", async () => {
    const id = await claws.createIssue({
      title: "T",
      authorLogin: "stjohnb",
      body: "![shot](https://example.invalid/a.png)",
    });

    expect(await claws.getIssueBodyHtml(id)).toContain('<img src="https://example.invalid/a.png"');
  });

  it("reports state in the façade's upper-case form with its reason", async () => {
    const id = await claws.createIssue({ title: "T", authorLogin: "stjohnb", repos: ["org/a"] });
    expect(await claws.getIssueState(id)).toEqual({ state: "OPEN", stateReason: null, labels: [] });

    await claws.closeIssue("org/a", id, "not_planned");
    expect(await claws.getIssueState(id)).toEqual({ state: "CLOSED", stateReason: "not_planned", labels: [] });
  });

  // The labels come off the record this already reads, and the board's
  // `POST /board/move` needs them with the state to decide the column a move
  // lands in — so they are part of the same answer rather than a second read.
  it("carries the issue's labels alongside its state", async () => {
    const id = await claws.createIssue({ title: "T", authorLogin: "stjohnb", repos: ["org/a"] });
    await claws.addLabel("org/a", id, "In Review");

    expect(await claws.getIssueState(id)).toEqual({ state: "OPEN", stateReason: null, labels: ["In Review"] });
  });

  it("accepts a lower-cased id at every entry point", async () => {
    const id = await claws.createIssue({ title: "T", authorLogin: "stjohnb", repos: ["org/a"] });
    const lower = id.toLowerCase();

    await claws.editIssueTitle(lower, "Renamed");
    await claws.addLabel("org/a", lower, "Ready");

    expect(await claws.getIssueTitleBody(lower)).toMatchObject({ title: "Renamed" });
    expect((await claws.getIssue(lower))!.labels).toEqual(["Ready"]);
  });

  it("throws for an unknown or non-native reference", async () => {
    await expect(claws.getIssueBody("clw_01JBQ7X4M2K8NV3TYRW9GZ5PDC")).rejects.toThrow(/no native issue/);
    await expect(claws.getIssueBody(123)).rejects.toThrow(/no native issue 123/);
    await expect(claws.getIssueComments(123)).rejects.toThrow(/not a native issue id/);
  });

  it("returns issues whose primary repo is the requested one", async () => {
    const single = await claws.createIssue({ title: "Single", authorLogin: "stjohnb", repos: ["org/a"] });
    const multi = await claws.createIssue({ title: "Multi", authorLogin: "stjohnb", repos: ["org/b", "org/a"] });
    await claws.createIssue({ title: "None", authorLogin: "stjohnb" });

    expect((await claws.listOpenIssues("org/a")).map((i) => i.number).sort()).toEqual([single, multi].sort());
    expect(await claws.listOpenIssues("org/b")).toEqual([]);
    expect((await claws.listUnassignedOpenIssues()).map((i) => i.title)).toEqual(["None"]);
  });

  it("primaryRepo is the alphabetically first repo, or empty with none", () => {
    expect(claws.primaryRepo(["org/b", "org/a"])).toBe("org/a");
    expect(claws.primaryRepo(["org/a"])).toBe("org/a");
    expect(claws.primaryRepo([])).toBe("");
  });
});

describe("claws-issues events", () => {
  it("emits label events once per associated repo and never with a blank repo", async () => {
    const both = await claws.createIssue({ title: "Both", authorLogin: "stjohnb", repos: ["org/a", "org/b"] });
    const none = await claws.createIssue({ title: "None", authorLogin: "stjohnb" });

    await claws.addLabel("", both, "Ready");
    await claws.addLabel("", none, "Ready");

    const events = getEventsSince(0, { kinds: ["label-added"] });
    expect(events.map((e) => e.repo).sort()).toEqual(["org/a", "org/b"]);
    expect(events.every((e) => e.repo !== "")).toBe(true);
  });

  it("does not emit a label event when the label was already present", async () => {
    const id = await claws.createIssue({ title: "T", authorLogin: "stjohnb", repos: ["org/a"], labels: ["Ready"] });

    await claws.addLabel("org/a", id, "Ready");

    expect(getEventsSince(0, { kinds: ["label-added"] })).toEqual([]);
  });

  it("emits the state label's event on a lifecycle change, and nothing on a repeat", async () => {
    const id = await claws.createIssue({ title: "T", authorLogin: "stjohnb", repos: ["org/a"], labels: ["Ready"] });

    await claws.setLifecycle("org/a", id, "approved");
    await claws.setLifecycle("org/a", id, "approved");
    await claws.setLifecycle("org/a", id, "ideas");

    expect(getEventsSince(0, { kinds: ["label-added"] }).map((e) => e.detail)).toEqual(["Refined"]);
    expect(getEventsSince(0, { kinds: ["label-removed"] }).map((e) => e.detail)).toEqual(["Refined"]);
    expect((await claws.getIssue(id))!.labels).toEqual([]);
  });

  it("emits issue-closed exactly once even when two jobs close the same issue", async () => {
    const id = await claws.createIssue({ title: "T", authorLogin: "stjohnb", repos: ["org/a"] });

    await claws.closeIssue("org/a", id, "completed");
    await claws.closeIssue("org/a", id, "completed");

    expect(getEventsSince(0, { kinds: ["issue-closed"] })).toHaveLength(1);
  });

  it("emits issue-reopened on a reopen, and nothing on a repeat", async () => {
    const id = await claws.createIssue({ title: "T", authorLogin: "stjohnb", repos: ["org/a"] });
    await claws.closeIssue("org/a", id, "completed");

    await claws.reopenIssue(id);
    await claws.reopenIssue(id);

    expect(getEventsSince(0, { kinds: ["issue-reopened"] })).toHaveLength(1);
    expect(await claws.getIssueState(id)).toEqual({ state: "OPEN", stateReason: null, labels: [] });
  });

  it("tags a plan comment so claws_wait_for_change can filter on it", async () => {
    const id = await claws.createIssue({ title: "T", authorLogin: "stjohnb", repos: ["org/a"] });

    await claws.commentOnIssue("org/a", id, "*— Automated by Claws —*\n\n## Implementation Plan\n\nDo it.", "claws");

    expect(getEventsSince(0, { kinds: ["issue-comment"] })[0]).toMatchObject({ repo: "org/a", detail: "plan" });
  });
});

describe("claws-issues duplicates", () => {
  it("matches the structured marker case-insensitively and not a bare mention", async () => {
    const canonical = await claws.createIssue({ title: "Canonical", authorLogin: "stjohnb", repos: ["org/a"] });
    const dup = await claws.createIssue({
      title: "Dup",
      authorLogin: "stjohnb",
      repos: ["org/a"],
      labels: ["Duplicate"],
      body: `claws-duplicate-of:${canonical.toLowerCase()}`,
    });
    await claws.createIssue({
      title: "Mentions only",
      authorLogin: "stjohnb",
      repos: ["org/a"],
      labels: ["Duplicate"],
      body: `Related to #${canonical}, but not a duplicate.`,
    });

    expect((await claws.listDuplicateIssuesOf("org/a", canonical)).map((i) => i.number)).toEqual([dup]);
  });

  it("finds the marker in a comment too", async () => {
    const canonical = await claws.createIssue({ title: "Canonical", authorLogin: "stjohnb", repos: ["org/a"] });
    const dup = await claws.createIssue({ title: "Dup", authorLogin: "stjohnb", repos: ["org/a"], labels: ["Duplicate"] });
    await claws.commentOnIssue("org/a", dup, `claws-duplicate-of:${canonical}`, "claws");

    expect((await claws.listDuplicateIssuesOf("org/a", canonical)).map((i) => i.number)).toEqual([dup]);
  });

  it("does not match an id that merely starts with the canonical one", async () => {
    const canonical = await claws.createIssue({ title: "Canonical", authorLogin: "stjohnb", repos: ["org/a"] });
    await claws.createIssue({
      title: "Dup",
      authorLogin: "stjohnb",
      repos: ["org/a"],
      labels: ["Duplicate"],
      body: `claws-duplicate-of:${canonical}X`,
    });

    expect(await claws.listDuplicateIssuesOf("org/a", canonical)).toEqual([]);
  });
});

describe("claws-issues writes", () => {
  it("transfers by replacing the repo association and returns the dashboard URL", async () => {
    const id = await claws.createIssue({ title: "T", authorLogin: "stjohnb", repos: ["org/a"] });

    const url = await claws.transferIssue(id, "org/b");

    expect(url).toBe(`https://claws.example.invalid/issues/${id}`);
    expect((await claws.getIssue(id))!.repos).toEqual(["org/b"]);
  });

  it("clears the model plan keyed to the old repo on transfer", async () => {
    const id = await claws.createIssue({ title: "T", authorLogin: "stjohnb", repos: ["org/a"] });
    await upsertIssueModelPlanCell("org/a", id, "implement", { provider: "codex", tier: "haiku", source: "explicit" });

    await claws.transferIssue(id, "org/b");

    expect(await getIssueModelPlanRows("org/a", id)).toEqual([]);
  });

  it("keeps the model plan while setRepos leaves the same single repo", async () => {
    const id = await claws.createIssue({ title: "T", authorLogin: "stjohnb", repos: ["org/a"] });
    await upsertIssueModelPlanCell("org/a", id, "implement", { provider: "codex", tier: "haiku", source: "explicit" });

    await claws.setRepos(id, ["org/a"]);

    expect((await getIssueModelPlanRows("org/a", id)).map((r) => r.phase)).toEqual(["implement"]);
  });

  it("keeps the model plan while setRepos adds a repo that sorts after the primary", async () => {
    const id = await claws.createIssue({ title: "T", authorLogin: "stjohnb", repos: ["org/a"] });
    await upsertIssueModelPlanCell("org/a", id, "implement", { provider: "codex", tier: "haiku", source: "explicit" });

    await claws.setRepos(id, ["org/b", "org/a"]);

    expect((await getIssueModelPlanRows("org/a", id)).map((r) => r.phase)).toEqual(["implement"]);
  });

  it.each([[["org/0", "org/a"]], [["org/b"]], [[]]])("clears the model plan when setRepos leaves %j", async (repos) => {
    const id = await claws.createIssue({ title: "T", authorLogin: "stjohnb", repos: ["org/a"] });
    await upsertIssueModelPlanCell("org/a", id, "implement", { provider: "codex", tier: "haiku", source: "explicit" });
    await upsertIssueModelPlanCell("org/a", id, "review", { provider: null, tier: "opus", source: "suggested" });

    await claws.setRepos(id, repos);

    expect(await getIssueModelPlanRows("org/a", id)).toEqual([]);
    expect(await listExplicitIssueModelPlanRows()).toEqual([]);
  });

  it("stores reactions per (comment, login, content)", async () => {
    const id = await claws.createIssue({ title: "T", authorLogin: "stjohnb", repos: ["org/a"] });
    const commentId = (await claws.commentOnIssue("org/a", id, "please fix", "stjohnb"))!;

    await claws.addReaction(commentId, claws.CLAWS_NATIVE_LOGIN, "+1");
    await claws.addReaction(commentId, claws.CLAWS_NATIVE_LOGIN, "+1");

    expect(await claws.getCommentReactions(commentId)).toEqual([
      { id: 0, user: { login: "claws" }, content: "+1" },
    ]);
  });

  it("removeLabel reports the label absent afterwards either way", async () => {
    const id = await claws.createIssue({ title: "T", authorLogin: "stjohnb", repos: ["org/a"] });
    expect(await claws.removeLabel("org/a", id, "Ready")).toBe(true);
  });

  it("dashboardIssueUrl canonicalises the id it is handed", async () => {
    expect(claws.dashboardIssueUrl("clw_01jbq7x4m2k8nv3tyrw9gz5pdc"))
      .toBe("https://claws.example.invalid/issues/clw_01JBQ7X4M2K8NV3TYRW9GZ5PDC");
  });
});

describe("claws-issues promotion", () => {
  const record = (title: string): RequirementsRecord => ({
    title, kind: "feature", context: "Why.", requirement: "What.", acceptanceCriteria: ["It works"], outOfScope: [],
  });

  beforeEach(() => {
    autoPromotePolicy.current = {};
    setRequirementsVersionListener(claws.autoPromoteOnFirstVersion);
  });

  afterEach(() => {
    setRequirementsVersionListener(undefined);
  });

  it("waits for a human on an attended source, and promotes an unattended one as claws", async () => {
    const attended = await claws.createIssue({ title: "Mine", authorLogin: "stjohnb", repos: ["org/a"], source: "dashboard" });
    await addClawsIssueRequirementsVersion(attended, record("Mine"), null);
    expect((await claws.getIssue(attended))!).toMatchObject({ lifecycle: "ideas", requirements_approved_by: null });

    for (const source of ["automation", "forge", "agent"] as const) {
      const id = await claws.createIssue({ title: `From ${source}`, authorLogin: "claws", repos: ["org/a"], source });
      await addClawsIssueRequirementsVersion(id, record(`From ${source}`), null);
      expect((await claws.getIssue(id))!, source).toMatchObject({
        lifecycle: "planning", approved_requirements_version: 1, requirements_approved_by: "claws",
      });
    }
  });

  it("follows the repo's claws.json policy, and a per-issue choice over it", async () => {
    autoPromotePolicy.current = { attended: true };
    const dashboard = await claws.createIssue({ title: "T", authorLogin: "stjohnb", repos: ["org/a"], source: "dashboard" });
    await addClawsIssueRequirementsVersion(dashboard, record("T"), null);
    expect((await claws.getIssue(dashboard))!.lifecycle).toBe("planning");

    autoPromotePolicy.current = {};
    const held = await claws.createIssue({ title: "T", authorLogin: "claws", repos: ["org/a"], source: "agent", autoPromote: false });
    await addClawsIssueRequirementsVersion(held, record("T"), null);
    expect((await claws.getIssue(held))!.lifecycle).toBe("ideas");

    const forced = await claws.createIssue({ title: "T", authorLogin: "stjohnb", repos: ["org/a"], source: "session", autoPromote: true });
    await addClawsIssueRequirementsVersion(forced, record("T"), null);
    expect((await claws.getIssue(forced))!.lifecycle).toBe("planning");
  });

  it("auto-promotes only on the first version", async () => {
    const id = await claws.createIssue({ title: "T", authorLogin: "stjohnb", repos: ["org/a"], source: "dashboard" });
    await addClawsIssueRequirementsVersion(id, record("T"), null);
    await claws.createIssue({ title: "unrelated", authorLogin: "x" });
    autoPromotePolicy.current = { attended: true };
    await addClawsIssueRequirementsVersion(id, record("T"), null);
    expect((await claws.getIssue(id))!.lifecycle).toBe("ideas");
  });

  it("promotes a forge issue's shadow on its first version", async () => {
    const shadow = (await createShadowIssue("org/a", 3, { title: "Forge", authorLogin: "someone" }))!.id;
    await addClawsIssueRequirementsVersion(shadow, record("Renamed"), null);
    expect((await claws.getIssue(shadow))!).toMatchObject({ lifecycle: "planning", title: "Forge", requirements_approved_by: "claws" });
  });

  it("promotes by hand, renaming to the approved version's title", async () => {
    const id = await claws.createIssue({ title: "make it quick", authorLogin: "stjohnb", repos: ["org/a"] });
    await claws.promoteIssue(id, "someone", "ideas");
    expect((await claws.getIssue(id))!).toMatchObject({ lifecycle: "planning", approved_requirements_version: null, requirements_approved_by: "someone", title: "make it quick" });

    const titled = await claws.createIssue({ title: "make it quick", authorLogin: "stjohnb", repos: ["org/a"] });
    await addClawsIssueRequirementsVersion(titled, record("Speed up the board"), null);
    await claws.promoteIssue(titled, "someone", "ideas");
    expect((await claws.getIssue(titled))!).toMatchObject({ title: "Speed up the board", filed_title: "make it quick", approved_requirements_version: 1 });
  });

  it("promotes out of Blocked, not only Ideas, when the caller reads that lifecycle", async () => {
    const id = await claws.createIssue({ title: "T", authorLogin: "stjohnb", repos: ["org/a"] });
    await setClawsIssueLifecycle(id, "blocked");
    // A human drag from Blocked straight into Planning: the caller passes the
    // lifecycle it read, `blocked`, not `ideas`.
    expect(await claws.promoteIssue(id, "someone", "blocked")).toBe(true);
    expect((await claws.getIssue(id))!).toMatchObject({ lifecycle: "planning", requirements_approved_by: "someone" });

    // A stale read loses the race rather than promoting.
    await setClawsIssueLifecycle(id, "blocked");
    expect(await claws.promoteIssue(id, "someone", "ideas")).toBe(false);
    expect((await claws.getIssue(id))!.lifecycle).toBe("blocked");
  });

  it("demotes: clears the approval, returns to Ideas and skips a queued planner run", async () => {
    const id = await claws.createIssue({ title: "T", authorLogin: "stjohnb", repos: ["org/a"] });
    await claws.promoteIssue(id, "someone", "ideas");
    const planner = (await enqueueWork("issue-refiner:plan", "org/a", id))!;
    await claws.demoteIssue(id);
    expect((await claws.getIssue(id))!).toMatchObject({ lifecycle: "ideas", requirements_approved_by: null, requirements_approved_at: null });
    expect((await getWorkRow(planner.id))!.status).toBe("completed");
  });

  it("re-enters the board in Planning once past Ideas, and in Ideas otherwise", () => {
    expect(claws.entryLifecycle({ requirements_approved_at: null }, false)).toBe("ideas");
    expect(claws.entryLifecycle({ requirements_approved_at: null }, true)).toBe("planning");
    expect(claws.entryLifecycle({ requirements_approved_at: "2026-09-01 00:00:00" }, false)).toBe("planning");
  });
});

describe("claws-issues attachments", () => {
  afterEach(async () => {
    const [fs, os, path] = await Promise.all([import("node:fs"), import("node:os"), import("node:path")]);
    fs.rmSync(path.join(os.tmpdir(), "claws-issues-attachments-test"), { recursive: true, force: true });
  });

  async function store(issueId: string | null, name: string, type: string) {
    const result = await storeIssueAttachment(issueId, name, Buffer.from("data"), type, "stjohnb");
    if (!result.ok) throw new Error(result.reason);
    return result.row;
  }

  it("lists a native issue's files as { name, url } with the site-relative URL", async () => {
    const id = await claws.createIssue({ title: "T", authorLogin: "stjohnb" });
    const png = await store(id, "shot.png", "image/png");
    const zip = await store(id, "logs.zip", "application/zip");
    await store(null, "pending.png", "image/png");

    expect(await claws.listAttachments(id)).toEqual([
      { name: "shot.png", url: `/issues/${id}/attachments/${png.id}/shot.png` },
      { name: "logs.zip", url: `/issues/${id}/attachments/${zip.id}/logs.zip` },
    ]);
    expect(await claws.listAttachments(id.toLowerCase())).toHaveLength(2);
    expect(await claws.listAttachments(42)).toEqual([]);
  });

  it("stamps comment_id on the attachments a comment links, and only those", async () => {
    const id = await claws.createIssue({ title: "T", authorLogin: "stjohnb" });
    const linked = await store(id, "shot.png", "image/png");
    const unlinked = await store(id, "other.png", "image/png");

    const commentId = await claws.commentOnIssue("", id, `see ![shot](/issues/${id}/attachments/${linked.id}/shot.png)`, "stjohnb");
    expect((await getClawsIssueAttachment(linked.id))?.comment_id).toBe(commentId);
    expect((await getClawsIssueAttachment(unlinked.id))?.comment_id).toBeNull();

    // A later comment re-linking the same file does not move it.
    await claws.commentOnIssue("", id, `again /issues/${id}/attachments/${linked.id}/shot.png`, "stjohnb");
    expect((await getClawsIssueAttachment(linked.id))?.comment_id).toBe(commentId);
  });

  it("stamps only the attachments an allowlist names", async () => {
    const id = await claws.createIssue({ title: "T", authorLogin: "stjohnb" });
    const bodyFile = await store(id, "body.png", "image/png");
    const ownFile = await store(id, "own.png", "image/png");

    const commentId = await claws.commentOnIssue(
      "",
      id,
      `/issues/${id}/attachments/${bodyFile.id}/body.png /issues/${id}/attachments/${ownFile.id}/own.png`,
      "stjohnb",
      { attachmentIds: [ownFile.id] },
    );
    expect((await getClawsIssueAttachment(ownFile.id))?.comment_id).toBe(commentId);
    expect((await getClawsIssueAttachment(bodyFile.id))?.comment_id).toBeNull();
  });
});
