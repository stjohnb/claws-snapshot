/**
 * Canonical security contract every St-John-Software repo declares: what it
 * ships and runs, how dependency and image vulnerabilities are found, where
 * accepted findings live (OpenVEX statements under `.vex/`), how secrets reach
 * the code, how the supply chain is pinned, what is exposed and how it
 * authenticates, and the Known gaps where existing code falls short. A repo
 * that publishes a container image scans it before every push and blocks the
 * push on a fixable High/Critical finding not covered by a `.vex/` statement.
 *
 * This module is the single source of truth for the starter template
 * (`SECURITY_CONTRACT_MARKDOWN`, verbatim in `docs/security-contract.md`), the
 * fallback prompt block (`SECURITY_CONTEXT`), the verification paragraph, the
 * compliance rules, the OpenVEX checks `scripts/ci/image-scan.sh` mirrors in
 * jq, and the per-repo-kind guidance. Compliance is judged on the policy text
 * alone; `detectRepoKind` only picks which guidance to show.
 *
 * Leaf module: imports only the Known gaps grammar from
 * `observability-contract.ts`, so both policies parse gaps identically.
 */

import fs from "node:fs";
import path from "node:path";
import { ACCEPTED_GAP_PREFIX, KNOWN_GAPS_HEADING, parseKnownGaps } from "./observability-contract.js";

export const SECURITY_CONTRACT_HEADING = "## Security";

/** Prefix of every fill-in line in `SECURITY_CONTRACT_MARKDOWN`; the policy fails while any remains. */
export const SECURITY_PLACEHOLDER = "TODO(security):";

export interface SecurityDocPath {
  path: string;
  /** The whole file is the policy, so no `## Security` heading is needed. */
  wholeDocument?: boolean;
}

/** Accepted policy locations, in priority order. */
export const SECURITY_DOC_PATHS: readonly SecurityDocPath[] = [
  { path: "docs/security.md", wholeDocument: true },
  { path: "AGENTS.md" },
];

/** Starter template a repo pastes into `docs/security.md` or `AGENTS.md`. */
export const SECURITY_CONTRACT_MARKDOWN = `${SECURITY_CONTRACT_HEADING}

This is the repo's security policy under the St-John-Software security contract.
Replace each placeholder line below with this repo's answer, or with \`does not apply\` and the
reason. Every statement below must be true of this repo's code and config today; word a rule
for future changes as a rule for new changes, and list each place existing code falls short
under Known gaps.

### Scope

${SECURITY_PLACEHOLDER} what this repo ships and runs (container image, static site, library, CLI, firmware, config), where it runs, and what of it is exposed to a network.

### Dependency and image vulnerabilities

${SECURITY_PLACEHOLDER} how dependency vulnerabilities are found (Renovate, \`npm audit\`, trivy, grype). A repo that publishes a container image scans the built image before every push and fails the push on a fixable High or Critical finding not covered by a \`.vex/\` statement: name the workflow and script that do it. A repo that publishes no container image says so here.

### Accepted findings

${SECURITY_PLACEHOLDER} where accepted findings live: one OpenVEX \`not_affected\` statement per advisory under \`.vex/\`, with a justification and an impact statement; or \`none\` and why.

### Secrets

${SECURITY_PLACEHOLDER} which secrets, tokens and credentials the code uses, where they are stored, and how they reach it at runtime.

### Supply chain

${SECURITY_PLACEHOLDER} how dependencies, base images and CI actions are pinned (lockfile, digest, commit SHA) and how they are kept fresh (Renovate).

### Exposure and authentication

${SECURITY_PLACEHOLDER} what is reachable from the public internet or the network and how each entry point authenticates; name the ingress and network policy in fleet-infra or production-infra.

${KNOWN_GAPS_HEADING}

${SECURITY_PLACEHOLDER} list every place existing code falls short of the contract or of this policy, one list item each, or write \`None.\`; start an accepted gap's item with \`${ACCEPTED_GAP_PREFIX} <reason>\`.`;

/**
 * The paragraph every `<security>` prompt block carries: a policy's
 * current-behaviour claims are checked against the repo, not taken on trust.
 */
