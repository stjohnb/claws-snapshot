import { describe, expect, it } from "vitest";
import {
  declarationsHash,
  matchInfraDeclaration,
  parseTofuPlanResourceBlock,
  readTofuPlanResourceBlock,
  validateInfraDeclaration,
  type InfraDeclaration,
} from "./infra-declaration.js";

const PROD_COMMENT = [
  "<!-- tofu-plan -->",
  "**1 to add, 1 to change, 1 to replace, 0 to destroy.**",
  "",
  "<details><summary>Resource list (machine-readable, for Claws)</summary>",
  "",
  "```tofu-plan-resources",
  "root: tofu",
  "module.cluster.hcloud_server.data\treplace",
  "hcloud_firewall.web\tchange",
  "hcloud_volume.extra[\"a\"]\tadd",
  "```",
  "",
  "</details>",
].join("\n");

describe("parseTofuPlanResourceBlock", () => {
  it("reads the root line and one address/kind per line", () => {
    expect(parseTofuPlanResourceBlock(PROD_COMMENT)).toEqual({
      root: "tofu",
      resources: [
        { address: "module.cluster.hcloud_server.data", kind: "replace" },
        { address: "hcloud_firewall.web", kind: "change" },
        { address: "hcloud_volume.extra[\"a\"]", kind: "add" },
      ],
    });
  });

  it("reads an empty block as a root with no resources", () => {
    expect(parseTofuPlanResourceBlock("```tofu-plan-resources\nroot: tofu/tailscale\n```")).toEqual({ root: "tofu/tailscale", resources: [] });
  });

  it("is null without a block or a root line", () => {
    expect(parseTofuPlanResourceBlock("<!-- tofu-plan -->\n**0 to add, 0 to change, 0 to replace, 0 to destroy.**")).toBeNull();
    expect(parseTofuPlanResourceBlock("```tofu-plan-resources\nfoo\tadd\n```")).toBeNull();
  });

  it("keeps an unknown kind as written", () => {
    expect(parseTofuPlanResourceBlock("```tofu-plan-resources\nroot: tofu\na.b\tforget\n```")?.resources).toEqual([{ address: "a.b", kind: "forget" }]);
  });
});

describe("readTofuPlanResourceBlock", () => {
  const fleet = (counts: string, lines: string[]) => [
    "<!-- tofu-plan -->",
    "### Tofu Plan: tofu/tailscale",
    "",
    counts,
    "",
    "```tofu-plan-resources",
    "root: tofu/tailscale",
    ...lines,
    "```",
  ].join("\n");

  it("returns the block when it accounts for the counts", () => {
    expect(readTofuPlanResourceBlock(PROD_COMMENT)).toEqual(parseTofuPlanResourceBlock(PROD_COMMENT));
  });

  it("takes fleet-infra's import span back out of the change count", () => {
    const body = fleet("**2 to import** · **0 to add, 1 to change, 0 to replace, 0 to destroy.**", ["a.x\timport", "a.y\timport", "a.z\tchange"]);
    expect(readTofuPlanResourceBlock(body)).toMatchObject({ root: "tofu/tailscale" });
  });

  it("is unavailable when the block is short of the counts", () => {
    const short = PROD_COMMENT.replace("hcloud_volume.extra[\"a\"]\tadd\n", "");
    expect(readTofuPlanResourceBlock(short)).toBe("plan comment resource list does not match its counts");
    const noDestroy = fleet("**0 to add, 0 to change, 0 to replace, 1 to destroy.**", []);
    expect(readTofuPlanResourceBlock(noDestroy)).toBe("plan comment resource list does not match its counts");
    const missingChange = fleet("**0 to add, 2 to change, 0 to replace, 0 to destroy.**", ["a.z\tchange"]);
    expect(readTofuPlanResourceBlock(missingChange)).toBe("plan comment resource list does not match its counts");
  });

  it("is unavailable on a truncated body", () => {
    expect(readTofuPlanResourceBlock(`${PROD_COMMENT}\n\n_Output truncated._`)).toBe("plan comment is truncated");
  });

  it("is unavailable without counts or a block", () => {
    expect(readTofuPlanResourceBlock(PROD_COMMENT.replace(/\*\*1 to add.*\n/, ""))).toBe("plan comment has no counts");
    expect(readTofuPlanResourceBlock("<!-- tofu-plan -->\n**0 to add, 0 to change, 0 to replace, 0 to destroy.**")).toBe("plan comment has no resource list");
  });

  it("is unavailable when the block names another root than the heading", () => {
    const body = fleet("**0 to add, 0 to change, 0 to replace, 0 to destroy.**", []).replace("root: tofu/tailscale", "root: tofu/other");
    expect(readTofuPlanResourceBlock(body)).toBe("plan comment resource list names root tofu/other, not tofu/tailscale");
  });
});

