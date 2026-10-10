import { describe, expect, it } from "vitest";
import { isInfraPinOnly, isInfraPinPath, isNoOpPlan, isTofuPlanComment, parseTofuPlanBody } from "./tofu-plan.js";

const ZERO = { add: 0, change: 0, replace: 0, destroy: 0 };

describe("isTofuPlanComment", () => {
  it("recognises both repos' plan comments and nothing else", () => {
    expect(isTofuPlanComment("<!-- tofu-plan -->\n### OpenTofu Plan")).toBe(true);
    expect(isTofuPlanComment("\n### Tofu plan (tofu/)\n\n```\n")).toBe(true);
    expect(isTofuPlanComment("Looks like the ### Tofu plan (tofu/) is fine")).toBe(false);
  });
});

describe("parseTofuPlanBody", () => {
  it("parses production-infra's counts line", () => {
    expect(parseTofuPlanBody("<!-- tofu-plan -->\n**0 to add, 0 to change, 0 to replace, 0 to destroy.**")).toEqual(ZERO);
    expect(parseTofuPlanBody("<!-- tofu-plan -->\n**3 to add, 1 to change, 2 to replace, 4 to destroy.**"))
      .toEqual({ add: 3, change: 1, replace: 2, destroy: 4 });
  });

  it("reads bstjohn-blog's \"No changes.\" sentence as all zeros", () => {
    const body = "### Tofu plan (tofu/)\n\n```\naws_route53_zone.z: Refreshing state... [id=Z1]\n\nNo changes. Your infrastructure matches the configuration.\n\nOpenTofu has compared your real infrastructure against your configuration\n```";
    expect(parseTofuPlanBody(body)).toEqual(ZERO);
  });

  it("parses a raw Plan: line and counts replacements", () => {
    const body = [
      "### Tofu plan (tofu/)", "", "```",
      "  # aws_instance.a must be replaced",
      "-/+ resource \"aws_instance\" \"a\" {",
      "  # aws_route53_record.b will be updated in-place",
      "",
      "Plan: 1 to add, 1 to change, 1 to destroy.",
      "```",
    ].join("\n");
    expect(parseTofuPlanBody(body)).toEqual({ add: 1, change: 1, replace: 1, destroy: 1 });
  });

  it("counts imports as changes so an import plan is never a no-op", () => {
    const p = parseTofuPlanBody("### Tofu plan (tofu/)\n```\nPlan: 1 to import, 0 to add, 0 to change, 0 to destroy.\n```");
    expect(p).toEqual({ add: 0, change: 1, replace: 0, destroy: 0 });
    expect(isNoOpPlan(p!)).toBe(false);
  });

  it("returns null for an outputs-only plan or a truncated body", () => {
    expect(parseTofuPlanBody("### Tofu plan (tofu/)\n```\nChanges to Outputs:\n  + x = \"y\"\n```")).toBeNull();
    expect(parseTofuPlanBody("### Tofu plan (tofu/)\n```\naws_route53_zone.z: Refreshing state...")).toBeNull();
  });
});

describe("isInfraPinOnly", () => {
  it("accepts only versions.tf and .terraform.lock.hcl files", () => {
    expect(isInfraPinPath("tofu/versions.tf")).toBe(true);
    expect(isInfraPinPath(".terraform.lock.hcl")).toBe(true);
    expect(isInfraPinOnly(["tofu/versions.tf", "tofu/.terraform.lock.hcl"])).toBe(true);
  });

  it("rejects a diff with any other file, or an empty diff", () => {
    expect(isInfraPinOnly(["tofu/versions.tf", "tofu/main.tf"])).toBe(false);
    expect(isInfraPinOnly(["tofu/versions.tf", ".github/workflows/tofu-plan-on-pr.yml"])).toBe(false);
    expect(isInfraPinOnly(["tofu/versions.tf.bak"])).toBe(false);
    expect(isInfraPinOnly([])).toBe(false);
  });
});
