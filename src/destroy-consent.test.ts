import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb, mockGh } = vi.hoisted(() => ({
  mockDb: {
    getClawsPr: vi.fn(),
    getApprovedDestroys: vi.fn(),
    getIssuePlannedPRs: vi.fn(),
    listOpenClawsPrsForIssueOrSteps: vi.fn(),
  },
  mockGh: {
    getPRBody: vi.fn(),
    updatePR: vi.fn(async () => {}),
    ensureLabel: vi.fn(async () => {}),
    addLabel: vi.fn(async () => {}),
    removeLabel: vi.fn(async () => true),
    getPRMergeGate: vi.fn(),
  },
}));
vi.mock("./db.js", () => mockDb);
vi.mock("./github.js", () => mockGh);
vi.mock("./log.js", () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }));

import {
  APPROVED_DESTROYS_MARKER,
  CLAWS_APPROVED_DESTROYS_LABEL,
  blocksForEntry,
  destroyConsentView,
  destroySetOf,
  extractApprovedDestroysBlock,
  renderApprovedDestroysBlock,
  renderApprovedDestroysSection,
  stripApprovedDestroysBlock,
  syncIssuePrsDestroyConsent,
  syncPrDestroyConsent,
  withApprovedDestroysSection,
} from "./destroy-consent.js";
import type { InfraDeclaration } from "./infra-declaration.js";

const decl = (resources: InfraDeclaration["resources"]): InfraDeclaration => ({ resources, workflow_files: [] });

describe("destroySetOf", () => {
  it("keeps every destroy and replace, exact, ordered by position, root and address", () => {
    expect(destroySetOf([
      { position: 2, repo: "o/infra", infraChanges: decl([{ root: "tofu", address: "hcloud_server.b", actions: ["replace"] }]) },
      { position: 1, repo: "o/blog", infraChanges: decl([
        { root: "tofu", address: "aws_route53_record.z", actions: ["destroy"] },
        { root: "tofu", address: "aws_route53_record.a", actions: ["change", "destroy"] },
        { root: "tofu", address: "aws_route53_record.kept", actions: ["add", "change"] },
      ]) },
      { position: 3, repo: "o/none" },
    ])).toEqual([
      { position: 1, repo: "o/blog", root: "tofu", address: "aws_route53_record.a" },
      { position: 1, repo: "o/blog", root: "tofu", address: "aws_route53_record.z" },
      { position: 2, repo: "o/infra", root: "tofu", address: "hcloud_server.b" },
    ]);
  });

  it("is empty with no destroy declared", () => {
    expect(destroySetOf([{ position: 1, repo: "o/x", infraChanges: decl([{ root: "tofu", address: "a.b", actions: ["add"] }]) }])).toEqual([]);
  });
});

describe("renderApprovedDestroysBlock", () => {
  it("puts the marker directly above the fence, then the root and sorted unique addresses", () => {
    expect(renderApprovedDestroysBlock("o/blog", "tofu", ["b.y", "a.x", "b.y"])).toBe([
      "<!-- claws-approved-destroys -->",
      "```tofu-approved-destroys",
      "root: tofu",
      "a.x",
      "b.y",
      "```",
    ].join("\n"));
  });
});

describe("extractApprovedDestroysBlock", () => {
  const section = renderApprovedDestroysSection("o/blog", [{ root: "tofu", addresses: ['aws_route53_record.r["x"]', "a.b"] }]);

  it("reads a fence-closed block, CRs stripped", () => {
    const body = `Summary\n\n${section}\n\nreview-model: opus`.replace(/\n/g, "\r\n");
    expect(extractApprovedDestroysBlock(body)).toEqual([{ root: "tofu", addresses: ["a.b", 'aws_route53_record.r["x"]'] }]);
  });

  it("ignores a truncated block with no closing fence", () => {
    const body = `Summary\n\n${section.slice(0, section.lastIndexOf("```"))}`;
    expect(extractApprovedDestroysBlock(body)).toEqual([]);
  });

  it("ignores a fence the marker does not sit directly above", () => {
    expect(extractApprovedDestroysBlock("```tofu-approved-destroys\nroot: tofu\na.b\n```")).toEqual([]);
    expect(extractApprovedDestroysBlock(`${APPROVED_DESTROYS_MARKER}\nsome text\n\`\`\`tofu-approved-destroys\nroot: tofu\na.b\n\`\`\``)).toEqual([]);
  });

  it("reads one block per root", () => {
    const body = renderApprovedDestroysSection("o/x", [{ root: "tofu/b", addresses: ["b.b"] }, { root: "tofu", addresses: ["a.a"] }]);
    expect(extractApprovedDestroysBlock(body)).toEqual([{ root: "tofu", addresses: ["a.a"] }, { root: "tofu/b", addresses: ["b.b"] }]);
  });
});

