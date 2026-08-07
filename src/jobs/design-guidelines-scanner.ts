import fs from "node:fs";
import path from "node:path";
import { type Repo } from "../config.js";
import { runRepoScanner, type ScannerSpec } from "./scanner-runner.js";

const NAME = "design-guidelines-scanner";
const ISSUE_TITLE = "chore: add frontend design guidelines (docs/DESIGN.md)";

const SKIP_DIRS = new Set([
  ".git", "node_modules", "vendor", "dist", "build", "target", "coverage",
  ".venv", "venv", "__pycache__", ".next", ".tox", ".gradle", "Pods", ".expo",
  "docs", ".github",
]);
const MAX_DEPTH = 3;

const UI_EXTENSIONS = new Set([
  ".html", ".css", ".scss", ".sass", ".less", ".tsx", ".jsx", ".vue", ".svelte", ".astro",
]);
const MIN_UI_FILES = 3;
const MAX_EXAMPLE_FILES = 5;

const FRAMEWORK_DEPS = [
  "react", "react-dom", "vue", "svelte", "next", "@angular/core",
  "tailwindcss", "astro", "solid-js", "preact",
];

const GUIDELINES_PATHS = [
  "docs/DESIGN.md", "DESIGN.md", "docs/design-system.md", "docs/DESIGN-SYSTEM.md", "docs/design.md",
  ".claude/rules/frontend.md", ".claude/rules/design.md",
];

interface UiEvidence {
  frameworks: string[];
  files: string[];
}

function walk(repoDir: string, relDir: string, depth: number, evidence: UiEvidence): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(path.join(repoDir, relDir), { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (entry.isFile()) {
      const relPath = relDir === "" ? entry.name : `${relDir}/${entry.name}`;
      const ext = path.extname(entry.name);
      if (UI_EXTENSIONS.has(ext) && evidence.files.length < MAX_EXAMPLE_FILES) {
        evidence.files.push(relPath);
      }
      if (entry.name === "package.json") {
        try {
          const content = fs.readFileSync(path.join(repoDir, relPath), "utf-8");
          const parsed = JSON.parse(content) as {
            dependencies?: Record<string, string>;
            devDependencies?: Record<string, string>;
          };
          const deps = { ...parsed.dependencies, ...parsed.devDependencies };
          for (const dep of FRAMEWORK_DEPS) {
            if (dep in deps && !evidence.frameworks.includes(dep)) evidence.frameworks.push(dep);
          }
        } catch {
          // Malformed manifest — not a scanner failure, just no framework evidence from this file.
        }
      }
    }
  }

  if (depth >= MAX_DEPTH) return;
  for (const entry of entries) {
    if (!entry.isDirectory() || SKIP_DIRS.has(entry.name)) continue;
    const childRel = relDir === "" ? entry.name : `${relDir}/${entry.name}`;
    walk(repoDir, childRel, depth + 1, evidence);
  }
}

function hasUi(evidence: UiEvidence): boolean {
  return evidence.frameworks.length > 0 || evidence.files.length >= MIN_UI_FILES;
}

function hasGuidelines(repoDir: string): boolean {
  if (GUIDELINES_PATHS.some((p) => fs.existsSync(path.join(repoDir, p)))) return true;

  const claudeMdPath = path.join(repoDir, "CLAUDE.md");
  if (fs.existsSync(claudeMdPath)) {
    const content = fs.readFileSync(claudeMdPath, "utf-8");
    if (/^#{1,4}\s+.*\b(design|frontend|styling)\b.*$/im.test(content)) return true;
  }

  return false;
}

function formatIssueBody(evidence: UiEvidence): string {
  const lines: string[] = [
    "This repo appears to have a user-facing UI but no design guidelines document, so Claws' agents fall back to generic defaults when doing UI work instead of following a consistent style.",
    "",
    "Evidence:",
    "",
  ];

  if (evidence.frameworks.length > 0) {
    lines.push(...evidence.frameworks.map((f) => `- Framework dependency: \`${f}\``));
  }
  if (evidence.files.length > 0) {
    lines.push(...evidence.files.map((f) => `- \`${f}\``));
  }

  lines.push(
    "",
    "Claws' agents read a repository's own design guidelines (`docs/DESIGN.md`, `.claude/rules/frontend.md`, or a design section in `CLAUDE.md`) before doing UI work and treat them as authoritative. Without one, they fall back to generic anti-slop defaults that may not match this repo's intended aesthetic.",
    "",
    "Add a `docs/DESIGN.md` recording this repo's design choices. Starter template:",
    "",
    "```markdown",
    "# Design Guidelines",
    "",
    "## Typeface",
    "<!-- Which font(s) this repo uses, and why -->",
    "",
    "## Colour tokens",
    "<!-- The palette / CSS custom properties, light and dark if applicable -->",
    "",
    "## Motion",
    "<!-- Animation/transition conventions, if any -->",
    "",
    "## Backgrounds",
    "<!-- Background treatment: flat, gradient, texture, etc. -->",
    "",
    "## Anti-patterns to avoid",
    "<!-- Things a future contributor (human or AI) should NOT do in this repo -->",
    "```",
    "",
    "Background: https://platform.claude.com/cookbook/coding-prompting-for-frontend-aesthetics",
    "",
    "---",
    "",
    `If this repo intentionally has no design system, this check can be turned off via the \`${NAME}\` job-disable config for this repo rather than by closing this issue — an open issue with the exact title above will otherwise be re-filed on the next daily scan.`,
  );

  return lines.join("\n");
}

function scan(repoDir: string, _repo: Repo): { body: string; summary?: string } | null {
  const evidence: UiEvidence = { frameworks: [], files: [] };
  walk(repoDir, "", 0, evidence);

  if (!hasUi(evidence)) return null;
  if (hasGuidelines(repoDir)) return null;

  return {
    body: formatIssueBody(evidence),
    summary: "UI detected with no design guidelines",
  };
}

const SPEC: ScannerSpec = {
  name: NAME,
  issueTitle: ISSUE_TITLE,
  searchQuery: ISSUE_TITLE,
  scan,
};

export function run(repos: Repo[]): Promise<void> {
  return runRepoScanner(SPEC, repos);
}