describe("validateInfraDeclaration", () => {
  it("accepts and normalises a declaration", () => {
    expect(validateInfraDeclaration({
      resources: [{ root: "tofu/", address: "module.x.y", actions: ["replace", "change", "change"] }],
      workflow_files: ["./.forgejo/workflows/tofu-apply.yml"],
    })).toEqual({
      resources: [{ root: "tofu", address: "module.x.y", actions: ["change", "replace"] }],
      workflow_files: [".forgejo/workflows/tofu-apply.yml"],
    });
  });

  it("rejects empty fields, a mid-address wildcard, unknown actions and non-infra workflow files", () => {
    expect(validateInfraDeclaration({ resources: [{ root: "", address: "a", actions: ["add"] }] })).toMatch(/root is empty/);
    expect(validateInfraDeclaration({ resources: [{ root: "tofu", address: "", actions: ["add"] }] })).toMatch(/address is empty/);
    expect(validateInfraDeclaration({ resources: [{ root: "tofu", address: "a.*.b", actions: ["add"] }] })).toMatch(/trailing wildcard/);
    expect(validateInfraDeclaration({ resources: [{ root: "tofu", address: "a", actions: ["delete"] }] })).toMatch(/"delete"/);
    expect(validateInfraDeclaration({ resources: [{ root: "tofu", address: "module.x.*", actions: ["change"] }] })).not.toBeTypeOf("string");
    expect(validateInfraDeclaration({ resources: [{ root: "tofu", address: "module.x.*", actions: ["destroy"] }] })).toMatch(/exact address/);
    expect(validateInfraDeclaration({ resources: [{ root: "tofu", address: "module.x.*", actions: ["change", "replace"] }] })).toMatch(/exact address/);
    expect(validateInfraDeclaration({ resources: [], workflow_files: [".forgejo/workflows/ci.yml"] })).toMatch(/not a tofu\/terraform workflow/);
    expect(validateInfraDeclaration({ resources: [], workflow_files: [] })).toMatch(/declares nothing/);
    expect(validateInfraDeclaration("x")).toMatch(/must be an object/);
  });

  it("caps resources at 200", () => {
    const resources = Array.from({ length: 201 }, (_, i) => ({ root: "tofu", address: `a.r${i}`, actions: ["add"] }));
    expect(validateInfraDeclaration({ resources })).toMatch(/at most 200/);
  });
});

