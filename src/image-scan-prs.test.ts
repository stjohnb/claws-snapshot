import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./log.js", () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }));

const mockGh = vi.hoisted(() => ({
  getPRChangedFiles: vi.fn(),
  getPRBody: vi.fn(),
  getPRMergeGate: vi.fn(),
  listPRCommits: vi.fn(),
  listCompareChangedFiles: vi.fn(),
  getCommitDiff: vi.fn(),
}));
vi.mock("./github.js", () => mockGh);

import {
  checkImageScanPruneDiff, checkImageScanSnapshotDiff, imageScanHoldText, pinChangedPaths,
  IMAGE_SCAN_EXCEPTIONS_FILE, IMAGE_SCAN_SNAPSHOT_FILE,
} from "./image-scan-prs.js";

const SCANNED = "a".repeat(40);
const BASE = "b".repeat(40);
const BODY = `Prunes unused exceptions.\n\nimage-scan-scanned-commit: ${SCANNED}\n`;
const REPO = "St-John-Software/production-infra";

const tagDiff = (path: string) => [
  `diff --git a/${path} b/${path}`,
  "index 1111111..2222222 100644",
  `--- a/${path}`,
  `+++ b/${path}`,
  "@@ -3,1 +3,1 @@",
  "-    newTag: v1.2.3",
  "+    newTag: v1.2.4",
  "",
].join("\n");

const prune = (over: Parameters<typeof checkImageScanPruneDiff>[2] = {}) =>
  checkImageScanPruneDiff(REPO, 7, { knownFiles: [IMAGE_SCAN_EXCEPTIONS_FILE], body: BODY, baseSha: BASE, ...over });

describe("checkImageScanSnapshotDiff", () => {
  it("passes a snapshot-only diff", async () => {
    expect(await checkImageScanSnapshotDiff(REPO, 1, [IMAGE_SCAN_SNAPSHOT_FILE])).toEqual({ ok: true, kind: "snapshot" });
  });

  it("names the extra files of a snapshot PR that changes anything else", async () => {
    const verdict = await checkImageScanSnapshotDiff(REPO, 1, [IMAGE_SCAN_SNAPSHOT_FILE, ".forgejo/workflows/ci.yml"]);
    expect(verdict).toEqual({ ok: false, kind: "snapshot", reason: "extra-files", files: [".forgejo/workflows/ci.yml"] });
    if (verdict.ok) throw new Error("unreachable");
    expect(imageScanHoldText(verdict)).toBe(
      "snapshot PR changes files other than security/image-scan/advisories.json: .forgejo/workflows/ci.yml",
    );
  });

  it("reports an unreadable file list as no-files", async () => {
    mockGh.getPRChangedFiles.mockResolvedValueOnce([]);
    const verdict = await checkImageScanSnapshotDiff(REPO, 1);
    expect(verdict).toMatchObject({ ok: false, reason: "no-files" });
    if (verdict.ok) throw new Error("unreachable");
    expect(imageScanHoldText(verdict)).toBe("snapshot PR has no readable changed files");
  });
});

