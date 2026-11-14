/**
 * Deterministic observability drift rules: each checks one kind of claim a
 * repo's observability policy makes against its code and config, and against
 * the fleet-infra and production-infra monitoring files. A rule fires only on
 * a claim the policy makes, and one that cannot read a dependency (an infra
 * clone) returns `unavailable` instead of concluding anything.
 */
import fs from "node:fs";
import path from "node:path";
import {
  exceptionProblemFindings,
  runDriftRules,
  suppressFindings,
  type DriftFinding,
  type DriftRule,
  type DriftRunResult,
} from "./contract-drift.js";
import { findConsoleCalls, isService, packageDeps, readPackageJson, serviceSignals, TEST_FILE } from "./observability-evidence.js";
import { LOGGING_RULES, NO_TELEMETRY_SENTENCE, OBSERVABILITY_RULES, parseKnownGaps } from "./observability-contract.js";
import { walkRepoTree } from "./jobs/scanner-runner.js";
import { readContractExceptions, type ContractException } from "./contract-exceptions.js";

/** Local clone dirs of the infra repos; a null entry means that clone is absent. */
export interface InfraClones {
  fleetInfra: string | null;
  productionInfra: string | null;
}

export interface ObservabilityDriftContext {
  repoDir: string;
  /** The policy text: the whole `docs/observability.md`, or the policy section of another doc. */
  policy: string;
  /** Null when neither infra clone is available. */
  infra: InfraClones | null;
  /** Clone dir (or null when absent) per lowercase short managed-repo name, for `<repo>:path` claims. */
  repoClones?: ReadonlyMap<string, string | null>;
}

/** Where a policy path token resolves when it is not repo-local. */
export const FLEET_INFRA_PREFIX = "apps/monitoring/";
export const PRODUCTION_INFRA_PREFIX = "infrastructure/prod/observability/";

/** Directory basenames whose `console.*` calls are not service code. */
export const CONSOLE_EXEMPT_DIRS = ["tools", "scripts", "resources", "public", "static", "client", "browser", "vendor"];

const CONSOLE_MAX_DEPTH = 8;
const CONSOLE_MAX_FILES = 5000;
const CONFIG_MAX_DEPTH = 6;
const CONFIG_MAX_FILES = 2000;
const INFRA_MAX_DEPTH = 6;
const MAX_FILE_BYTES = 2 * 1024 * 1024;