export const SECURITY_POLICY_VERIFICATION_CONTEXT = `When this task declares, rewrites or reviews the repo's security policy, verify every statement about current behaviour against this repo: its workflows, Dockerfiles, lockfiles, \`.vex/\` statements and Renovate config, and its ingress and network policy in fleet-infra or production-infra read over the Forgejo API; correct any claim the repo does not support before merge. Word rules for future changes as rules for new changes, never as current behaviour. Keep a \`${KNOWN_GAPS_HEADING}\` section listing every place existing code falls short of the contract or of the policy, one list item each, or \`None.\`; start an accepted gap's item with \`${ACCEPTED_GAP_PREFIX} <reason>\`. A review flags an unsupported claim and a missing Known gaps section.`;

/**
 * Fallback prompt block for planning, implementing and reviewing agents, used
 * only when the target repo declares no security policy.
 */
export const SECURITY_CONTEXT = `<security>
This repo declares no security policy, so for any change: never commit secrets, tokens or credentials; pin a new dependency through the lockfile and a new CI action to a full commit SHA. A workflow that pushes a container image scans the built image before the push (trivy with \`--severity HIGH,CRITICAL --ignore-unfixed --exit-code 1\`) and fails the push until each finding is fixed or covered by a \`.vex/\` OpenVEX \`not_affected\` statement with a justification and an impact statement; never add an \`exceptions.yaml\` entry in fleet-infra or production-infra for a first-party image. Say in the PR that the repo has no security policy.
${SECURITY_POLICY_VERIFICATION_CONTEXT}
</security>`;

export interface SecurityRule {
  id: string;
  label: string;
  /** Heading text that names this rule's subsection. Null for whole-policy rules. */
  heading: RegExp | null;
  /** Text the subsection body must mention (or, with `failsWhenPresent`, must not). */
  detect: RegExp;
  /** When true the rule fails while `detect` matches the whole policy. */
  failsWhenPresent?: boolean;
}

export const SECURITY_RULES: readonly SecurityRule[] = [
  {
    id: "scope",
    label: "Scope: what the repo ships and runs, and what is exposed",
    heading: /\bscope\b/i,
    detect: /\b(ships?|shipped|runs?|exposed)\b/i,
  },
  {
    id: "vulnerabilities",
    label: "Dependency and image vulnerabilities: how they are found, and a scan before every image push that blocks on fixable High/Critical findings not covered by `.vex/` (or no container image)",
    heading: /\bvulnerabilit/i,
    detect: /\b(scan\w*|audit\w*|trivy|grype|renovate)\b|\bno container image\b/i,
  },
  {
    id: "accepted-findings",
    label: "Accepted findings: OpenVEX `not_affected` statements under `.vex/`, or none and why",
    heading: /\baccepted findings\b|\bvex\b/i,
    detect: /\.vex\b|openvex|not_affected/i,
  },
  {
    id: "secrets",
    label: "Secrets: which secrets, tokens and credentials, and how they reach the code",
    heading: /\bsecrets?\b|\bcredentials?\b/i,
    detect: /secret|token|credential/i,
  },
  {
    id: "supply-chain",
    label: "Supply chain: how dependencies, images and actions are pinned and kept fresh",
    heading: /\bsupply[- ]chain\b/i,
    detect: /\bpin(s|ned|ning)?\b|\block ?files?\b|renovate/i,
  },
  {
    id: "exposure",
    label: "Exposure and authentication: what is reachable and how it authenticates",
    heading: /\bexposure\b|\bauthenticat/i,
    detect: /\bpublic\b|\bauth\w*|\bnetwork\b/i,
  },
  {
    id: "known-gaps",
    label: "Known gaps: where existing code falls short, or None.",
    heading: /\bknown gaps\b/i,
    detect: /^\s*[*_>-]*\s*none\b/i,
  },
  {
    id: "no-placeholders",
    label: "No `TODO(security)` placeholder lines left from the starter template",
    heading: null,
    detect: /TODO\(security\)/,
    failsWhenPresent: true,
  },
];