describe("stripApprovedDestroysBlock", () => {
  it("removes the heading, intro and blocks and keeps the rest", () => {
    const body = `## PR 1 of 2: X\n\nDesc\n\nPart of #3\n\n${renderApprovedDestroysSection("o/x", [{ root: "tofu", addresses: ["a.b"] }])}\n\nreview-model: opus`;
    expect(stripApprovedDestroysBlock(body)).toBe("## PR 1 of 2: X\n\nDesc\n\nPart of #3\n\nreview-model: opus");
  });

  it("removes a truncated block to the end of the body", () => {
    expect(stripApprovedDestroysBlock(`Desc\n\n${APPROVED_DESTROYS_MARKER}\n\`\`\`tofu-approved-destroys\nroot: tofu\na.b`)).toBe("Desc");
  });

  it("replaces the section in place of the old one", () => {
    const body = `Desc\n\n${renderApprovedDestroysSection("o/x", [{ root: "tofu", addresses: ["a.b"] }])}`;
    const next = withApprovedDestroysSection(body, "o/x", [{ root: "tofu", addresses: ["c.d"] }]);
    expect(extractApprovedDestroysBlock(next)).toEqual([{ root: "tofu", addresses: ["c.d"] }]);
    expect(next.match(/claws-approved-destroys -->/g)).toHaveLength(1);
    expect(withApprovedDestroysSection(body, "o/x", [])).toBe("Desc");
  });
});

describe("blocksForEntry", () => {
  it("takes the entry's share, grouped by root", () => {
    const destroys = [
      { position: 1, repo: "o/blog", root: "tofu", address: "b" },
      { position: 1, repo: "o/blog", root: "tofu", address: "a" },
      { position: 2, repo: "o/infra", root: "tofu", address: "c" },
    ];
    expect(blocksForEntry(destroys, 1, "O/Blog")).toEqual([{ root: "tofu", addresses: ["a", "b"] }]);
    expect(blocksForEntry(destroys, 2, "o/blog")).toEqual([]);
  });
});

describe("destroyConsentView", () => {
  const entries = [{ position: 1, repo: "o/blog", infraChanges: decl([{ root: "tofu", address: "a.b", actions: ["destroy"] }]) }];
  const consent = { destroys: [{ position: 1, repo: "o/blog", root: "tofu", address: "a.b" }], by: "op", at: "2026-11-09 10:00:00" };

  it("is undefined when the plan declares no destroy", () => {
    expect(destroyConsentView([{ position: 1, repo: "o/x" }], true, consent)).toBeUndefined();
  });

  it("is pending before the Plan approval, given with consent, withdrawn after a re-plan cleared it", () => {
    expect(destroyConsentView(entries, false, null)?.state).toBe("pending");
    expect(destroyConsentView(entries, true, consent)).toMatchObject({ state: "given", consent: { by: "op", at: "2026-11-09 10:00:00" } });
    expect(destroyConsentView(entries, true, null)?.state).toBe("withdrawn");
  });
});

