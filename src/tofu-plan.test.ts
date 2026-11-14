import { describe, expect, it } from "vitest";
import {
  formatInfraSummary, infraWorkflowDiffDigest, isInfraPinOnly, isInfraPinPath, isInfraWorkflowPath, isNoOpPlan, isTofuPlanComment,
  isWorkflowOrActionPath, noopMergeDiffVerdict, parseTofuPlanBody, parseTofuPlanResources, parseTofuPlanRoot, tofuPlanFingerprint,
} from "./tofu-plan.js";

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

const section = (path: string, body: string, header = `--- a/${path}\n+++ b/${path}`) =>
  `diff --git a/${path} b/${path}\nindex 1111111..2222222 100644\n${header}\n${body}\n`;
const INSTALL_TOFU = ".github/actions/install-tofu/action.yml";
// The shape of production-infra #707.
const toolBump = section(INSTALL_TOFU, "@@ -5,7 +5,7 @@\n   version:\n     description: OpenTofu version\n-    default: \"1.13.7\"\n+    default: \"1.13.8\"\n     required: false");
const TFTPL = "tofu/modules/hcloud-cluster/templates/_common_tailscale.sh.tftpl";

describe("fleet-infra plan comments", () => {
  const fleet = (imports: number) => [
    "<!-- tofu-plan -->", "### Tofu Plan: tofu/tailscale", "", "Planned at abc1234", "",
    `**${imports} to import** · **0 to add, 0 to change, 0 to replace, 0 to destroy.**`,
  ].join("\n");

  it("counts the import span as changes", () => {
    expect(parseTofuPlanBody(fleet(3))).toEqual({ add: 0, change: 3, replace: 0, destroy: 0 });
    expect(isNoOpPlan(parseTofuPlanBody(fleet(0))!)).toBe(true);
  });

  it("reads the root heading", () => {
    expect(parseTofuPlanRoot(fleet(0))).toBe("tofu/tailscale");
    expect(parseTofuPlanRoot("<!-- tofu-plan -->\n### OpenTofu Plan (redacted summary)")).toBeNull();
  });
});

describe("parseTofuPlanResources", () => {
  it("reads production-infra's redacted bullets, sorted", () => {
    const body = [
      "<!-- tofu-plan -->", "### OpenTofu Plan (redacted summary)", "",
      "**0 to add, 1 to change, 1 to replace, 0 to destroy.**", "",
      "- `module.cluster.hcloud_server.data` — **delete+create** _(replace_by_triggers)_",
      "  - changed attributes: user_data",
      "- `hcloud_volume.postgres_data` — **update**",
    ].join("\n");
    expect(parseTofuPlanResources(body)).toEqual([
      { address: "hcloud_volume.postgres_data", action: "update" },
      { address: "module.cluster.hcloud_server.data", action: "delete+create" },
    ]);
  });

  it("reads raw plan resource lines", () => {
    const body = [
      "### Tofu plan (tofu/)", "```",
      "  # aws_instance.a must be replaced",
      "  # aws_route53_record.b will be updated in-place",
      "  # tailscale_acl.acl will be imported",
      "Plan: 1 to import, 1 to add, 1 to change, 1 to destroy.", "```",
    ].join("\n");
    expect(parseTofuPlanResources(body)).toEqual([
      { address: "aws_instance.a", action: "replaced" },
      { address: "aws_route53_record.b", action: "updated in-place" },
      { address: "tailscale_acl.acl", action: "imported" },
    ]);
  });

  it("is empty for a zero-change plan and null for changes it cannot list", () => {
    expect(parseTofuPlanResources("<!-- tofu-plan -->\n**0 to add, 0 to change, 0 to replace, 0 to destroy.**\n\n_No changes._")).toEqual([]);
    expect(parseTofuPlanResources("<!-- tofu-plan -->\n**0 to add, 2 to change, 0 to replace, 0 to destroy.**\n\n**⚠ Output truncated")).toBeNull();
    expect(parseTofuPlanResources("<!-- tofu-plan -->\nplan failed")).toBeNull();
  });

  it("fingerprints by root, address and action, in any order", () => {
    const a = tofuPlanFingerprint([{ root: null, address: "x.b", action: "update" }, { root: null, address: "x.a", action: "update" }]);
    const b = tofuPlanFingerprint([{ address: "x.a", action: "update" }, { address: "x.b", action: "update" }]);
    expect(a).toBe(b);
    expect(a).toBe("- x.a update\n- x.b update");
    expect(tofuPlanFingerprint([{ root: "tofu/tailscale", address: "x.a", action: "update" }])).not.toBe(tofuPlanFingerprint([{ address: "x.a", action: "update" }]));
  });
});