const FENCE = /^[ \t]{0,3}(`{3,}|~{3,})/;
const INLINE_CODE = /`([^`\n]+)`/g;
const PATH_TOKEN = /^[\w.@~-]+(?:\/[\w.@~-]+)+$/;
const HAS_EXTENSION = /\.[A-Za-z0-9]{1,8}$/;
const LOGGER_MODULE = /(?:^|\/)log(?:ger|ging)?(?:[-_.][\w-]+)?\.[cm]?[jt]sx?$/;
const UID_REF = /\buid\s+`([^`\s<>{}*]+)`/gi;
// `(?=(`?))\1` consumes the name's closing backtick atomically, so it is never read as the value's opening quote.
const LABEL_REF = /\bclaws_(?:service|alertname)(?=(`?))\1\s*(?:label\s*)?(?:[:=,]|\bis\b|\bset to\b)?\s*["'`]([^"'`\n<>{}*]+)["'`]/gi;
const LABEL_TOKEN = /^claws_(?:service|alertname)\s*[:=]\s*["']?([^"'\s<>{}*]+)["']?$/;
const DROPPING_LEVEL = "(warn|warning|error|fatal)";
const LOG_LEVEL_ASSIGN = new RegExp(`\\bLOG_LEVEL\\b["']?\\s*[:=]\\s*["']?${DROPPING_LEVEL}\\b`, "i");
const LOG_LEVEL_ENV_NAME = /\bname\s*:\s*["']?LOG_LEVEL["']?\s*$/;
const ENV_VALUE = new RegExp(`^\\s*value\\s*:\\s*["']?${DROPPING_LEVEL}\\b`, "i");
const LOG_KEY_LEVEL = new RegExp(`["']?(?:log[_-]?level|logLevel)["']?\\s*[:=]\\s*["']?${DROPPING_LEVEL}\\b`, "i");
const BARE_LEVEL = new RegExp(`^\\s*["']?level["']?\\s*[:=]\\s*["']?${DROPPING_LEVEL}["']?\\s*,?\\s*$`, "i");
const LOG_CONTEXT = /\blog(?:s|ger|ging)?\b/i;
const CONFIG_EXTENSIONS = new Set([".yaml", ".yml", ".json", ".toml", ".env", ".ini", ".conf", ".properties"]);
const CONFIG_SKIP_DIRS = ["docs", "doc", "__tests__", "tests", "test", "fixtures", "e2e", "examples"];
const CONFIG_SKIP_FILES = new Set(["package-lock.json", "npm-shrinkwrap.json", "composer.lock"]);

const JSON_STDOUT_RULE = LOGGING_RULES.find((r) => r.id === "json-stdout")!;
const INFO_SHIPPING_RULE = OBSERVABILITY_RULES.find((r) => r.id === "info-shipping")!;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
const NO_TELEMETRY_LINE = new RegExp(`^[ \\t]*${escapeRegExp(NO_TELEMETRY_SENTENCE)}[ \\t]*$`, "m");

/** The policy without fenced code blocks, so example code never counts as a claim. */
function unfenced(policy: string): string {
  const out: string[] = [];
  let open: string | null = null;
  for (const line of policy.split("\n")) {
    const match = line.match(FENCE);
    if (open === null) {
      if (match) open = match[1]!;
      else out.push(line);
    } else if (match && match[1]![0] === open[0] && match[1]!.length >= open.length && line.trim() === match[1]) {
      open = null;
    }
  }
  return out.join("\n");
}

function inlineCode(policy: string): string[] {
  return [...unfenced(policy).matchAll(INLINE_CODE)].map((m) => m[1]!.trim());
}

/**
 * Backticked tokens that look like file paths: a `/`, an extension, no
 * whitespace, placeholder or glob characters, not absolute and not a URL.
 * Deduplicated, in order of first appearance. `named-path-missing` uses the
 * wider `namedPathClaims` extractor (directories and globs too).
 */
export function policyPathTokens(policy: string): string[] {
  const seen = new Set<string>();
  for (const raw of inlineCode(policy)) {
    const token = raw.replace(/^\.\//, "");
    if (!PATH_TOKEN.test(token) || !HAS_EXTENSION.test(token)) continue;
    if (token.split("/").some((seg) => seg === "" || seg === "..")) continue;
    seen.add(token);
  }
  return [...seen];
}

function isNoTelemetry(policy: string): boolean {
  return NO_TELEMETRY_LINE.test(policy);
}

const noTelemetryService: DriftRule<ObservabilityDriftContext> = {
  id: "no-telemetry-service",
  check({ repoDir, policy }) {
    if (!isNoTelemetry(policy)) return [];
    const pkg = readPackageJson(repoDir);
    const deps = packageDeps(pkg);
    if (!isService(repoDir, pkg, deps)) return [];
    const file = fs.existsSync(path.join(repoDir, "Dockerfile")) ? "Dockerfile" : "package.json";
    return [
      {
        rule: "no-telemetry-service",
        key: file,
        file,
        message: `The policy says \`${NO_TELEMETRY_SENTENCE}\`, but the repo now ships a runnable service (${serviceSignals(repoDir, pkg, deps).join("; ")}).`,
      },
    ];
  },
};

const consoleBypass: DriftRule<ObservabilityDriftContext> = {
  id: "console-bypass",
  check({ repoDir, policy }) {
    if (isNoTelemetry(policy)) return [];
    // Files the policy names, the logger among them, are exempt; a file named only in a
    // Known gaps item is a listed shortfall, not an exemption, and is suppressed later.
    const gapTexts = (parseKnownGaps(policy) ?? []).map((g) => g.text);
    const occurrences = (text: string, p: string): number => text.split(`\`${p}\``).length - 1;
    const named = policyPathTokens(policy).filter(
      (p) => occurrences(policy, p) > gapTexts.reduce((n, t) => n + occurrences(t, p), 0),
    );
    const loggerNamed = named.some((p) => LOGGER_MODULE.test(p));
    if (!loggerNamed && !JSON_STDOUT_RULE.detect.test(policy)) return [];
    const sites = findConsoleCalls(repoDir, {
      maxDepth: CONSOLE_MAX_DEPTH,
      maxFiles: CONSOLE_MAX_FILES,
      skipDirs: CONSOLE_EXEMPT_DIRS,
      skipFiles: new Set(named),
    });
    return sites.map((s) => ({
      rule: "console-bypass",
      key: s.file,
      file: s.file,
      line: s.line,
      message: `The policy says service code logs structured JSON through its shared logger, but this file calls \`console.*\` directly (${s.count} call(s)).`,
    }));
  },
};

type InfraRoot = { label: string; dir: string | null };

function infraRoots(infra: InfraClones | null): { fleet: InfraRoot; prod: InfraRoot } {
  return {
    fleet: { label: "fleet-infra", dir: infra?.fleetInfra ?? null },
    prod: { label: "production-infra", dir: infra?.productionInfra ?? null },
  };
}

/**
 * Path tokens the policy qualifies with an infra repo name (`production-infra`
 * or `fleet-infra`, whitespace only before the backticked path). Maps each
 * token, leading `./` stripped, to the repo it was first qualified with.
 */
function qualifiedInfraPaths(policy: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const m of policy.matchAll(/\b(fleet-infra|production-infra)\s+`([^`\n]+)`/g)) {
    const token = m[2]!.replace(/^\.\//, "");
    if (!map.has(token)) map.set(token, m[1]!);
  }
  return map;
}

/** A path the policy names: a file, a directory (trailing `/`) or a `*` glob, optionally tied to one infra repo. */
export interface NamedPathClaim {
  token: string;
  kind: "file" | "dir" | "glob";
  /** Lowercase short name of the repo the claim is pinned to (`fleet-infra`, `claws`, …). */
  repo?: string;
}

const CLAIM_SEGMENT = /^[\w.@~*-]+$/;
const REPO_COLON_PREFIX = /^(?:[\w.-]+\/)?([\w.-]+):(?=[^/])/;
/** A last segment that is wholly a version (`8.6.0`, `5.0`, `1.25.3-alpine`), as in `curl/8.6.0`. */
const VERSION_SEGMENT = /^v?\d+(?:\.\d+)+(?:[-+][0-9A-Za-z.-]+)?$/;

/**
 * Backticked tokens the `named-path-missing` rule checks: everything
 * `policyPathTokens` accepts, plus a `<repo>:` / `<owner>/<repo>:` prefix
 * (stripped, sets `repo` to the lowercase short name), a trailing `/` (a directory, needing at
 * least two segments) and `*` / `**` segments (a glob, no extension needed).
 * A file token whose last segment is a version (`curl/8.6.0`) is not a path.
 * Deduplicated by token, in order of first appearance.
 */
export function namedPathClaims(policy: string): NamedPathClaim[] {
  const seen = new Map<string, NamedPathClaim>();
  for (const raw of inlineCode(policy)) {
    let token = raw.replace(/^\.\//, "");
    let repo: string | undefined;
    const prefix = token.match(REPO_COLON_PREFIX);
    if (prefix) {
      repo = prefix[1]!.toLowerCase();
      token = token.slice(prefix[0].length);
    }
    const dir = token.endsWith("/");
    const parts = (dir ? token.slice(0, -1) : token).split("/");
    if (parts.length < 2 || parts.some((seg) => seg === "" || seg === ".." || !CLAIM_SEGMENT.test(seg))) continue;
    const glob = parts.some((seg) => seg.includes("*"));
    if (glob && /\*{3,}/.test(token)) continue;
    let kind: NamedPathClaim["kind"];
    if (glob) kind = "glob";
    else if (dir) kind = "dir";
    else if (HAS_EXTENSION.test(token) && !VERSION_SEGMENT.test(parts[parts.length - 1]!)) kind = "file";
    else continue;
    if (!seen.has(token)) seen.set(token, { token, kind, ...(repo ? { repo } : {}) });
  }
  return [...seen.values()];
}

function claimExists(root: string, claim: NamedPathClaim): boolean {
  try {
    if (claim.kind === "file") return fs.existsSync(path.join(root, claim.token));
    if (claim.kind === "dir") return fs.statSync(path.join(root, claim.token)).isDirectory();
    const hits = fs.globSync(claim.token, {
      cwd: root,
      exclude: (name: string) => name === "node_modules" || name === ".git",
    });
    return hits.length > 0;
  } catch {
    return false;
  }
}

function joinLabels(labels: string[]): string {
  return labels.length < 2 ? labels.join("") : `${labels.slice(0, -1).join(", ")} or ${labels[labels.length - 1]}`;
}

const namedPathMissing: DriftRule<ObservabilityDriftContext> = {
  id: "named-path-missing",
  check({ repoDir, policy, infra, repoClones }) {
    const { fleet, prod } = infraRoots(infra);
    const findings: DriftFinding[] = [];
    const qualified = qualifiedInfraPaths(policy);
    const app: InfraRoot = { label: "this repo", dir: repoDir };
    for (const claim of namedPathClaims(policy)) {
      const { token } = claim;
      const q = claim.repo ?? qualified.get(token);
      let named: InfraRoot | null;
      if (q === "fleet-infra") named = fleet;
      else if (q === "production-infra") named = prod;
      else if (q) {
        if (!repoClones?.has(q)) continue;
        named = { label: q, dir: repoClones.get(q) ?? null };
      } else
        named = token.startsWith(FLEET_INFRA_PREFIX)
          ? fleet
          : token.startsWith(PRODUCTION_INFRA_PREFIX)
            ? prod
            : null;
      const roots = named ? [named] : [app, fleet, prod];
      const checked: string[] = [];
      let found = false;
      for (const root of roots) {
        // All-or-nothing: one absent clone makes the whole rule unavailable.
        if (root.dir === null) return { unavailable: `${root.label} clone is absent, so \`${token}\` cannot be checked` };
        checked.push(root.label);
        if (claimExists(root.dir, claim)) {
          found = true;
          break;
        }
      }
      if (found) continue;
      const what = claim.kind === "file" ? "no such file exists" : claim.kind === "dir" ? "no such directory exists" : "no file matches";
      findings.push({
        rule: "named-path-missing",
        key: token,
        message: `The policy names \`${token}\`, but ${what} in ${joinLabels(checked)}.`,
      });
    }
    return findings;
  },
};

/** Text of every readable file under `dir`, for plain-text reference searches. */
function readCorpus(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const texts: string[] = [];
  walkRepoTree(dir, {
    maxDepth: INFRA_MAX_DEPTH,
    onDirectory: ({ absPath, entries }) => {
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        const abs = path.join(absPath, entry.name);
        try {
          if (fs.statSync(abs).size > MAX_FILE_BYTES) continue;
          texts.push(fs.readFileSync(abs, "utf-8"));
        } catch {
          continue;
        }
      }
    },
  });
  return texts;
}

/** Rule uids (`uid \`x\``) and `claws_service` / `claws_alertname` values the policy names. */
export function policyAlertReferences(policy: string): { kind: "uid" | "label"; value: string }[] {
  const text = unfenced(policy);
  const refs = new Map<string, "uid" | "label">();
  for (const m of text.matchAll(UID_REF)) refs.set(m[1]!.trim(), "uid");
  for (const m of text.matchAll(LABEL_REF)) {
    const value = m[2]!.trim();
    if (value && !refs.has(value)) refs.set(value, "label");
  }
  for (const token of inlineCode(policy)) {
    const value = LABEL_TOKEN.exec(token)?.[1];
    if (value && !refs.has(value)) refs.set(value, "label");
  }
  return [...refs].map(([value, kind]) => ({ kind, value }));
}

const alertReferenceMissing: DriftRule<ObservabilityDriftContext> = {
  id: "alert-reference-missing",
  check({ policy, infra }) {
    const refs = policyAlertReferences(policy);
    if (refs.length === 0) return [];
    const { fleet, prod } = infraRoots(infra);
    const corpus = [
      ...(fleet.dir ? readCorpus(path.join(fleet.dir, FLEET_INFRA_PREFIX)) : []),
      ...(prod.dir ? readCorpus(path.join(prod.dir, PRODUCTION_INFRA_PREFIX)) : []),
    ];
    const missing = refs.filter((r) => !corpus.some((t) => t.includes(r.value)));
    if (missing.length === 0) return [];
    // A reference may live in the clone we could not read, so absence proves nothing.
    const absent = [fleet, prod].filter((r) => r.dir === null).map((r) => r.label);
    if (absent.length > 0) return { unavailable: `${absent.join(" and ")} clone is absent` };
    return missing.map((r) => ({
      rule: "alert-reference-missing",
      key: r.value,
      message: `The policy names ${r.kind === "uid" ? "uid" : "alert label value"} \`${r.value}\`, but no file under fleet-infra \`${FLEET_INFRA_PREFIX}\` or production-infra \`${PRODUCTION_INFRA_PREFIX}\` mentions it.`,
    }));
  },
};

function isConfigFile(name: string): boolean {
  if (CONFIG_SKIP_FILES.has(name) || TEST_FILE.test(name)) return false;
  if (name === "Dockerfile" || name.startsWith(".env")) return true;
  return CONFIG_EXTENSIONS.has(path.extname(name));
}

/** 1-based line where `text` sets a log level that drops `info`, or null. */
export function infoDroppingLine(text: string): number | null {
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (LOG_LEVEL_ASSIGN.test(line) || LOG_KEY_LEVEL.test(line)) return i + 1;
    if (LOG_LEVEL_ENV_NAME.test(line) && lines.slice(i + 1, i + 3).some((l) => ENV_VALUE.test(l))) return i + 1;
    if (BARE_LEVEL.test(line) && lines.slice(Math.max(0, i - 3), i).some((l) => LOG_CONTEXT.test(l))) return i + 1;
  }
  return null;
}

const infoDropped: DriftRule<ObservabilityDriftContext> = {
  id: "info-dropped",
  check({ repoDir, policy }) {
    if (isNoTelemetry(policy) || !INFO_SHIPPING_RULE.detect.test(policy)) return [];
    const findings: DriftFinding[] = [];
    let filesRead = 0;
    walkRepoTree(repoDir, {
      maxDepth: CONFIG_MAX_DEPTH,
      extraSkipDirs: CONFIG_SKIP_DIRS,
      onDirectory: ({ absPath, relPath, entries }) => {
        for (const entry of entries) {
          if (filesRead >= CONFIG_MAX_FILES) return;
          if (!entry.isFile() || !isConfigFile(entry.name)) continue;
          const rel = relPath === "" ? entry.name : `${relPath}/${entry.name}`;
          const abs = path.join(absPath, entry.name);
          filesRead++;
          let text: string;
          try {
            if (fs.statSync(abs).size > MAX_FILE_BYTES) continue;
            text = fs.readFileSync(abs, "utf-8");
          } catch {
            continue;
          }
          const line = infoDroppingLine(text);
          if (line === null) continue;
          findings.push({
            rule: "info-dropped",
            key: rel,
            file: rel,
            line,
            message: "The policy says every `info`-and-above line reaches Loki, but this config sets a log level above `info`, which drops `info` lines.",
          });
        }
      },
    });
    return findings;
  },
};

export const OBSERVABILITY_DRIFT_RULES: readonly DriftRule<ObservabilityDriftContext>[] = [
  noTelemetryService,
  consoleBypass,
  namedPathMissing,
  alertReferenceMissing,
  infoDropped,
];

/** Rule id of a finding from the weekly observability audit; declared here so this module does not import `observability-audit.ts`, which imports it. */
export const OBSERVABILITY_AUDIT_RULE = "observability-audit";

/** Rules a `.claws/contract-exceptions.yaml` observability entry may name: every drift rule and the audit rule. */
export const OBSERVABILITY_EXCEPTION_RULES: readonly string[] = [...OBSERVABILITY_DRIFT_RULES.map((r) => r.id), OBSERVABILITY_AUDIT_RULE];

/** The repo's valid observability scanner exceptions and the problems found reading them. */
export function readObservabilityExceptions(repoDir: string): { exceptions: ContractException[]; problems: string[] } {
  return readContractExceptions(repoDir, "observability", OBSERVABILITY_EXCEPTION_RULES, { auditRules: [OBSERVABILITY_AUDIT_RULE] });
}

export interface ObservabilityDriftResult extends DriftRunResult {
  /** Findings dropped because a Known gaps item names their key and rule id or fingerprint. */
  suppressed: number;
  /** Findings dropped by a scanner exception. */
  excepted: number;
}

/**
 * Runs every observability drift rule against the repo at `repoDir` and its
 * policy text, then drops findings a scanner exception or a Known gaps item
 * (accepted or not) covers (`suppressFindings`). Each problem in the repo's
 * `.claws/contract-exceptions.yaml` is appended as a `contract-exceptions`
 * finding, which nothing suppresses. `infra` gives the fleet-infra and
 * production-infra clone dirs, or null when neither is available;
 * `repoClones` maps managed repo short names to clone dirs for `<repo>:path` claims.
 */
export function detectObservabilityDrift(
  repoDir: string,
  policyText: string,
  infra: InfraClones | null,
  repoClones?: ReadonlyMap<string, string | null>,
): ObservabilityDriftResult {
  const raw = runDriftRules(OBSERVABILITY_DRIFT_RULES, { repoDir, policy: policyText, infra, repoClones });
  const { exceptions, problems } = readObservabilityExceptions(repoDir);
  const s = suppressFindings(raw.findings, { gaps: parseKnownGaps(policyText) ?? [], exceptions });
  return {
    findings: [...s.kept, ...exceptionProblemFindings(problems)],
    unavailable: raw.unavailable,
    suppressed: s.byGap,
    excepted: s.byException,
  };
}
