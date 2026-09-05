import fs from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";

const skillsRoot = new URL("../.skills/", import.meta.url);
const skillDirs = fs
  .readdirSync(skillsRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name);

describe("bundled skills", () => {
  it("finds at least one skill directory", () => {
    expect(skillDirs.length).toBeGreaterThan(0);
  });

  for (const name of skillDirs) {
    describe(name, () => {
      const skillPath = path.join(skillsRoot.pathname, name, "SKILL.md");

      it("has a SKILL.md with valid frontmatter", () => {
        expect(fs.existsSync(skillPath)).toBe(true);
        const content = fs.readFileSync(skillPath, "utf8");
        expect(content.startsWith("---\n")).toBe(true);

        const end = content.indexOf("\n---\n", 4);
        expect(end).toBeGreaterThan(-1);
        const frontmatter = content.slice(4, end);

        const nameMatch = frontmatter.match(/^name:\s*(.+)$/m);
        expect(nameMatch?.[1].trim()).toBe(name);

        const descriptionMatch = frontmatter.match(/^description:\s*(.+)$/m);
        expect(descriptionMatch?.[1].trim().length).toBeGreaterThan(0);
      });
    });
  }
});

describe("ship skill", () => {
  const content = fs.readFileSync(path.join(skillsRoot.pathname, "ship", "SKILL.md"), "utf8");

  it("documents the Refined gate", () => {
    expect(content).toContain("Refined");
  });

  it("documents the claws-phase-done claim comment", () => {
    expect(content).toContain("claws-phase-done:");
  });

  it("documents the SOPS ciphertext verification gate", () => {
    expect(content).toContain(".enc.yaml");
    expect(content).toContain("SOPS_AGE_KEY_FILE");
  });

  it("documents the post-merge manual-action verification gate", () => {
    expect(content).toContain("Manual action required after merge");
  });

  it("documents the claws version-file deploy check", () => {
    expect(content).toContain("/opt/claws/.current-version");
  });

  it("tells the poller to background the sleep", () => {
    expect(content).toContain("run_in_background");
    expect(content).not.toContain("a handful of passes");
  });

  it("prefers the push-based wait over sleeping", () => {
    expect(content).toContain("claws_wait_for_change");
  });

  it("tells the poller what to do when the service restarted", () => {
    expect(content).toContain("restarted");
  });

  it("scopes a bare /ship to the session's subject", () => {
    expect(content).toContain("inherit the session's subject");
  });

  it("requires an explicit argument for the repo-wide resume", () => {
    expect(content).toContain("/ship --all");
  });

  it("keeps Ready issues out of the default work list", () => {
    expect(content).toContain("**Ready** issues are not work");
  });

  it("gates advancing a multi-PR plan on operator confirmation", () => {
    expect(content).toContain("before re-applying **Refined**");
  });
});
