import { describe, it, expect } from "vitest";
import type * as db from "./db.js";
import { tokenize, keyTerms, titleSimilarity, findDuplicateCandidates } from "./issue-dedupe.js";

const FLEET = "St-John-Software/fleet-infra";

function record(id: string, title: string, overrides: Partial<db.ClawsIssueRecord> = {}): db.ClawsIssueRecord {
  return {
    id,
    title,
    body: "",
    author_login: "claws",
    state: "open",
    state_reason: null,
    created_at: "2026-10-05 10:16:38",
    updated_at: "2026-10-05 10:16:38",
    closed_at: null,
    kind: "issue",
    shadow_checked_at: null,
    lifecycle: "ideas",
    stage_changed_at: null,
    approved_requirements_version: null,
    requirements_approved_by: null,
    requirements_approved_at: null,
    source: "agent",
    auto_promote: null,
    filed_title: null,
    dedupe_key: null,
    repos: [FLEET],
    labels: [],
    ...overrides,
  };
}

// The four companion issues three implementers filed on 2026-10-05.
const RENOVATE_TITLES = [
  "Create renovate-github-com secret so Renovate can update npm lockfiles",
  "Create the renovate-github-com Secret so Renovate can look up github.com-hosted actions",
  "Forgejo Renovate: create the github.com token secret and lift the per-run PR cap (follow-up to #1565)",
  "Renovate: create the renovate-github-com Secret so GITHUB_COM_TOKEN is set",
];
const RENOVATE_BODY = "Mint a classic github.com PAT and create the `renovate-github-com` Secret in the `default` namespace so `GITHUB_COM_TOKEN` is set.";

describe("tokenize", () => {
  it("drops stopwords, short words and numbers but keeps short compounds", () => {
    expect(tokenize("Fix the PR cap (follow-up to #1565) in a/b")).toEqual(["fix", "cap", "follow-up", "a/b"]);
  });
});

describe("keyTerms", () => {
  it("extracts compounds, ALL-CAPS identifiers and backticked spans", () => {
    const terms = keyTerms("Create the renovate-github-com Secret so GITHUB_COM_TOKEN is set; edit src/foo.ts and `default namespace`.");
    expect(terms).toEqual(new Set(["default namespace", "renovate-github-com", "github_com_token", "src/foo.ts"]));
  });

  it("excludes numbers, issue refs, native ids and URLs", () => {
    const terms = keyTerms("See #1565, #clw_01M45S1G6S9YPREVAAN809HE3C, clw_01M45S1G6S9YPREVAAN809HE3C, 1.2.3, e.g. https://example.com/x and `42`.");
    expect([...terms]).toEqual([]);
  });
});

describe("titleSimilarity", () => {
  it("is the overlap coefficient over the smaller title", () => {
    expect(titleSimilarity("fix dashboard alignment", "fix dashboard alignment on phones and tablets")).toBe(1);
    expect(titleSimilarity("", "anything")).toBe(0);
  });

  it("matches a compound that is a whole-segment run of another", () => {
    expect(titleSimilarity("github.com secret", "renovate-github-com secret")).toBe(1);
    expect(titleSimilarity("github secret", "renovate-github-com secret")).toBe(0.5);
  });
});

describe("findDuplicateCandidates", () => {
  it("matches the four 2026-10-05 Renovate titles pairwise", () => {
    for (const [i, a] of RENOVATE_TITLES.entries()) {
      for (const [j, b] of RENOVATE_TITLES.entries()) {
        if (i === j) continue;
        const [hit] = findDuplicateCandidates({ title: a, body: RENOVATE_BODY, repos: [FLEET] }, [record("clw_A", b, { body: RENOVATE_BODY })]);
        expect(hit?.strong, `${a} vs ${b}`).toBe(true);
      }
    }
  });

  it("matches the four titles on title alone, without bodies", () => {
    for (const [i, a] of RENOVATE_TITLES.entries()) {
      for (const [j, b] of RENOVATE_TITLES.entries()) {
        if (i === j) continue;
        const [hit] = findDuplicateCandidates({ title: a, body: "", repos: [FLEET] }, [record("clw_A", b)]);
        expect(hit?.strong, `${a} vs ${b}`).toBe(true);
      }
    }
  });

  it("matches on the title an issue was filed under after promotion renamed it", () => {
    const renamed = record("clw_A", "Provision a github.com token for the fleet's Forgejo Renovate", { filed_title: RENOVATE_TITLES[0] });
    const [hit] = findDuplicateCandidates({ title: RENOVATE_TITLES[3]!, body: RENOVATE_BODY, repos: [FLEET] }, [renamed]);
    expect(hit?.strong).toBe(true);
    expect(hit?.sharedKeyTerms).toContain("renovate-github-com");
  });

  it("does not match near-misses that share a repo and a noun", () => {
    const target = RENOVATE_TITLES[3]!;
    for (const title of [
      "Renovate: pin the node image tag in fleet-infra",
      "Add a Grafana alert when the renovate-github-com Secret token expires",
    ]) {
      const hits = findDuplicateCandidates(
        { title, body: "Watch the `renovate-github-com` Secret.", repos: [FLEET] },
        [record("clw_A", target, { body: RENOVATE_BODY })],
      );
      expect(hits.filter((h) => h.strong), title).toEqual([]);
    }
  });

  it("does not match short titles that merely share a word", () => {
    for (const [title, other] of [
      ["Fix CI", "Fix login redirect loop on Safari"],
      ["Bump vitest", "Bump vitest to 4 and migrate config"],
      ["Update README", "Update the API docs and README badges"],
    ] as const) {
      const hits = findDuplicateCandidates(
        { title, body: "", repos: [FLEET] },
        [record("clw_A", other)],
      );
      expect(hits.filter((h) => h.strong), title).toEqual([]);
    }
  });

  it("needs a shared key term below the strong title threshold", () => {
    const open = [record("clw_A", "Fix dashboard board column alignment")];
    const [hit] = findDuplicateCandidates({ title: "Fix dashboard nav alignment", body: "", repos: [FLEET] }, open);
    expect(hit?.similarity).toBe(0.75);
    expect(hit?.strong).toBe(false);
  });

  it("only considers issues sharing a repo, including as a non-primary repo", () => {
    const elsewhere = record("clw_A", RENOVATE_TITLES[0]!, { repos: ["St-John-Software/claws"] });
    const secondary = record("clw_B", RENOVATE_TITLES[1]!, { repos: ["St-John-Software/bin-scraper", FLEET] });
    const hits = findDuplicateCandidates({ title: RENOVATE_TITLES[3]!, body: "", repos: [FLEET] }, [elsewhere, secondary]);
    expect(hits.map((h) => h.record.id)).toEqual(["clw_B"]);
  });

  it("ranks strong matches first, then by similarity, then oldest first", () => {
    const open = [
      record("clw_C", RENOVATE_TITLES[1]!),
      record("clw_B", RENOVATE_TITLES[0]!),
      record("clw_A", "Fix dashboard board column alignment"),
      record("clw_D", RENOVATE_TITLES[3]!),
    ];
    const hits = findDuplicateCandidates({ title: RENOVATE_TITLES[3]!, body: "", repos: [FLEET] }, open);
    expect(hits.map((h) => h.record.id)).toEqual(["clw_D", "clw_B", "clw_C"]);
  });
});
