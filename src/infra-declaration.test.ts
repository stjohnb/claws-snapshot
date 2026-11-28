import { describe, expect, it } from "vitest";
import {
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