describe("workflow path tests", () => {
  it("tells tofu-named workflows and actions from other ones", () => {
    expect(isInfraWorkflowPath(INSTALL_TOFU)).toBe(true);
    expect(isInfraWorkflowPath(".forgejo/workflows/Terraform-apply.yml")).toBe(true);
    expect(isInfraWorkflowPath(".forgejo/workflows/ci.yml")).toBe(false);
    expect(isWorkflowOrActionPath(".forgejo/workflows/ci.yml")).toBe(true);
    expect(isWorkflowOrActionPath("tofu/main.tf")).toBe(false);
  });
});

describe("noopMergeDiffVerdict", () => {
  it("admits any diff with no workflow or action file as plan-only", () => {
    const d = section(TFTPL, "@@ -1 +1 @@\n-TAILSCALE_VERSION=1.90.1\n+TAILSCALE_VERSION=1.90.2") + section("scripts/x.sh", "@@ -1 +1 @@\n-a\n+b");
    expect(noopMergeDiffVerdict([TFTPL, "scripts/x.sh"], d)).toEqual({ ok: true, kind: "plan-only" });
    expect(noopMergeDiffVerdict(["tofu/main.tf"], section("tofu/main.tf", "@@ -1 +1 @@\n-  size = 1\n+  size = 2"))).toEqual({ ok: true, kind: "plan-only" });
  });

  it("admits a version-string edit to a tofu action as a tool version bump", () => {
    expect(noopMergeDiffVerdict([INSTALL_TOFU, "docs/x.md"], toolBump + section("docs/x.md", "@@ -1 +1 @@\n-a\n+b")))
      .toEqual({ ok: true, kind: "tool-version-bump" });
    const vTag = section(".forgejo/workflows/tofu-plan-on-pr.yml", "@@ -1 +1 @@\n-        uses: ./x@v1.2\n+        uses: ./x@v1.3.0-rc1");
    expect(noopMergeDiffVerdict([".forgejo/workflows/tofu-plan-on-pr.yml"], vTag)).toEqual({ ok: true, kind: "tool-version-bump" });
  });

  it("refuses any other edit to a tofu workflow or action", () => {
    const run = section(INSTALL_TOFU, "@@ -1 +1 @@\n-  run: tofu version\n+  run: tofu apply -auto-approve");
    expect(noopMergeDiffVerdict([INSTALL_TOFU], run)).toEqual({ ok: false, reason: `non-version change in ${INSTALL_TOFU}` });
    const two = section(INSTALL_TOFU, "@@ -1,2 +1,2 @@\n-  a: 1.0\n-  b: 2.0\n+  a: 1.1\n+  b: 2.1");
    expect(noopMergeDiffVerdict([INSTALL_TOFU], two)).toEqual({ ok: false, reason: `non-version change in ${INSTALL_TOFU}` });
    const urlToo = section(INSTALL_TOFU, "@@ -1 +1 @@\n-  url: https://a/1.13.7/x\n+  url: https://b/1.13.8/x");
    expect(noopMergeDiffVerdict([INSTALL_TOFU], urlToo)).toEqual({ ok: false, reason: `non-version change in ${INSTALL_TOFU}` });
    const added = `diff --git a/${INSTALL_TOFU} b/${INSTALL_TOFU}\nnew file mode 100644\n--- /dev/null\n+++ b/${INSTALL_TOFU}\n@@ -0,0 +1 @@\n+v: 1.0\n`;
    expect(noopMergeDiffVerdict([INSTALL_TOFU], added)).toEqual({ ok: false, reason: `${INSTALL_TOFU} is added, deleted or renamed` });
  });

  it("refuses a workflow or action that names neither tofu nor terraform", () => {
    expect(noopMergeDiffVerdict(["tofu/main.tf", ".forgejo/workflows/ci.yml"], section(".forgejo/workflows/ci.yml", "@@ -1 +1 @@\n-a: 1.0\n+a: 1.1")))
      .toEqual({ ok: false, reason: "changes workflow file .forgejo/workflows/ci.yml" });
  });

  it("refuses a tool bump beside other infra paths", () => {
    expect(noopMergeDiffVerdict([INSTALL_TOFU, "tofu/main.tf"], toolBump + section("tofu/main.tf", "@@ -1 +1 @@\n-a\n+b")))
      .toEqual({ ok: false, reason: "tofu tool version bump also changes tofu/main.tf" });
  });

  it("refuses an empty or unreadable diff", () => {
    expect(noopMergeDiffVerdict([TFTPL], "")).toEqual({ ok: false, reason: "diff unreadable" });
    expect(noopMergeDiffVerdict([], toolBump)).toEqual({ ok: false, reason: "diff unreadable" });
    expect(noopMergeDiffVerdict([INSTALL_TOFU], section("docs/x.md", "@@ -1 +1 @@\n-a\n+b"))).toEqual({ ok: false, reason: `diff unreadable for ${INSTALL_TOFU}` });
  });
});