// A "does not apply" answer: the body opens with one of these phrases (after an
// optional list marker or emphasis), then a reason of at least three words.
const NOT_APPLICABLE = /^[\s>*_+-]*(none|not applicable|does not apply|n\/a)\b[*_]*/i;
const SECURITY_HEADING_TEXT = /\bsecurity\b/i;
const ANY_HEADING = /^(#{1,6})[ \t]+(.*)$/;
const FENCE = /^[ \t]{0,3}(`{3,}|~{3,})/;

/** Per-line flag: true when the line is inside (or delimits) a fenced code block. */
function fencedLines(lines: readonly string[]): boolean[] {
  const fenced: boolean[] = [];
  let open: string | null = null;
  for (const line of lines) {
    const match = line.match(FENCE);
    if (open === null) {
      fenced.push(Boolean(match));
      if (match) open = match[1]!;
    } else {
      fenced.push(true);
      if (match && match[1]![0] === open[0] && match[1]!.length >= open.length && line.trim() === match[1]) open = null;
    }
  }
  return fenced;
}

interface Subsection {
  /** Heading line plus body. */
  text: string;
  heading: string;
  body: string;
}

/**
 * Every heading-bounded block of `text` (from a heading, outside fenced code,
 * up to the next same-or-higher heading) whose heading text matches `heading`.
 * `skipFirstLine` drops the enclosing section's own heading.
 */
function headedBlocks(text: string, heading: RegExp, skipFirstLine = false): Subsection[] {
  const lines = text.split("\n");
  const fenced = fencedLines(lines);
  const blocks: Subsection[] = [];
  for (let start = skipFirstLine ? 1 : 0; start < lines.length; start++) {
    if (fenced[start]) continue;
    const match = lines[start]!.match(ANY_HEADING);
    if (!match || match[1]!.length < 2 || !heading.test(match[2]!)) continue;
    const level = match[1]!.length;
    let end = lines.length;
    for (let i = start + 1; i < lines.length; i++) {
      if (fenced[i]) continue;
      const next = lines[i]!.match(ANY_HEADING);
      if (next && next[1]!.length <= level) {
        end = i;
        break;
      }
    }
    blocks.push({
      text: lines.slice(start, end).join("\n"),
      heading: match[2]!,
      body: lines.slice(start + 1, end).join("\n").trim(),
    });
  }
  return blocks;
}

/**
 * True when `body` opens with a "does not apply" phrase (after optional list
 * marker or emphasis) and follows it with a reason of at least three words.
 */
function reasonedNotApplicable(body: string): boolean {
  const match = body.match(NOT_APPLICABLE);
  if (!match) return false;
  const words = body.slice(match[0].length).match(/[A-Za-z0-9]{2,}/g) ?? [];
  return words.length >= 3;
}

/** Any character but a newline or a full stop, or a dot inside a token (`image-scan.sh`, `registry.home.x`). */
const SPAN = String.raw`(?:[^\n.]|\.(?=\S))`;
const IMAGE_PUBLISH = new RegExp(
  String.raw`\b(publish(es|ed|ing)?|push(es|ed|ing)?|ships?)\b${SPAN}*?\b(container |docker |oci )?images?\b` +
    String.raw`|\b(publish(es|ed|ing)?|push(es|ed|ing)?|ships?)\s+(\S+\s+){0,2}?\bcontainers?\b|\b(publish(es|ed|ing)?|push(es|ed|ing)?|ships?)\b[^\n.,;:]*?registry\.(home\.)?bstjohn\.net` +
    String.raw`|\bimages?\s+(is|are|was|were|gets?|got)\s+(\w+\s+){0,2}?(published|pushed|shipped)\b`,
  "gi",
);
const NEGATION = /\b(no|not|never|none|nothing|without)\b|n't\b/i;

/**
 * The image-publish statements in `text`: each line and sentence pairing
 * publish/push/ship with "image". A statement is negated when a negation word
 * sits inside it ("publishes no container image", "the image is not pushed")
 * or within the three words before it in the same clause ("does not
 * publish", "Nothing here pushes"); a negation elsewhere in the sentence or
 * an earlier list item does not count.
 */
function imagePublishStatements(text: string): { claims: boolean; denies: boolean } {
  let claims = false;
  let denies = false;
  for (const unit of text.split(/(?<=[.!?])\s+|\n/)) {
    for (const match of unit.matchAll(IMAGE_PUBLISH)) {
      const clause = unit.slice(0, match.index).split(/[,;:()\u2014]/).pop() ?? "";
      const lead = clause.trim().split(/\s+/).slice(-3).join(" ");
      if (NEGATION.test(match[0]) || NEGATION.test(lead)) denies = true;
      else claims = true;
    }
  }
  return { claims, denies };
}

/**
 * True when `text` claims the repo publishes (pushes) a container image: a
 * line or sentence pairing publish/push/ship with "image" with no negation in
 * or right before the claim ("publishes no container image" is not a claim).
 */
export function policyClaimsImagePublish(text: string): boolean {
  return imagePublishStatements(text).claims;
}

const SCAN_BEFORE_PUSH = new RegExp(
  String.raw`\bscan\w*\b${SPAN}*\bbefore\b${SPAN}*\bpush|\bbefore\b${SPAN}*\bpush\w*\b${SPAN}*\bscan`,
  "i",
);
const HIGH_CRITICAL = /\bhigh\b[^\n]*\bcritical\b|\bcritical\b[^\n]*\bhigh\b/i;
const VEX_MENTION = /\.vex\b/i;

/** The image gate wording a vulnerabilities subsection needs once it claims an image push. */
function imageGateStated(body: string): boolean {
  return SCAN_BEFORE_PUSH.test(body) && HIGH_CRITICAL.test(body) && VEX_MENTION.test(body);
}

/** True when `text` only denies an image push and never claims one. */
function denialOnly(text: string): boolean {
  const { claims, denies } = imagePublishStatements(text);
  return denies && !claims;
}

/**
 * A policy that claims an image push anywhere needs the gate wording in its
 * vulnerabilities subsection, unless that subsection itself says the repo
 * publishes no container image.
 */
function subsectionPasses(rule: SecurityRule, sub: Subsection, policy: string): boolean {
  if (sub.body === "" || sub.body.includes(SECURITY_PLACEHOLDER)) return false;
  if (rule.id === "known-gaps") {
    const gaps = parseKnownGaps(sub.text);
    return gaps !== null && (gaps.length > 0 || rule.detect.test(sub.body));
  }
  if (
    rule.id === "vulnerabilities" &&
    policyClaimsImagePublish(policy) &&
    !imageGateStated(sub.body) &&
    !denialOnly(sub.body)
  ) {
    return false;
  }
  return rule.detect.test(sub.body) || reasonedNotApplicable(sub.body);
}

function ruleHolds(rule: SecurityRule, policy: string, skipFirstLine: boolean): boolean {
  if (rule.heading === null) {
    const hit = rule.detect.test(policy);
    return rule.failsWhenPresent ? !hit : hit;
  }
  return headedBlocks(policy, rule.heading, skipFirstLine).some((sub) => subsectionPasses(rule, sub, policy));
}

function rulesMissingFrom(policy: string, skipFirstLine: boolean): readonly SecurityRule[] {
  return SECURITY_RULES.filter((r) => !ruleHolds(r, policy, skipFirstLine));
}

/**
 * The security policy section of an `AGENTS.md`-shaped document: from a level
 * 2–6 heading naming security up to the next same-or-higher heading. Headings
 * inside fenced code are ignored; when several match, the one missing the
 * fewest rules wins, first on ties. Null when none matches.
 */
export function findSecuritySection(text: string): string | null {
  let best: { section: string; missing: number } | null = null;
  for (const block of headedBlocks(text, SECURITY_HEADING_TEXT)) {
    const missing = rulesMissingFrom(block.text, true).length;
    if (best === null || missing < best.missing) best = { section: block.text, missing };
  }
  return best?.section ?? null;
}

/**
 * Rules from SECURITY_RULES the document's policy does not meet. With
 * `wholeDocument` the whole text is the policy; otherwise it is the best
 * security section, and a document with none misses every rule. Each
 * subsection rule passes when its subsection is present, non-empty, has no
 * placeholder, and matches its keyword or says it does not apply with a
 * reason; Known gaps needs list items or `None.`.
 */
export function missingSecurityRules(
  text: string,
  opts: { wholeDocument?: boolean } = {},
): readonly SecurityRule[] {
  if (opts.wholeDocument) return rulesMissingFrom(text, false);
  const section = findSecuritySection(text);
  if (section === null) return SECURITY_RULES;
  return rulesMissingFrom(section, true);
}

/** The five OpenVEX justifications a `not_affected` statement may carry. */
export const VEX_JUSTIFICATIONS: readonly string[] = [
  "component_not_present",
  "vulnerable_code_not_present",
  "vulnerable_code_not_in_execute_path",
  "vulnerable_code_cannot_be_controlled_by_adversary",
  "inline_mitigations_already_exist",
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

/** An OpenVEX product names itself by a non-empty `@id` or a non-empty `identifiers` map (e.g. `purl`). */
function identifiedProduct(p: unknown): boolean {
  if (!isRecord(p)) return false;
  if (nonEmptyString(p["@id"])) return true;
  return isRecord(p.identifiers) && Object.values(p.identifiers).some(nonEmptyString);
}

/**
 * Errors in one `.vex/*.json` OpenVEX document; empty when it is valid.
 * Every statement must name its vulnerability and at least one product, be
 * `not_affected`, carry one of the five OpenVEX justifications and a
 * non-empty `impact_statement`. `scripts/ci/image-scan.sh` runs the same
 * checks in jq before the scan, with the same messages.
 */
export function validateVexDocument(json: unknown): string[] {
  if (!isRecord(json)) return ["document is not a JSON object"];
  const errors: string[] = [];
  if (typeof json["@context"] !== "string" || !json["@context"].startsWith("https://openvex.dev/ns")) {
    errors.push("@context is not an OpenVEX context (https://openvex.dev/ns/...)");
  }
  const statements = json.statements;
  if (!Array.isArray(statements) || statements.length === 0) {
    errors.push("statements is missing or empty");
    return errors;
  }
  statements.forEach((s: unknown, i) => {
    const at = `statements[${i}]`;
    if (!isRecord(s)) {
      errors.push(`${at} is not an object`);
      return;
    }
    const vuln = s.vulnerability;
    if (!isRecord(vuln) || !nonEmptyString(vuln.name)) errors.push(`${at}.vulnerability.name is missing`);
    const products = s.products;
    if (!Array.isArray(products) || products.length === 0 || !products.every(identifiedProduct)) {
      errors.push(`${at}.products is missing, empty, or has a product without @id or identifiers`);
    }
    if (s.status !== "not_affected") {
      errors.push(`${at}.status is ${JSON.stringify(s.status ?? null)}; only "not_affected" is allowed`);
    }
    if (typeof s.justification !== "string" || !VEX_JUSTIFICATIONS.includes(s.justification)) {
      errors.push(`${at}.justification is missing or not one of the five OpenVEX justifications`);
    }
    if (!nonEmptyString(s.impact_statement)) errors.push(`${at}.impact_statement is missing or empty`);
  });
  return errors;
}

export type RepoKind =
  | "container-service"
  | "infra"
  | "static-site"
  | "cli-or-library"
  | "firmware-or-hardware"
  | "config-only";

/** 3–5 bullets of guidance per repo kind, shown when a repo has no policy yet. Never decides compliance. */
export const SECURITY_GUIDANCE: Readonly<Record<RepoKind, readonly string[]>> = {
  "container-service": [
    "Scan the built image before every push (copy Claws' `scripts/ci/image-scan.sh`) and fail the push on a fixable High or Critical finding.",
    "Fix a finding by a bump first; record one that truly does not apply as an OpenVEX `not_affected` statement under `.vex/`, with a justification and an honest impact statement.",
    "Keep the base image fresh: pin it by tag (or digest) and let Renovate bump it.",
    "Never ask fleet-infra or production-infra for an `exceptions.yaml` entry for this image; its accepted findings live in this repo's `.vex/`.",
  ],
  infra: [
    "`exceptions.yaml` holds only exposure and risk decisions for third-party images; a first-party image's findings belong in its source repo's `.vex/`.",
    "Scan the images this repo deploys, and its infrastructure-as-code (Kubernetes manifests, OpenTofu), for misconfigurations.",
    "Describe what the ingress and network policies expose to the public internet and how each entry point authenticates.",
    "Keep secrets encrypted at rest (SOPS or sealed secrets), never in plain text.",
  ],
  "static-site": [
    "Run `npm audit` (or the ecosystem's equivalent) and let Renovate keep dependencies fresh.",
    "State the Content-Security-Policy and security headers the site is served with.",
    "Ship no secrets in the client bundle: anything built into it is public.",
    "Commit the lockfile so builds are reproducible.",
  ],
  "cli-or-library": [
    "Audit dependencies (`npm audit`, `govulncheck`, `cargo audit`) and let Renovate keep them fresh.",
    "Commit the lockfile so builds are reproducible.",
    "If it publishes no container image, say so in the vulnerabilities subsection; the image gate does not apply.",
  ],
  "firmware-or-hardware": [
    "Secrets and supply chain apply: keep Wi-Fi passwords, API keys and OTA passwords out of the repo (e.g. a secrets file that is not committed).",
    "Pin toolchains, libraries and components, and say how they are kept fresh.",
    "The image gate does not apply when no container image is published; say so in the vulnerabilities subsection.",
  ],
  "config-only": [
    "Secrets and supply chain apply: no credentials in plain text, and pinned versions for anything the config pulls in.",
    "The image gate does not apply when no container image is published; say so in the vulnerabilities subsection.",
    "Say what, if anything, this config exposes to a network.",
  ],
};

const SKIP_DIRS = new Set([".git", "node_modules", "vendor", "dist", "build"]);

interface RepoFiles {
  /** Names of files at the root. */
  rootFiles: string[];
  /** Names of directories at the root. */
  rootDirs: string[];
  /** Repo-relative paths of files at the root and one level down. */
  shallowFiles: string[];
}

function listShallow(repoDir: string): RepoFiles {
  const rootFiles: string[] = [];
  const rootDirs: string[] = [];
  const shallowFiles: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(repoDir, { withFileTypes: true });
  } catch {
    return { rootFiles, rootDirs, shallowFiles };
  }
  for (const entry of entries) {
    if (entry.isFile()) {
      rootFiles.push(entry.name);
      shallowFiles.push(entry.name);
    } else if (entry.isDirectory()) {
      rootDirs.push(entry.name);
      if (SKIP_DIRS.has(entry.name)) continue;
      try {
        for (const child of fs.readdirSync(path.join(repoDir, entry.name), { withFileTypes: true })) {
          if (child.isFile()) shallowFiles.push(`${entry.name}/${child.name}`);
        }
      } catch {
        // Unreadable directory: skip it.
      }
    }
  }
  return { rootFiles, rootDirs, shallowFiles };
}

function readSmall(file: string, max = 256 * 1024): string | null {
  try {
    if (fs.statSync(file).size > max) return null;
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

const base = (p: string): string => p.slice(p.lastIndexOf("/") + 1);

/**
 * The repo's kind from file signals alone (never its workflows), first match
 * wins: a Dockerfile or Containerfile at the root or one level down; infra
 * (kustomization.yaml, `clusters/`, `tofu/`, `*.tf`); a static site (astro,
 * vite or next config); a CLI or library (`package.json` `bin`, `go.mod`,
 * `Cargo.toml`); firmware or hardware (`*.kicad_pro`, `*.scad`,
 * `platformio.ini`, ESPHome YAML); otherwise config-only. Used only to choose
 * `SECURITY_GUIDANCE`, never to decide compliance.
 */
export function detectRepoKind(repoDir: string): RepoKind {
  const { rootFiles, rootDirs, shallowFiles } = listShallow(repoDir);
  const names = shallowFiles.map(base);

  if (names.some((n) => /^(Dockerfile|Containerfile)(\.(?!(md|txt)$)[\w.-]+)?$/.test(n))) return "container-service";

  if (
    names.includes("kustomization.yaml") ||
    rootDirs.includes("clusters") ||
    rootDirs.includes("tofu") ||
    names.some((n) => n.endsWith(".tf"))
  ) {
    return "infra";
  }

  if (names.some((n) => /^(astro|vite|next)\.config\.(m?[jt]s|c[jt]s)$/.test(n))) return "static-site";

  if (rootFiles.includes("package.json")) {
    const pkg = readSmall(path.join(repoDir, "package.json"));
    try {
      const parsed: unknown = pkg === null ? null : JSON.parse(pkg);
      if (isRecord(parsed) && parsed.bin !== undefined) return "cli-or-library";
    } catch {
      // Malformed package.json: no bin signal.
    }
  }
  if (rootFiles.includes("go.mod") || rootFiles.includes("Cargo.toml")) return "cli-or-library";

  if (names.some((n) => n.endsWith(".kicad_pro") || n.endsWith(".scad") || n === "platformio.ini")) {
    return "firmware-or-hardware";
  }
  const esphome = shallowFiles.some((f) => {
    if (!/\.ya?ml$/.test(f)) return false;
    const text = readSmall(path.join(repoDir, f));
    return text !== null && /^esphome:/m.test(text);
  });
  if (esphome) return "firmware-or-hardware";

  return "config-only";
}
