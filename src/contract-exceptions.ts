/**
 * A repo's scanner exceptions: `.claws/contract-exceptions.yaml`, where it
 * records that one specific contract drift or audit finding is wrong or does
 * not apply, with a reason. Each entry names a contract, a rule, the exact
 * finding keys it covers and, optionally, one finding's fingerprint; it never
 * covers a whole file. Known gaps lists real shortfalls only.
 *
 * Leaf module: it reads and validates the file and imports nothing from the
 * drift modules. An invalid file or entry suppresses nothing; each problem is
 * returned so the caller reports it as a finding of its own.
 */
import fs from "node:fs";
import path from "node:path";
import { parse } from "yaml";
import { z } from "zod";

/** Repo-relative path of the exceptions file. */
export const CONTRACT_EXCEPTIONS_PATH = ".claws/contract-exceptions.yaml";

/** Contracts an entry may name. */
export const EXCEPTION_CONTRACTS: readonly string[] = ["observability", "security"];

/** Minimum words in an entry's `reason`. */
export const MIN_REASON_WORDS = 3;

const FINGERPRINT = /^[0-9a-f]{8}$/;

/** One validated entry. */
export interface ContractException {
  contract: string;
  /** Id of the rule whose findings it covers. */
  rule: string;
  /** Exact finding keys it covers. */
  keys: string[];
  reason: string;
  /** One finding's fingerprint; required for an audit rule. */
  finding?: string;
}

export interface ContractExceptionsResult {
  exceptions: ContractException[];
  /** One sentence per dropped entry or unreadable file; empty when the file is absent or valid. */
  problems: string[];
}

export interface ReadContractExceptionsOptions {
  /** Rule ids whose findings are matched only by fingerprint, so an entry for one must give `finding`. */
  auditRules?: readonly string[];
  /**
   * Whether to report entries that name no known contract, or are unparseable. Exactly one
   * scanner should set this, so the same problem is not filed in two follow-up issues. Default true.
   */
  reportUnowned?: boolean;
}

const FILE_SCHEMA = z.object({ exceptions: z.array(z.unknown()) });

const ENTRY_SCHEMA = z.object({
  contract: z.string(),
  rule: z.string(),
  keys: z.array(z.string()),
  reason: z.string(),
  finding: z.string().optional(),
});

function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

/**
 * The repo's exceptions for `contract`, read from `CONTRACT_EXCEPTIONS_PATH`
 * under `repoDir`. A missing file gives no exceptions and no problems. An
 * unparseable file, or an entry with an unknown `contract`, a `rule` not in
 * `validRules`, no `keys`, a `reason` under three words, a malformed
 * `finding`, or an audit rule without `finding`, is dropped and recorded in
 * `problems`. Entries for another known contract are skipped silently; entries
 * naming no known contract are reported unless `reportUnowned` is false.
 */
export function readContractExceptions(
  repoDir: string,
  contract: string,
  validRules: readonly string[],
  opts: ReadContractExceptionsOptions = {},
): ContractExceptionsResult {
  const abs = path.join(repoDir, CONTRACT_EXCEPTIONS_PATH);
  let text: string;
  try {
    text = fs.readFileSync(abs, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { exceptions: [], problems: [] };
    return { exceptions: [], problems: ["the file is unreadable"] };
  }
  let doc: unknown;
  try {
    doc = parse(text);
  } catch (err) {
    const detail = err instanceof Error ? err.message.split("\n")[0] : String(err);
    return { exceptions: [], problems: [`the file is not valid YAML (${detail})`] };
  }
  if (doc === null || doc === undefined) return { exceptions: [], problems: [] };
  const file = FILE_SCHEMA.safeParse(doc);
  if (!file.success) return { exceptions: [], problems: ["the file has no top-level `exceptions` list"] };

  const auditRules = opts.auditRules ?? [];
  const exceptions: ContractException[] = [];
  const problems: string[] = [];
  file.data.exceptions.forEach((raw, i) => {
    const at = `entry ${i + 1}`;
    const named = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>)["contract"] : undefined;
    if (typeof named === "string" && named !== contract && EXCEPTION_CONTRACTS.includes(named)) return;
    const reportUnowned = opts.reportUnowned ?? true;
    const rawFinding = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>)["finding"] : undefined;
    if (rawFinding !== undefined && typeof rawFinding !== "string") {
      // Unquoted ids such as 12345678 or 0e123456 are read as numbers and lose digits, so they cannot be coerced back.
      if (reportUnowned || named === contract) {
        problems.push(`${at} has a \`finding\` that YAML read as a number; \`finding\` must be a quoted string, e.g. \`finding: "0123abcd"\``);
      }
      return;
    }
    const parsed = ENTRY_SCHEMA.safeParse(raw);
    if (!parsed.success) {
      if (!reportUnowned && named !== contract) return;
      problems.push(`${at} needs string \`contract\`, \`rule\` and \`reason\` fields and a \`keys\` list of strings`);
      return;
    }
    const e = parsed.data;
    if (!EXCEPTION_CONTRACTS.includes(e.contract)) {
      if (!reportUnowned) return;
      problems.push(`${at} names unknown contract \`${e.contract}\` (use ${EXCEPTION_CONTRACTS.map((c) => `\`${c}\``).join(" or ")})`);
      return;
    }
    if (!validRules.includes(e.rule)) {
      problems.push(`${at} names rule \`${e.rule}\`, which is not one of the ${contract} rules (${validRules.map((r) => `\`${r}\``).join(", ")})`);
      return;
    }
    const keys = e.keys.map((k) => k.trim()).filter(Boolean);
    if (keys.length === 0) {
      problems.push(`${at} has no \`keys\``);
      return;
    }
    const reason = e.reason.trim();
    if (wordCount(reason) < MIN_REASON_WORDS) {
      problems.push(`${at} needs a \`reason\` of at least ${MIN_REASON_WORDS} words`);
      return;
    }
    const finding = e.finding?.trim().toLowerCase();
    if (finding !== undefined && !FINGERPRINT.test(finding)) {
      problems.push(`${at} has \`finding\` \`${e.finding}\`, which is not an 8-character finding id`);
      return;
    }
    if (finding === undefined && auditRules.includes(e.rule)) {
      problems.push(`${at} covers audit rule \`${e.rule}\`, which needs the \`finding\` id of the one finding it covers`);
      return;
    }
    exceptions.push({ contract: e.contract, rule: e.rule, keys, reason, ...(finding !== undefined ? { finding } : {}) });
  });
  return { exceptions, problems };
}