describe("infraWorkflowDiffDigest unreadable", () => {
  it("is null when a tofu workflow file has no section in the diff", () => {
    expect(infraWorkflowDiffDigest([".forgejo/workflows/tofu-apply.yml"], "")).toBeNull();
  });
});

describe("parseTofuPlanResources completeness", () => {
  it("is null for a truncated comment", () => {
    const body = "Plan: 0 to add, 1 to change, 0 to replace, 0 to destroy.\n- `a.b` — **update**\n**⚠ Output truncated at 60 000 chars.**";
    expect(parseTofuPlanResources(body)).toBeNull();
  });
});

describe("infraWorkflowDiffDigest", () => {
  it("is empty when the PR changes no tofu workflow or action", () => {
    expect(infraWorkflowDiffDigest(["tofu/main.tf", ".forgejo/workflows/ci.yml"], section("tofu/main.tf", "@@ -1 +1 @@\n-a\n+b"))).toBe("");
  });

  it("ignores hunk headers, context and other files", () => {
    const moved = toolBump.replace("@@ -5,7 +5,7 @@", "@@ -9,7 +9,7 @@").replace("     description: OpenTofu version", "     description: The OpenTofu version");
    expect(infraWorkflowDiffDigest([INSTALL_TOFU, "src/a.ts"], toolBump + section("src/a.ts", "@@ -1 +1 @@\n-a\n+b")))
      .toBe(infraWorkflowDiffDigest([INSTALL_TOFU], moved));
  });

  it("changes when the tofu workflow edit changes", () => {
    expect(infraWorkflowDiffDigest([INSTALL_TOFU], toolBump)).not.toBe(infraWorkflowDiffDigest([INSTALL_TOFU], toolBump.replace("1.13.8", "1.13.9")));
  });
});

describe("formatInfraSummary", () => {
  it("states zero counts as 'no …' and omits zero replacements", () => {
    expect(formatInfraSummary(ZERO)).toEqual({
      additions: "no additions", changes: "no changes", deletions: "no deletions", replacements: null, destructive: false,
    });
  });

  it("uses singular and plural forms", () => {
    expect(formatInfraSummary({ add: 1, change: 2, replace: 0, destroy: 0 })).toMatchObject({
      additions: "1 addition", changes: "2 changes", deletions: "no deletions", destructive: false,
    });
    expect(formatInfraSummary({ add: 0, change: 0, replace: 2, destroy: 1 })).toMatchObject({
      deletions: "1 deletion", replacements: "2 replacements", destructive: true,
    });
  });

  it("flags a replace-only plan as destructive", () => {
    expect(formatInfraSummary({ add: 0, change: 0, replace: 1, destroy: 0 })).toMatchObject({ replacements: "1 replacement", destructive: true });
  });
});
