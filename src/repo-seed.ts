/**
 * The files `claws_create_repo` (`POST /api/repos`) commits into a repo it
 * creates, so none of the baseline scanners files an issue against it merely
 * for being new: `claws.json` with a generated avatar, an `AGENTS.md` holding
 * the automation-host policy, the three `.agents/` role documents, and an
 * observability and a security policy that are true of a repo with no code.
 *
 * The caller may pass a repo kind, a purpose brief and its own policy and
 * role documents. Every candidate tree is checked by `validateSeedTree` with
 * the same `ScannerSpec.scan` functions and drift rules the daily scanners
 * run; a caller file (or purpose-specific text) that fails is replaced by the
 * static text, per file, and reported in `fallbacks`. The static seed always
 * passes (guarded by `repo-seed.test.ts`).
 *
 * Seeded policies carry `SEEDED_POLICY_MARKER`, so the `seeded-policy` drift
 * rule asks for the real policy once the repo gains code.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Repo } from "./config.js";
import { HOST_POLICY_MARKDOWN } from "./host-policy.js";
import { BASELINE_SCANNER_SPECS } from "./jobs/baseline-scanners.js";
import { readObservabilityPolicy } from "./observability-audit.js";
import { KNOWN_GAPS_HEADING, missingObservabilityRules, NO_TELEMETRY_SENTENCE } from "./observability-contract.js";
import { detectObservabilityDrift } from "./observability-drift.js";
import { readSecurityPolicy } from "./security-audit.js";
import { missingSecurityRules, SECURITY_GUIDANCE, type RepoKind } from "./security-contract.js";
import { detectSecurityDrift } from "./security-drift.js";
import { SEEDED_POLICY_MARKER } from "./seeded-policy.js";

export const OBSERVABILITY_SEED_PATH = "docs/observability.md";
export const SECURITY_SEED_PATH = "docs/security.md";
export const AVATAR_SEED_PATH = "docs/avatar.svg";
export const ROLE_SEED_PATHS = [".agents/issue-refiner.md", ".agents/issue-implementer.md", ".agents/pr-reviewer.md"] as const;

/** The paths a caller may author through `files`; everything else is composed by Claws. */
export const CALLER_SEED_PATHS: readonly string[] = [OBSERVABILITY_SEED_PATH, SECURITY_SEED_PATH, ...ROLE_SEED_PATHS];

/** Every path the seed commit writes, in commit order. */
export const SEED_PATHS: readonly string[] = ["claws.json", "AGENTS.md", OBSERVABILITY_SEED_PATH, SECURITY_SEED_PATH, ...ROLE_SEED_PATHS, AVATAR_SEED_PATH];

/** Largest caller-authored file, in bytes. */
export const MAX_SEED_FILE_BYTES = 32 * 1024;
/** Longest `purpose` brief, in characters. */
export const MAX_PURPOSE_CHARS = 4000;

/** The repo kinds `kind` accepts: the ones `detectRepoKind` and `SECURITY_GUIDANCE` know. */
export const SEED_KINDS = Object.keys(SECURITY_GUIDANCE) as RepoKind[];

const KIND_DESCRIPTIONS: Readonly<Record<RepoKind, string>> = {
  "container-service": "a service that will run from a container image",
  infra: "infrastructure (Kubernetes manifests or OpenTofu)",
  "static-site": "a static site",
  "cli-or-library": "a CLI or library",
  "firmware-or-hardware": "firmware or hardware",
  "config-only": "configuration only",
};

export interface RepoSeedInput {
  /** `owner/name`. */
  fullName: string;
  /** Web URL of the repo on Forgejo. */
  url: string;
  description: string;
  kind?: RepoKind | null;
  /** Free-text brief of what the repo is for, richer than the one-line description. */
  purpose?: string | null;
  /** Caller-authored files, keyed by a `CALLER_SEED_PATHS` path. */
  files?: Readonly<Record<string, string>>;
  /** The Claws-native issue the repo is created for. */
  issue?: { id: string; title: string } | null;
}

