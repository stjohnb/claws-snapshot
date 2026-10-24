import fs from "node:fs";
import path from "node:path";
import { LABELS, type Repo } from "../config.js";
import { runRepoScanner, type ScannerSpec } from "./scanner-runner.js";

const NAME = "claude-config-scanner";
/** Frozen: this string is the dedupe key `findIssueByExactTitle` matches on, so
 *  editing it orphans every open alert issue and files a second one. It no longer
 *  describes the full finding set — `legacyClaudeMd` is neither a missing file
 *  nor about Claude (it reports a root file that must be deleted). Don't "fix" the wording. */
const MISSING_CONFIG_ISSUE_TITLE = "Alert: missing Claude agent configuration";

interface Findings {
  /** No `AGENTS.md` at the repo root — the agents see no root instructions at all. */
  missingInstructions: boolean;
  /** A `CLAUDE.md` still exists — `AGENTS.md` is now the only root instructions file. */
  legacyClaudeMd: boolean;
  roles: Record<string, "canonical" | "missing">;
}

function formatIssueBody(findings: Findings): string {
  const lines = [
    "Claws delegates refinement, implementation and review to repo-tailored agents. Root instructions live in `AGENTS.md`, and role documents live in the provider-neutral `.agents/` directory.\n",
  ];

  if (findings.missingInstructions) {
    lines.push("- [ ] `AGENTS.md` at the repo root — team-shared guidance describing what this repo does, conventions, and gotchas.");
  }
  if (findings.legacyClaudeMd) {
    lines.push("- [ ] `CLAUDE.md` still exists — `AGENTS.md` is the only root instructions file; move anything beyond the `@AGENTS.md` include into `AGENTS.md` and delete the file");
  }
  for (const [role, state] of Object.entries(findings.roles)) {
    if (state === "canonical") continue;
    const canonicalPath = `.agents/${role}.md`;
    const description = role === "issue-refiner"
      ? "role document Claws uses when refining/planning issues for this repo."
      : role === "issue-implementer"
        ? "role document Claws uses when implementing issues for this repo."
        : "role document Claws uses when reviewing pull requests for this repo.";
    lines.push(`- [ ] Add \`${canonicalPath}\` — ${description}`);
  }

  lines.push(
    "",
    "Recommended layout for agent configuration in this repo:",
    "",
    "```",
    "my-repo/",
    "├── .agents/",
    "│   ├── issue-refiner.md",
    "│   ├── issue-implementer.md",
    "│   └── pr-reviewer.md",
    "├── .skills/",
    "│   └── api-conventions/",
    "│       └── SKILL.md",
    "├── .claude/",
    "│   ├── settings.json",
    "│   └── rules/",
    "│       ├── frontend.md        # path-gated to src/frontend/",
    "│       └── migrations.md      # path-gated to db/migrations/",
    "├── AGENTS.md                  # checked in, team-shared — the only root instructions file",
    "├── CLAUDE.local.md            # gitignored, personal",
    "└── .mcp.json                  # team-shared MCP servers",
    "```",
    "",
    "### What to put in them",
    "",
    "Claude 5-generation models follow judgement better than they follow enumerated rules, and every line of this config is loaded into context on every run — so keep each file small and non-redundant:",
    "",
    "- **`AGENTS.md`** — what the repo is for, how to build and test it, and the gotchas and exceptions someone would only learn by getting them wrong. Do not restate patterns the model can read off the code itself. It is the only root instructions file: Claws inlines it into every run, so a second root file such as `CLAUDE.md` is only a copy that drifts.",
    "- **`.agents/*.md`** — the role document's job and the altitude it should work at, not an exhaustive checklist. These are appended on top of the root instructions, so anything already stated there does not need repeating.",
    "- **`.skills/`** — detailed or task-specific guidance (release steps, API conventions, a migration runbook) belongs here, where it loads only for the tasks that need it rather than on every run.",
  );

  return lines.join("\n");
}

function scanRole(repoDir: string, role: string): "canonical" | "missing" {
  return fs.existsSync(path.join(repoDir, ".agents", `${role}.md`)) ? "canonical" : "missing";
}

function scan(repoDir: string, _repo: Repo): { body: string; summary?: string } | null {
  const findings: Findings = {
    // `AGENTS.md` is the only root instructions file: Claws inlines it for every
    // provider, so a repo without one is ungoverned no matter what else it carries.
    missingInstructions: !fs.existsSync(path.join(repoDir, "AGENTS.md")),
    // Any surviving `CLAUDE.md` is a second root file that can drift out of sync —
    // flagged whatever it contains, including a bare `@AGENTS.md` include.
    legacyClaudeMd: fs.existsSync(path.join(repoDir, "CLAUDE.md")),
    roles: {
      "issue-refiner": scanRole(repoDir, "issue-refiner"),
      "issue-implementer": scanRole(repoDir, "issue-implementer"),
      "pr-reviewer": scanRole(repoDir, "pr-reviewer"),
    },
  };

  const missingRoleCount = Object.values(findings.roles).filter((state) => state === "missing").length;
  const rootFindingCount = Number(findings.missingInstructions) + Number(findings.legacyClaudeMd);
  if (rootFindingCount === 0 && missingRoleCount === 0) return null;

  const missingCount = rootFindingCount + missingRoleCount;
  return { body: formatIssueBody(findings), summary: `Found ${missingCount} agent-config finding(s)` };
}

const MISSING_CONFIG_SPEC: ScannerSpec = {
  name: NAME,
  issueTitle: MISSING_CONFIG_ISSUE_TITLE,
  label: LABELS.priority,
  scan,
};

export async function run(repos: Repo[]): Promise<void> {
  await runRepoScanner(MISSING_CONFIG_SPEC, repos);
}
