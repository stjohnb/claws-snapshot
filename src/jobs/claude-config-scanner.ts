import fs from "node:fs";
import path from "node:path";
import { LABELS, type Repo } from "../config.js";
import { runRepoScanner, type ScannerSpec } from "./scanner-runner.js";

const NAME = "claude-config-scanner";
const ISSUE_TITLE = "Alert: missing Claude agent configuration";

interface Findings {
  missingInstructions: boolean;
  roles: Record<string, "canonical" | "missing">;
}

function formatIssueBody(findings: Findings): string {
  const lines = [
    "Claws delegates refinement, implementation and review to repo-tailored agents. Root instructions may live in `AGENTS.md` or `CLAUDE.md`, and role documents live in the provider-neutral `.agents/` directory.\n",
  ];

  if (findings.missingInstructions) {
    lines.push("- [ ] `AGENTS.md` at the repo root (with a one-line `CLAUDE.md` containing `@AGENTS.md` so the Claude CLI picks it up) — team-shared guidance describing what this repo does, conventions, and gotchas.");
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
    "├── AGENTS.md                  # checked in, team-shared — the canonical instructions",
    "├── CLAUDE.md                  # checked in; should be a one-line `@AGENTS.md` include",
    "├── CLAUDE.local.md            # gitignored, personal",
    "└── .mcp.json                  # team-shared MCP servers",
    "```",
    "",
    "### What to put in them",
    "",
    "Claude 5-generation models follow judgement better than they follow enumerated rules, and every line of this config is loaded into context on every run — so keep each file small and non-redundant:",
    "",
    "- **`AGENTS.md`** — what the repo is for, how to build and test it, and the gotchas and exceptions someone would only learn by getting them wrong. Do not restate patterns the model can read off the code itself.",
    "- **`AGENTS.md` vs `CLAUDE.md`** — the Codex CLI only auto-loads `AGENTS.md` and the Claude CLI only auto-loads `CLAUDE.md`, so keep the canonical content in `AGENTS.md` and make `CLAUDE.md` a one-line `@AGENTS.md` include rather than a second copy that drifts.",
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
    // Either file satisfies the requirement: Claude auto-loads CLAUDE.md,
    // Codex auto-loads AGENTS.md, and a repo with one of them is not
    // ungoverned — only a repo with neither is.
    missingInstructions:
      !fs.existsSync(path.join(repoDir, "CLAUDE.md")) && !fs.existsSync(path.join(repoDir, "AGENTS.md")),
    roles: {
      "issue-refiner": scanRole(repoDir, "issue-refiner"),
      "issue-implementer": scanRole(repoDir, "issue-implementer"),
      "pr-reviewer": scanRole(repoDir, "pr-reviewer"),
    },
  };

  const missingRoleCount = Object.values(findings.roles).filter((state) => state === "missing").length;
  if (!findings.missingInstructions && missingRoleCount === 0) return null;

  const missingCount = Number(findings.missingInstructions) + missingRoleCount;
  return { body: formatIssueBody(findings), summary: `Found ${missingCount} missing config file(s)` };
}

const SPEC: ScannerSpec = {
  name: NAME,
  issueTitle: ISSUE_TITLE,
  label: LABELS.priority,
  scan,
};

export function run(repos: Repo[]): Promise<void> {
  return runRepoScanner(SPEC, repos);
}