describe("checkImageScanPruneDiff", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGh.listPRCommits.mockResolvedValue([{ sha: "c".repeat(40), parents: [SCANNED], subject: "chore: prune" }]);
    mockGh.listCompareChangedFiles.mockResolvedValue({ totalCommits: 1, commits: [{ sha: "d".repeat(40), files: ["docs/README.md"] }] });
    mockGh.getCommitDiff.mockResolvedValue("");
  });

  it("passes a clean prune: one commit on the scanned commit, no manifest pin change on main", async () => {
    expect(await prune()).toEqual({ ok: true, kind: "prune" });
    expect(mockGh.listCompareChangedFiles).toHaveBeenCalledWith(REPO, SCANNED, BASE);
    // A docs-only range never fetches a commit diff.
    expect(mockGh.getCommitDiff).not.toHaveBeenCalled();
  });

  it("holds a prune that changes another file", async () => {
    const verdict = await prune({ knownFiles: [IMAGE_SCAN_EXCEPTIONS_FILE, "apps/x/deployment.yaml"] });
    expect(verdict).toMatchObject({ ok: false, reason: "extra-files", files: ["apps/x/deployment.yaml"] });
    if (verdict.ok) throw new Error("unreachable");
    expect(imageScanHoldText(verdict)).toBe(
      "prune PR changes files other than security/image-scan/exceptions.yaml: apps/x/deployment.yaml",
    );
  });

  it("holds a prune with no scanned-commit marker (today's generator output)", async () => {
    const verdict = await prune({ body: "Prunes unused exceptions." });
    expect(verdict).toMatchObject({ ok: false, reason: "no-scanned-commit" });
    if (verdict.ok) throw new Error("unreachable");
    expect(imageScanHoldText(verdict)).toBe("prune PR records no scanned commit");
    expect(mockGh.listPRCommits).not.toHaveBeenCalled();
  });

  it("holds a prune carrying a two-parent merge commit", async () => {
    mockGh.listPRCommits.mockResolvedValue([
      { sha: "c".repeat(40), parents: [SCANNED], subject: "chore: prune" },
      { sha: "e".repeat(40), parents: ["c".repeat(40), BASE], subject: "Merge branch 'main'" },
    ]);
    const verdict = await prune();
    expect(verdict).toMatchObject({ ok: false, reason: "merge-commit" });
    if (verdict.ok) throw new Error("unreachable");
    expect(imageScanHoldText(verdict)).toBe("prune PR carries a conflict-resolution merge");
  });

  it("holds a prune with a commit beyond the generator's", async () => {
    mockGh.listPRCommits.mockResolvedValue([
      { sha: "c".repeat(40), parents: [SCANNED], subject: "chore: prune" },
      { sha: "e".repeat(40), parents: ["c".repeat(40)], subject: "fix: apply advisory review nits" },
    ]);
    expect(await prune()).toMatchObject({ ok: false, reason: "extra-commits" });
  });

  it("holds a single commit whose parent is not the scanned commit", async () => {
    mockGh.listPRCommits.mockResolvedValue([{ sha: "c".repeat(40), parents: [BASE], subject: "chore: prune" }]);
    expect(await prune()).toMatchObject({ ok: false, reason: "extra-commits" });
  });

  it("holds a stale scan whose range moves a newTag: under apps/", async () => {
    mockGh.listCompareChangedFiles.mockResolvedValue({
      totalCommits: 2,
      commits: [
        { sha: "d".repeat(40), files: ["docs/README.md"] },
        { sha: "f".repeat(40), files: ["apps/web/kustomization.yaml"] },
      ],
    });
    mockGh.getCommitDiff.mockResolvedValue(tagDiff("apps/web/kustomization.yaml"));
    const verdict = await prune();
    expect(verdict).toMatchObject({ ok: false, reason: "stale-scan", paths: ["apps/web/kustomization.yaml"] });
    expect(mockGh.getCommitDiff).toHaveBeenCalledWith(REPO, "f".repeat(40));
    if (verdict.ok) throw new Error("unreachable");
    expect(imageScanHoldText(verdict)).toBe("prune scan predates image-pin changes on main (apps/web/kustomization.yaml)");
  });

  it("stays exempt when a manifest commit on main changes no image pin", async () => {
    mockGh.listCompareChangedFiles.mockResolvedValue({ totalCommits: 1, commits: [{ sha: "f".repeat(40), files: ["apps/web/deployment.yaml"] }] });
    mockGh.getCommitDiff.mockResolvedValue([
      "diff --git a/apps/web/deployment.yaml b/apps/web/deployment.yaml",
      "--- a/apps/web/deployment.yaml",
      "+++ b/apps/web/deployment.yaml",
      "@@ -1,1 +1,1 @@",
      "-  replicas: 1",
      "+  replicas: 2",
    ].join("\n"));
    expect(await prune()).toEqual({ ok: true, kind: "prune" });
  });

  it("holds a scanned commit the compare cannot find", async () => {
    mockGh.listCompareChangedFiles.mockResolvedValue(null);
    const verdict = await prune();
    expect(verdict).toMatchObject({ ok: false, reason: "scanned-commit-not-on-main", scannedCommit: SCANNED });
    if (verdict.ok) throw new Error("unreachable");
    expect(imageScanHoldText(verdict)).toBe("prune PR's scanned commit aaaaaaa is not on main");
  });

  it("holds a truncated compare as unverifiable", async () => {
    mockGh.listCompareChangedFiles.mockResolvedValue({ totalCommits: 300, commits: [{ sha: "d".repeat(40), files: [] }] });
    const verdict = await prune();
    expect(verdict).toMatchObject({ ok: false, reason: "unverifiable" });
    if (verdict.ok) throw new Error("unreachable");
    expect(imageScanHoldText(verdict)).toBe("could not verify main's image pins since the scanned commit");
  });

  it("holds a failed read as unverifiable", async () => {
    mockGh.listPRCommits.mockRejectedValue(new Error("forgejo 502"));
    expect(await prune()).toMatchObject({ ok: false, reason: "unverifiable" });
  });

  it("reads the body and base tip live when not passed", async () => {
    mockGh.getPRBody.mockResolvedValue(BODY);
    mockGh.getPRMergeGate.mockResolvedValue({ baseSha: SCANNED });
    expect(await checkImageScanPruneDiff(REPO, 7, { knownFiles: [IMAGE_SCAN_EXCEPTIONS_FILE] })).toEqual({ ok: true, kind: "prune" });
    // The base has not moved since the scan: nothing to compare.
    expect(mockGh.listCompareChangedFiles).not.toHaveBeenCalled();
  });
});

describe("pinChangedPaths", () => {
  it("counts image:, value: and @sha256: lines only in manifest YAML", () => {
    const diff = [
      tagDiff("docs/example.yaml"),
      [
        "diff --git a/clusters/prod/app.yml b/clusters/prod/app.yml",
        "--- a/clusters/prod/app.yml",
        "+++ b/clusters/prod/app.yml",
        "@@ -1,1 +1,1 @@",
        "-  - image: ghcr.io/x/app:1@sha256:" + "0".repeat(64),
        "+  - image: ghcr.io/x/app:2@sha256:" + "1".repeat(64),
      ].join("\n"),
    ].join("\n");
    expect(pinChangedPaths(diff)).toEqual(["clusters/prod/app.yml"]);
  });
});