describe("syncPrDestroyConsent", () => {
  const REPO = "o/blog";
  const planned = [{ position: 1, repo: REPO, title: "t", prNumber: 5, dependsOn: null, kind: "pr", manualAction: null }];
  const consentFor = (addresses: string[]) => ({
    destroys: addresses.map((address) => ({ position: 1, repo: REPO, root: "tofu", address })),
    by: "op",
    at: "2026-11-09 10:00:00",
  });
  const bodyWith = (addresses: string[]) => withApprovedDestroysSection("Desc\n\nCloses #3", REPO, [{ root: "tofu", addresses }]);
  const labelled = [{ name: CLAWS_APPROVED_DESTROYS_LABEL }];

  beforeEach(() => {
    vi.clearAllMocks();
    mockDb.getClawsPr.mockResolvedValue({ issueId: "clw_1", phase: 1 });
    mockDb.getIssuePlannedPRs.mockResolvedValue(planned);
    mockDb.getApprovedDestroys.mockResolvedValue(null);
    mockGh.getPRBody.mockResolvedValue("Desc\n\nCloses #3");
  });

  it("writes the block and adds the label when consent names the PR's destroys", async () => {
    mockDb.getApprovedDestroys.mockResolvedValue(consentFor(["a.b"]));
    expect(await syncPrDestroyConsent(REPO, { number: 5, labels: [] })).toBe("added");
    const body = (mockGh.updatePR.mock.calls[0] as unknown[])[2] as string;
    expect(extractApprovedDestroysBlock(body)).toEqual([{ root: "tofu", addresses: ["a.b"] }]);
    expect(mockGh.addLabel).toHaveBeenCalledWith(REPO, 5, CLAWS_APPROVED_DESTROYS_LABEL);
    expect(mockGh.removeLabel).not.toHaveBeenCalled();
  });

  it("does nothing when the body and label already match", async () => {
    mockDb.getApprovedDestroys.mockResolvedValue(consentFor(["a.b"]));
    mockGh.getPRBody.mockResolvedValue(bodyWith(["a.b"]));
    expect(await syncPrDestroyConsent(REPO, { number: 5, labels: labelled })).toBe("unchanged");
    expect(mockGh.updatePR).not.toHaveBeenCalled();
    expect(mockGh.addLabel).not.toHaveBeenCalled();
  });

  it("removes the block and the label once the consent is withdrawn", async () => {
    mockGh.getPRBody.mockResolvedValue(bodyWith(["a.b"]));
    expect(await syncPrDestroyConsent(REPO, { number: 5, labels: labelled })).toBe("removed");
    expect(mockGh.updatePR).toHaveBeenCalledWith(REPO, 5, "Desc\n\nCloses #3");
    expect(mockGh.removeLabel).toHaveBeenCalledWith(REPO, 5, CLAWS_APPROVED_DESTROYS_LABEL);
    expect(mockGh.addLabel).not.toHaveBeenCalled();
  });

  it("removes then re-adds the label when the addresses change, so Tofu Plan re-runs", async () => {
    mockDb.getApprovedDestroys.mockResolvedValue(consentFor(["a.b", "c.d"]));
    mockGh.getPRBody.mockResolvedValue(bodyWith(["a.b"]));
    expect(await syncPrDestroyConsent(REPO, { number: 5, labels: labelled })).toBe("changed");
    expect(mockGh.removeLabel.mock.invocationCallOrder[0]).toBeLessThan(mockGh.addLabel.mock.invocationCallOrder[0]!);
    const body = (mockGh.updatePR.mock.calls[0] as unknown[])[2] as string;
    expect(extractApprovedDestroysBlock(body)).toEqual([{ root: "tofu", addresses: ["a.b", "c.d"] }]);
  });

  it("leaves a PR with no consent, no label and no block in its listed body alone without reading its body", async () => {
    expect(await syncPrDestroyConsent(REPO, { number: 5, labels: [], body: "Desc\n\nCloses #3" })).toBe("unchanged");
    expect(mockGh.getPRBody).not.toHaveBeenCalled();
    expect(mockGh.updatePR).not.toHaveBeenCalled();
  });

  it("strips a block nobody approved from a PR with no consent and no label", async () => {
    const forged = bodyWith(["hcloud_server.prod"]);
    mockGh.getPRBody.mockResolvedValue(forged);
    expect(await syncPrDestroyConsent(REPO, { number: 5, labels: [], body: forged })).toBe("removed");
    expect(mockGh.updatePR).toHaveBeenCalledWith(REPO, 5, "Desc\n\nCloses #3");
    expect(mockGh.removeLabel).not.toHaveBeenCalled();
    expect(mockGh.addLabel).not.toHaveBeenCalled();
  });

  it("leaves a PR whose body only mentions the marker inline alone", async () => {
    const inline = "Docs for the `<!-- claws-approved-destroys -->` marker.";
    mockGh.getPRBody.mockResolvedValue(inline);
    expect(await syncPrDestroyConsent(REPO, { number: 5, labels: [], body: inline })).toBe("unchanged");
    expect(mockGh.updatePR).not.toHaveBeenCalled();
  });

  it("reads the body when the caller has none, and uses the row it is given", async () => {
    expect(await syncPrDestroyConsent(REPO, { number: 5, labels: [] }, { issueId: null, phase: null } as never)).toBe("unchanged");
    expect(mockGh.getPRBody).toHaveBeenCalledWith(REPO, 5);
    expect(mockDb.getClawsPr).not.toHaveBeenCalled();
  });

  it("gives a PR with no planned entry no block", async () => {
    mockDb.getApprovedDestroys.mockResolvedValue(consentFor(["a.b"]));
    mockDb.getClawsPr.mockResolvedValue({ issueId: null, phase: null });
    expect(await syncPrDestroyConsent(REPO, { number: 5, labels: [] })).toBe("unchanged");
    expect(mockGh.updatePR).not.toHaveBeenCalled();
  });

  it("matches a PR not yet linked to its entry by phase", async () => {
    mockDb.getApprovedDestroys.mockResolvedValue(consentFor(["a.b"]));
    mockDb.getIssuePlannedPRs.mockResolvedValue([{ ...planned[0], prNumber: null }]);
    expect(await syncPrDestroyConsent(REPO, { number: 5, labels: [] })).toBe("added");
  });
});