describe("declarationsHash", () => {
  const a: InfraDeclaration = { resources: [{ root: "tofu", address: "a.b", actions: ["add"] }, { root: "tofu", address: "a.a", actions: ["change"] }], workflow_files: [] };
  const reordered: InfraDeclaration = { resources: [{ root: "tofu", address: "a.a", actions: ["change"] }, { root: "tofu", address: "a.b", actions: ["add"] }], workflow_files: [] };

  it("is stable across resource order and entries without a declaration", () => {
    expect(declarationsHash([{ repo: "o/p", infraChanges: a }]))
      .toBe(declarationsHash([{ repo: "o/q" }, { repo: "O/P", infraChanges: reordered }]));
  });

  it("changes when any declaration changes", () => {
    const changed: InfraDeclaration = { ...a, resources: [...a.resources, { root: "tofu", address: "a.c", actions: ["destroy"] }] };
    expect(declarationsHash([{ repo: "o/p", infraChanges: a }])).not.toBe(declarationsHash([{ repo: "o/p", infraChanges: changed }]));
    expect(declarationsHash([{ repo: "o/p", infraChanges: a }])).not.toBe(declarationsHash([{ repo: "o/q", infraChanges: a }]));
  });
});

describe("matchInfraDeclaration", () => {
  const decl: InfraDeclaration = {
    resources: [
      { root: "tofu", address: "module.cluster.hcloud_server.data", actions: ["change"] },
      { root: "tofu", address: "hcloud_firewall.*", actions: ["change"] },
      { root: "tofu", address: "hcloud_volume.extra[\"a\"]", actions: ["add"] },
    ],
    workflow_files: [".forgejo/workflows/tofu-apply.yml"],
  };

  it("never matches a kind the scripts do not emit, even where change is declared", () => {
    const roots = [{ root: "tofu", resources: [{ address: "hcloud_firewall.web", kind: "forget" }] }];
    expect(matchInfraDeclaration(decl, roots, [])).toEqual({ ok: false, unexpected: ["tofu: hcloud_firewall.web forget not declared (declared as change)"] });
  });

  it("passes when every change is declared, with wildcard and literal index keys", () => {
    const roots = [{ root: "tofu", resources: [
      { address: "module.cluster.hcloud_server.data", kind: "change" as const },
      { address: "hcloud_firewall.web", kind: "change" as const },
      { address: "hcloud_volume.extra[\"a\"]", kind: "add" as const },
    ] }];
    expect(matchInfraDeclaration(decl, roots, ["tofu/main.tf", ".forgejo/workflows/tofu-apply.yml"])).toEqual({ ok: true });
  });

  it("passes a plan doing less than declared, and ignores imports", () => {
    const roots = [{ root: "tofu", resources: [{ address: "anything.else", kind: "import" as const }] }, { root: "tofu/tailscale", resources: [{ address: "x.y", kind: "import" as const }] }];
    expect(matchInfraDeclaration(decl, roots, ["tofu/main.tf"])).toEqual({ ok: true });
  });

  it("names a declared change that is actually a replace", () => {
    const roots = [{ root: "tofu", resources: [{ address: "module.cluster.hcloud_server.data", kind: "replace" as const }] }];
    expect(matchInfraDeclaration(decl, roots, [])).toEqual({ ok: false, unexpected: ["tofu: module.cluster.hcloud_server.data replace not declared (declared as change)"] });
  });

  it("names an undeclared address, an index key that differs, an undeclared root and an undeclared workflow file", () => {
    const roots = [
      { root: "tofu", resources: [{ address: "hcloud_network.main", kind: "add" as const }, { address: "hcloud_volume.extra[\"b\"]", kind: "add" as const }] },
      { root: "tofu/tailscale", resources: [{ address: "tailscale_acl.this", kind: "change" as const }] },
    ];
    const result = matchInfraDeclaration(decl, roots, [".forgejo/workflows/tofu-apply.yml", ".forgejo/workflows/tofu-plan-on-pr.yml", ".forgejo/workflows/ci.yml"]);
    expect(result).toEqual({ ok: false, unexpected: [
      "tofu: hcloud_network.main add not declared",
      "tofu: hcloud_volume.extra[\"b\"] add not declared",
      "root tofu/tailscale not declared",
      "tofu/tailscale: tailscale_acl.this change not declared",
      "workflow file .forgejo/workflows/tofu-plan-on-pr.yml not declared",
    ] });
  });
});
