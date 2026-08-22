import fs from "node:fs";
import path from "node:path";
import { LABELS, type Repo } from "../config.js";
import { runRepoScanner, type ScannerSpec } from "./scanner-runner.js";

const NAME = "claude-config-scanner";
const ISSUE_TITLE = "Alert: missing Claude agent configuration";

interface Findings {
  missingClaudeMd: boolean;
  missingRefiner: boolean;
  missingImplementer: boolean;
  missingReviewer: boolean;
}

function formatIssueBody(findings: Findings): string {
  const lines = [
    "Claws delegates refinement, implementation and review to repo-tailored agents, which need a root `CLAUDE.md` plus named subagent definitions in `.claude/agents/` to work from. The files detected as missing are listed below — please add at least these.\n",
  ];

  if (findings.missingClaudeMd) {
    lines.push("- [ ] `CLAUDE.md` at the repo root — team-shared guidance describing what this repo does, conventions, and gotchas.");
  }
  if (findings.missingRefiner) {
    lines.push("- [ ] `.claude/agents/issue-refiner.md` — subagent definition Claws uses when refining/planning issues for this repo.");
  }
  if (findings.missingImplementer) {
    lines.push("- [ ] `.claude/agents/issue-implementer.md` — subagent definition Claws uses when implementing issues for this repo.");
  }
  if (findings.missingReviewer) {
    lines.push("- [ ] `.claude/agents/pr-reviewer.md` — subagent definition Claws uses when reviewing pull requests for this repo.");
  }

  lines.push(
    "",
    "Recommended layout for Claude configuration in this repo:",
    "",
    "```",
    "my-repo/",
    "├── .claude/",
    "│   ├── settings.json",
    "│   ├── agents/",
    "│   │   ├── issue-refiner.md",
    "│   │   ├── issue-implementer.md",
    "│   │   └── pr-reviewer.md",
    "│   ├── skills/",
    "│   │   └── api-conventions/SKILL.md",
    "│   └── rules/",
    "│       ├── frontend.md        # path-gated to src/frontend/",
    "│       └── migrations.md      # path-gated to db/migrations/",
    "├── CLAUDE.md                  # checked in, team-shared",
    "├── CLAUDE.local.md            # gitignored, personal",
    "└── .mcp.json                  # team-shared MCP servers",
    "```",
    "",
    "### What to put in them",
    "",
    "Claude 5-generation models follow judgement better than they follow enumerated rules, and every line of this config is loaded into context on every run — so keep each file small and non-redundant:",
    "",
    "- **`CLAUDE.md`** — what the repo is for, how to build and test it, and the gotchas and exceptions someone would only learn by getting them wrong. Do not restate patterns the model can read off the code itself.",
    "- **`.claude/agents/*.md`** — the agent's role and the altitude it should work at, not an exhaustive checklist. These are appended on top of `CLAUDE.md`, so anything already stated there does not need repeating.",
    "- **`.claude/skills/`** — detailed or task-specific guidance (release steps, API conventions, a migration runbook) belongs here, where it loads only for the tasks that need it rather than on every run.",
  );

  return lines.join("\n");
}

function scan(repoDir: string, _repo: Repo): { body: string; summary?: string } | null {
  const findings: Findings = {
    missingClaudeMd: !fs.existsSync(path.join(repoDir, "CLAUDE.md")),
    missingRefiner: !fs.existsSync(path.join(repoDir, ".claude", "agents", "issue-refiner.md")),
    missingImplementer: !fs.existsSync(path.join(repoDir, ".claude", "agents", "issue-implementer.md")),
    missingReviewer: !fs.existsSync(path.join(repoDir, ".claude", "agents", "pr-reviewer.md")),
  };

  if (!findings.missingClaudeMd && !findings.missingRefiner && !findings.missingImplementer && !findings.missingReviewer) return null;

  const missingCount = Number(findings.missingClaudeMd) + Number(findings.missingRefiner) + Number(findings.missingImplementer) + Number(findings.missingReviewer);
  return { body: formatIssueBody(findings), summary: `Found ${missingCount} missing Claude config file(s)` };
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