export interface SeedFallback {
  path: string;
  reasons: string[];
}

export interface RepoSeed {
  /** Path to content, for every `SEED_PATHS` entry. */
  files: Record<string, string>;
  /** Each file whose caller-supplied or purpose-specific content failed validation and was replaced. */
  fallbacks: SeedFallback[];
}

export interface SeedProblem {
  /** The seed file the problem is attributed to, or null when none is. */
  path: string | null;
  reason: string;
}

/** `text` with Markdown heading marks removed, so a brief cannot open a section of its own. */
function stripHeadings(text: string): string {
  return text.replace(/^[ \t]{0,3}#{1,6}[ \t]*/gm, "").trim();
}

function shortName(fullName: string): string {
  return fullName.split("/")[1] ?? fullName;
}

/** The `AGENTS.md` a repo created by `claws_create_repo` starts with. */
export function seedAgentsMd(input: RepoSeedInput): string {
  const name = shortName(input.fullName);
  const purpose = input.purpose ? stripHeadings(input.purpose) : "";
  const known: string[] = [];
  if (input.kind) known.push(`- Kind: ${KIND_DESCRIPTIONS[input.kind]} (\`${input.kind}\`).`);
  if (input.issue) known.push(`- Created for #${input.issue.id}: ${input.issue.title.replace(/\s+/g, " ").trim()}`);
  return [
    `# ${name}`,
    "",
    ...(input.description ? [input.description, ""] : []),
    ...(purpose || known.length > 0
      ? ["## What this repo is for", "", ...(purpose ? [purpose, ""] : []), ...(known.length > 0 ? [...known, ""] : [])]
      : []),
    "## Where this repo lives",
    "",
    `- This repository is hosted on Forgejo at ${input.url}, which owns its issues, pull requests and \`main\`.`,
    "- Never use `gh` against this repo; use the Claws MCP tools or the Forgejo API at `$CLAWS_FORGEJO_BASE_URL/api/v1`.",
    "- CI runs on Forgejo Actions from `.forgejo/workflows/`.",
    "- All changes land via pull request; never push directly to the default branch.",
    "",
    "## Issues",
    "",
    "- New issues are filed in the Claws tracker, not on the forge: agents use the `claws_create_issue` MCP tool, humans use the dashboard's New issue page. Write a native issue's id as `#clw_…`.",
    "",
    "## Policies",
    "",
    `- The observability policy is \`${OBSERVABILITY_SEED_PATH}\` and the security policy is \`${SECURITY_SEED_PATH}\`. Claws seeded both before the repo had code; the first pull request that adds code rewrites them for what the repo then ships, runs and exposes, and deletes their seed note.`,
    "",
    HOST_POLICY_MARKDOWN,
    "",
  ].join("\n");
}

/** The observability policy of a repo with no code: it emits no runtime telemetry yet. */
export function staticObservabilityPolicy(purpose?: string | null): string {
  const brief = purpose ? stripHeadings(purpose) : "";
  return [
    "# Observability",
    "",
    `> ${SEEDED_POLICY_MARKER}`,
    "",
    NO_TELEMETRY_SENTENCE,
    "",
    "The repository holds only documentation and Claws configuration, so nothing runs and nothing logs.",
    "",
    ...(brief ? [`Planned, not built yet: ${brief}`, ""] : []),
    KNOWN_GAPS_HEADING,
    "",
    "None.",
    "",
  ].join("\n");
}

/** The security policy of a repo with no code: it ships nothing, runs nowhere and exposes nothing yet. */
export function staticSecurityPolicy(kind?: RepoKind | null, purpose?: string | null): string {
  const brief = purpose ? stripHeadings(purpose) : "";
  return [
    "# Security",
    "",
    `> ${SEEDED_POLICY_MARKER}`,
    "",
    "### Scope",
    "",
    "The repository ships nothing and runs nowhere yet: it holds only documentation and Claws configuration, and nothing in it is exposed to a network.",
    ...(brief ? ["", `Planned, not built yet: ${brief}`] : []),
    "",
    "### Dependency and image vulnerabilities",
    "",
    "There is nothing to scan yet: the repository has no dependencies and publishes no container image.",
    "",
    "### Accepted findings",
    "",
    "None: with no dependencies or images there are no findings to accept, so there is no `.vex/` directory.",
    "",
    "### Secrets",
    "",
    "None: the repository uses no secrets, tokens or credentials.",
    "",
    "### Supply chain",
    "",
    "Nothing is pinned yet because the repository has no dependencies, base images or CI actions. Rules for new changes: commit the lockfile with every new dependency, and pin each new CI action to a full commit SHA.",
    "",
    "### Exposure and authentication",
    "",
    "Nothing is exposed: the repository runs no service, so it has no public or network entry point and nothing to authenticate.",
    "",
    ...(kind
      ? [`### Rules for new changes to ${KIND_DESCRIPTIONS[kind]}`, "", ...SECURITY_GUIDANCE[kind].map((g) => `- ${g}`), ""]
      : []),
    KNOWN_GAPS_HEADING,
    "",
    "None.",
    "",
  ].join("\n");
}

/** The three generic role documents the claude-config scanner looks for. */
export function staticRoleDocs(fullName: string): Record<string, string> {
  const name = shortName(fullName);
  const doc = (role: string, description: string, body: string[]): string =>
    ["---", `name: ${role}`, `description: ${description}`, "---", "", ...body, ""].join("\n");
  return {
    ".agents/issue-refiner.md": doc("issue-refiner", `Planning guidance for refining ${name} issues into concise, implementer-ready plans.`, [
      `Use this file only for planning guidance; repo facts and commands live in \`AGENTS.md\`.`,
      "",
      "Read `docs/PRODUCT.md` first, then only the relevant `docs/product/` area doc, then `docs/OVERVIEW.md`, when they exist; until they do, ground the plan in `AGENTS.md` and the issue's approved requirements.",
      "",
      "Keep plans concise and reviewable: restate the requirement, name the outcome, surface decisions early, and plan at the file/module and behaviour level.",
      "",
      `A plan that adds the repo's first code also rewrites \`${OBSERVABILITY_SEED_PATH}\` and \`${SECURITY_SEED_PATH}\` for what the repo will then ship, run and expose, and deletes their seed note.`,
    ]),
    ".agents/issue-implementer.md": doc("issue-implementer", `Implementation guidance for ${name}.`, [
      "Use this file only for implementation guidance; repo facts and commands live in `AGENTS.md`.",
      "",
      "Follow the plan. Run the repo's own checks (its package scripts, Taskfile or flake checks) before you finish, and never invent a check the repo lacks.",
      "",
      `If the change adds the repo's first code, rewrite \`${OBSERVABILITY_SEED_PATH}\` and \`${SECURITY_SEED_PATH}\` for what the repo then ships, runs and exposes, and delete their seed note, in the same pull request.`,
    ]),
    ".agents/pr-reviewer.md": doc("pr-reviewer", `Review guidance for ${name} pull requests.`, [
      "Use this file only for review guidance; repo facts and commands live in `AGENTS.md`.",
      "",
      `Check the diff against \`AGENTS.md\`, \`${OBSERVABILITY_SEED_PATH}\` and \`${SECURITY_SEED_PATH}\`. Flag a change that adds code while either policy still carries Claws' seed note, and a policy statement the code does not support.`,
    ]),
  };
}

/** A 128px square SVG: the name's first character on a colour hashed from the name. */
export function seedAvatarSvg(fullName: string): string {
  const name = shortName(fullName);
  const hue = crypto.createHash("sha256").update(name).digest().readUInt16BE(0) % 360;
  const initial = (name[0] ?? "?").toUpperCase().replace(/[^A-Z0-9]/, "?");
  return [
    '<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128">',
    `  <rect width="128" height="128" rx="24" fill="hsl(${hue}, 45%, 38%)"/>`,
    `  <text x="64" y="64" dy="0.35em" text-anchor="middle" font-family="system-ui, -apple-system, 'Segoe UI', sans-serif" font-size="64" font-weight="600" fill="#ffffff">${initial}</text>`,
    "</svg>",
    "",
  ].join("\n");
}

function seedClawsJson(description: string, issueId: string | null): string {
  const notes = `Created by Claws via claws_create_repo${issueId ? ` (#${issueId})` : ""}`;
  return `${JSON.stringify({ enabled: true, description, notes, avatar: AVATAR_SEED_PATH }, null, 2)}\n`;
}

/** `text` with the seed note after its first heading (or at the top), unless it already carries one. */
function withSeedMarker(text: string): string {
  if (text.includes(SEEDED_POLICY_MARKER)) return text;
  const lines = text.split("\n");
  const heading = lines.findIndex((l) => /^#{1,6}[ \t]/.test(l));
  const note = `> ${SEEDED_POLICY_MARKER}`;
  if (heading < 0) return [note, "", ...lines].join("\n");
  return [...lines.slice(0, heading + 1), "", note, ...lines.slice(heading + 1)].join("\n");
}

function owningPath(scanner: string): string | null {
  if (scanner === "observability-contract-scanner") return OBSERVABILITY_SEED_PATH;
  if (scanner === "security-contract-scanner") return SECURITY_SEED_PATH;
  if (scanner === "host-policy-scanner") return "AGENTS.md";
  return null;
}

function readFileOr(root: string, rel: string): string | null {
  try {
    return fs.readFileSync(path.join(root, rel), "utf-8");
  } catch {
    return null;
  }
}

/**
 * Every reason a repo holding exactly `files` would get an issue or a
 * follow-up from the baseline checks: each `BASELINE_SCANNER_SPECS` scan, the
 * observability (no infra clones) and security drift rules, and the
 * `claws.json` avatar. Empty when the tree passes. Runs in a temp dir that is
 * removed afterwards.
 */
export function validateSeedTree(files: Readonly<Record<string, string>>, fullName = "org/new-repo"): SeedProblem[] {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claws-repo-seed-"));
  try {
    for (const [rel, content] of Object.entries(files)) {
      const abs = path.join(dir, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content);
    }
    const [owner = "org", name = "new-repo"] = fullName.split("/");
    const repo: Repo = { owner, name, fullName, defaultBranch: "main" };
    const problems: SeedProblem[] = [];

    for (const spec of BASELINE_SCANNER_SPECS) {
      if (spec.scan(dir, repo) === null) continue;
      let detail = "";
      if (spec.name === "observability-contract-scanner") {
        const text = readFileOr(dir, OBSERVABILITY_SEED_PATH);
        if (text !== null) detail = missingObservabilityRules(text, { wholeDocument: true }).map((r) => r.id).join(", ");
      } else if (spec.name === "security-contract-scanner") {
        const text = readFileOr(dir, SECURITY_SEED_PATH);
        if (text !== null) detail = missingSecurityRules(text, { wholeDocument: true }).map((r) => r.id).join(", ");
      }
      problems.push({
        path: owningPath(spec.name),
        reason: `${spec.name} would file "${spec.issueTitle}"${detail ? ` (rules not met: ${detail})` : ""}`,
      });
    }

    const observability = readObservabilityPolicy(dir);
    if (observability) {
      const drift = detectObservabilityDrift(dir, observability.text, null);
      for (const f of drift.findings) problems.push({ path: observability.path, reason: `${f.rule}: ${f.message}` });
      for (const u of drift.unavailable) problems.push({ path: observability.path, reason: `${u.rule} could not run: ${u.reason}` });
    }
    const security = readSecurityPolicy(dir);
    if (security) {
      const drift = detectSecurityDrift(dir, security.text);
      for (const f of drift.findings) problems.push({ path: security.path, reason: `${f.rule}: ${f.message}` });
    }

    let avatar: unknown;
    try {
      avatar = (JSON.parse(files["claws.json"] ?? "") as { avatar?: unknown }).avatar;
    } catch {
      avatar = undefined;
    }
    if (typeof avatar !== "string" || !/\.(png|jpe?g|gif|webp|svg)$/i.test(avatar) || !(avatar in files)) {
      problems.push({ path: AVATAR_SEED_PATH, reason: "claws.json declares no avatar file the seed commits" });
    }
    return problems;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * The seed commit's files for a new repo, plus the files whose caller-supplied
 * or purpose-specific content failed validation and was replaced. Each policy
 * doc tries, in order, the caller's file (with the seed note inserted), the
 * static text with the purpose, and the static text without it; a caller role
 * document is used unless it is empty or over `MAX_SEED_FILE_BYTES`.
 */
export function buildRepoSeed(input: RepoSeedInput): RepoSeed {
  const caller = input.files ?? {};
  const fallbacks: SeedFallback[] = [];
  const files: Record<string, string> = {
    "claws.json": seedClawsJson(input.description, input.issue?.id ?? null),
    "AGENTS.md": seedAgentsMd(input),
    [OBSERVABILITY_SEED_PATH]: staticObservabilityPolicy(),
    [SECURITY_SEED_PATH]: staticSecurityPolicy(input.kind),
    ...staticRoleDocs(input.fullName),
    [AVATAR_SEED_PATH]: seedAvatarSvg(input.fullName),
  };

  for (const rolePath of ROLE_SEED_PATHS) {
    const text = caller[rolePath];
    if (text === undefined) continue;
    if (text.trim() === "") fallbacks.push({ path: rolePath, reasons: ["file is empty"] });
    else if (Buffer.byteLength(text, "utf8") > MAX_SEED_FILE_BYTES) fallbacks.push({ path: rolePath, reasons: [`file is over ${MAX_SEED_FILE_BYTES} bytes`] });
    else files[rolePath] = text;
  }

  const policies: { path: string; withPurpose: string | null; caller: string | undefined }[] = [
    {
      path: OBSERVABILITY_SEED_PATH,
      withPurpose: input.purpose ? staticObservabilityPolicy(input.purpose) : null,
      caller: caller[OBSERVABILITY_SEED_PATH],
    },
    {
      path: SECURITY_SEED_PATH,
      withPurpose: input.purpose ? staticSecurityPolicy(input.kind, input.purpose) : null,
      caller: caller[SECURITY_SEED_PATH],
    },
  ];
  for (const policy of policies) {
    const reasons: string[] = [];
    const candidates: string[] = [];
    if (policy.caller !== undefined) {
      if (Buffer.byteLength(policy.caller, "utf8") > MAX_SEED_FILE_BYTES) reasons.push(`file is over ${MAX_SEED_FILE_BYTES} bytes`);
      else if (policy.caller.trim() === "") reasons.push("file is empty");
      else candidates.push(withSeedMarker(policy.caller));
    }
    if (policy.withPurpose !== null) candidates.push(policy.withPurpose);
    for (const candidate of candidates) {
      const problems = validateSeedTree({ ...files, [policy.path]: candidate }, input.fullName);
      if (problems.length === 0) {
        files[policy.path] = candidate;
        break;
      }
      reasons.push(...problems.map((p) => p.reason));
    }
    if (reasons.length > 0) fallbacks.push({ path: policy.path, reasons: [...new Set(reasons)] });
  }

  // The purpose brief also lands in AGENTS.md; drop it there if the tree fails because of it.
  if (input.purpose) {
    const problems = validateSeedTree(files, input.fullName);
    if (problems.length > 0) {
      files["AGENTS.md"] = seedAgentsMd({ ...input, purpose: null });
      fallbacks.push({ path: "AGENTS.md", reasons: [...new Set(problems.map((p) => p.reason))] });
    }
  }

  return { files, fallbacks };
}