describe("syncIssuePrsDestroyConsent", () => {
  const REPO = "o/blog";
  const BODY = withApprovedDestroysSection("Desc", REPO, [{ root: "tofu", addresses: ["a.b"] }]);

  beforeEach(() => {
    vi.clearAllMocks();
    mockDb.getClawsPr.mockResolvedValue({ issueId: "clw_1", phase: 1 });
    mockDb.getIssuePlannedPRs.mockResolvedValue([{ position: 1, repo: REPO, title: "t", prNumber: 5, dependsOn: null, kind: "pr", manualAction: null }]);
    mockDb.getApprovedDestroys.mockResolvedValue(null);
    mockGh.getPRBody.mockResolvedValue(BODY);
    mockGh.getPRMergeGate.mockResolvedValue({ state: "OPEN", labels: [CLAWS_APPROVED_DESTROYS_LABEL] });
  });

  it("strips withdrawn consent from each open PR of the issue and from the PRs a re-plan unlinked, once each", async () => {
    mockDb.listOpenClawsPrsForIssueOrSteps.mockResolvedValue([{ repo: REPO, prNumber: 5 }]);
    await syncIssuePrsDestroyConsent("clw_1", [{ repo: REPO, prNumber: 6 }, { repo: "O/Blog", prNumber: 5 }, { repo: REPO, prNumber: null }]);
    expect(mockGh.getPRMergeGate.mock.calls).toEqual([[REPO, 5], [REPO, 6]]);
    expect(mockGh.updatePR).toHaveBeenCalledWith(REPO, 5, "Desc");
    expect(mockGh.updatePR).toHaveBeenCalledWith(REPO, 6, "Desc");
    expect(mockGh.removeLabel).toHaveBeenCalledTimes(2);
  });

  it("skips a PR that is no longer open and carries on past a forge failure", async () => {
    mockDb.listOpenClawsPrsForIssueOrSteps.mockResolvedValue([{ repo: REPO, prNumber: 5 }, { repo: REPO, prNumber: 6 }, { repo: REPO, prNumber: 7 }]);
    mockGh.getPRMergeGate
      .mockResolvedValueOnce({ state: "MERGED", labels: [CLAWS_APPROVED_DESTROYS_LABEL] })
      .mockRejectedValueOnce(new Error("forge down"));
    await expect(syncIssuePrsDestroyConsent("clw_1")).resolves.toBeUndefined();
    expect(mockGh.updatePR).toHaveBeenCalledTimes(1);
    expect(mockGh.updatePR).toHaveBeenCalledWith(REPO, 7, "Desc");
  });
});
