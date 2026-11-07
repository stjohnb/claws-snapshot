import { describe, expect, it } from "vitest";
import { formatInfraSummary, isInfraPinOnly, isInfraPinPath, isNoOpPlan, isTofuPlanComment, parseTofuPlanBody, providerBumpDiffVerdict } from "./tofu-plan.js";

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

describe("providerBumpDiffVerdict", () => {
  const section = (path: string, body: string, header = `--- a/${path}\n+++ b/${path}`) =>
    `diff --git a/${path} b/${path}\nindex 1111111..2222222 100644\n${header}\n${body}\n`;
  const pin = (path: string) => section(path, "@@ -3,7 +3,7 @@\n     hcloud = {\n-      version = \"1.69.0\"\n+      version = \"1.70.0\"\n     }");
  const commentOnly = section("tofu/data-server.tf", "@@ -1,4 +1,4 @@\n-# Pinned against hcloud 1.69.0\n+# Pinned against hcloud 1.70.0\n \n resource \"hcloud_server\" \"data\" {");
  const docs = section("docs/supabase.md", "@@ -10 +10 @@\n-hcloud 1.69.0\n+hcloud 1.70.0");
  // The shape of production-infra #121.
  const files121 = ["tofu/versions.tf", "tofu/bootstrap/versions.tf", "tofu/data-server.tf", "docs/supabase.md"];
  const diff121 = pin("tofu/versions.tf") + pin("tofu/bootstrap/versions.tf") + commentOnly + docs;

  it("admits pin files, a comment-only .tf edit and a docs page", () => {
    expect(providerBumpDiffVerdict(files121, diff121)).toEqual({ ok: true });
  });

  it("accepts // comments and blank lines in a .tf edit", () => {
    const d = section("tofu/a.tf", "@@ -1,2 +1,3 @@\n-// old\n+// new\n+\n resource \"x\" \"y\" {}");
    expect(providerBumpDiffVerdict(["tofu/a.tf"], d)).toEqual({ ok: true });
  });

  it("refuses a non-comment change in a resource .tf file", () => {
    const d = section("tofu/data-server.tf", "@@ -1,3 +1,3 @@\n # comment\n-  server_type = \"cx22\"\n+  server_type = \"cx32\"");
    expect(providerBumpDiffVerdict(["tofu/versions.tf", "tofu/data-server.tf"], pin("tofu/versions.tf") + d))
      .toEqual({ ok: false, reason: "non-comment change in tofu/data-server.tf" });
  });

  it("does not mistake a removed `--` content line for a file header", () => {
    const d = section("tofu/a.tf", "@@ -1,3 +1,2 @@\n   user_data = <<EOT\n---- \n   EOT");
    expect(providerBumpDiffVerdict(["tofu/a.tf"], d)).toEqual({ ok: false, reason: "non-comment change in tofu/a.tf" });
  });

  it("refuses a comment-like edit inside a heredoc", () => {
    const d = section("tofu/a.tf", "@@ -1,4 +1,4 @@\n   user_data = <<EOT\n-# old\n+# changed\n   EOT");
    expect(providerBumpDiffVerdict(["tofu/a.tf"], d)).toEqual({ ok: false, reason: "non-comment change in tofu/a.tf" });
  });

  it("refuses a comment edit followed by a heredoc terminator whose opener is out of context", () => {
    const d = section("tofu/a.tf", "@@ -9,3 +9,3 @@\n-# old\n+# changed\n   EOT");
    expect(providerBumpDiffVerdict(["tofu/a.tf"], d)).toEqual({ ok: false, reason: "non-comment change in tofu/a.tf" });
  });

  it("accepts a comment edit outside any heredoc", () => {
    const d = section("tofu/a.tf", "@@ -1,3 +1,3 @@\n resource \"x\" \"y\" {}\n-# old\n+# changed\n resource \"z\" \"w\" {}");
    expect(providerBumpDiffVerdict(["tofu/a.tf"], d)).toEqual({ ok: true });
  });

  it("refuses any workflow file", () => {
    for (const wf of [".forgejo/workflows/tofu-apply.yml", ".github/workflows/x.yml"]) {
      expect(providerBumpDiffVerdict(["tofu/versions.tf", wf], pin("tofu/versions.tf") + section(wf, "@@ -1 +1 @@\n-a\n+b")))
        .toEqual({ ok: false, reason: `changes workflow file ${wf}` });
    }
  });

  it("refuses a file that is neither a pin, a .tf comment edit nor docs", () => {
    expect(providerBumpDiffVerdict(["tofu/files/x.yaml"], section("tofu/files/x.yaml", "@@ -1 +1 @@\n-a: 1\n+a: 2")))
      .toEqual({ ok: false, reason: "tofu/files/x.yaml is not a provider pin, comment-only .tf edit or docs file" });
    expect(providerBumpDiffVerdict(["tofu/README.md"], section("tofu/README.md", "@@ -1 +1 @@\n-a\n+b")))
      .toEqual({ ok: false, reason: "tofu/README.md is not a provider pin, comment-only .tf edit or docs file" });
    expect(providerBumpDiffVerdict(["tofu/main.tf.json"], section("tofu/main.tf.json", "@@ -1 +1 @@\n-{}\n+{}")))
      .toEqual({ ok: false, reason: "tofu/main.tf.json is not a provider pin, comment-only .tf edit or docs file" });
  });

  it("refuses an added, deleted or renamed .tf file", () => {
    const deleted = `diff --git a/tofu/old.tf b/tofu/old.tf\ndeleted file mode 100644\n--- a/tofu/old.tf\n+++ /dev/null\n@@ -1 +0,0 @@\n-# only a comment\n`;
    expect(providerBumpDiffVerdict(["tofu/old.tf"], deleted)).toEqual({ ok: false, reason: "tofu/old.tf is added, deleted or renamed" });
    const added = `diff --git a/tofu/new.tf b/tofu/new.tf\nnew file mode 100644\n--- /dev/null\n+++ b/tofu/new.tf\n@@ -0,0 +1 @@\n+# only a comment\n`;
    expect(providerBumpDiffVerdict(["tofu/new.tf"], added)).toEqual({ ok: false, reason: "tofu/new.tf is added, deleted or renamed" });
    const renamed = `diff --git a/tofu/a.tf b/tofu/b.tf\nsimilarity index 100%\nrename from tofu/a.tf\nrename to tofu/b.tf\n`;
    expect(providerBumpDiffVerdict(["tofu/b.tf"], renamed)).toEqual({ ok: false, reason: "tofu/b.tf is added, deleted or renamed" });
  });

  it("refuses an empty or unreadable diff", () => {
    expect(providerBumpDiffVerdict(files121, "")).toEqual({ ok: false, reason: "diff unreadable" });
    expect(providerBumpDiffVerdict([], diff121)).toEqual({ ok: false, reason: "diff unreadable" });
    expect(providerBumpDiffVerdict(["tofu/data-server.tf"], docs)).toEqual({ ok: false, reason: "diff unreadable for tofu/data-server.tf" });
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
