/**
 * Renovate PR classification for the auto-merger's approval exemption: a
 * non-major update from a trusted Renovate identity merges without a
 * dashboard approval, the way Dependabot's do. The forge `Automerge` label is
 * never read here — trust comes from who authored the PR, which Claws' own
 * installation token cannot impersonate (#3219).
 */

import { isForgejoRepo } from "./config.js";
import { isAllowedHumanActor, isForkPR, normalizeBotLogin, type PR } from "./github.js";

/** The account the Forgejo Renovate runner opens PRs as. */
export const FORGEJO_RENOVATE_LOGIN = "renovate";

/** Split a markdown table row into trimmed cells, or null if the line is not a row. */
function tableCells(line: string): string[] | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("|")) return null;
  return trimmed.replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
}

/** A cell's plain text: markdown emphasis and code ticks removed, lower-cased. */
function plainCell(cell: string): string {
  return cell.replace(/[`*_]/g, "").trim().toLowerCase();
}

/**
 * The `Update` column values of every `| Package | Update | Change |`-style
 * table in the body (Renovate's table may sit below text prepended to the
 * body), or null when no such table has at least one row.
 */
export function renovateUpdateTypes(body: string | undefined): string[] | null {
  if (!body) return null;
  const lines = body.split(/\r?\n/);
  const types: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const header = tableCells(lines[i]);
    if (!header) continue;
    const col = header.findIndex((c) => plainCell(c) === "update");
    if (col < 0) continue;
    for (let j = i + 1; j < lines.length; j++) {
      const cells = tableCells(lines[j]);
      if (!cells) break;
      i = j;
      if (cells.every((c) => /^:?-+:?$/.test(c))) continue; // separator row
      types.push(plainCell(cells[col] ?? ""));
    }
  }
  return types.length > 0 ? types : null;
}

export type RenovateUpdateKind = "major" | "non-major" | "unknown";

/**
 * Classify a Renovate PR: `major` on a `major-update` label, a title ending
 * `(major)` or Renovate's major title shape `to v<N>` (no dots — Renovate
 * titles the PR with the first commit's subject), a `renovate/major-` branch,
 * or a `major` row in any Update-column table; `non-major` when a table was
 * found without one; `unknown` when nothing is known.
 */
export function classifyRenovateUpdate(pr: PR): RenovateUpdateKind {
  if (pr.labels.some((l) => l.name === "major-update")) return "major";
  if (/\(major\)\s*$/i.test(pr.title)) return "major";
  if (pr.headRefName.startsWith("renovate/major-")) return "major";
  if (/\bto v\d+\s*(\(major\))?\s*$/i.test(pr.title)) return "major";
  const types = renovateUpdateTypes(pr.body);
  if (types === null) return "unknown";
  return types.includes("major") ? "major" : "non-major";
}

/**
 * True when a Renovate PR is — or may be — a major update. Anything not
 * positively classified non-major counts, so an unrecognised PR shape fails
 * closed and waits for a human.
 */
export function isRenovateMajorUpdate(pr: PR): boolean {
  return classifyRenovateUpdate(pr) !== "non-major";
}

/** Shown on `/prs` and in the auto-merger's skip reason when the update type could not be classified. */
export const RENOVATE_UPDATE_TYPE_UNKNOWN_REASON = "update type unknown (body has no Renovate table)";

/**
 * The reason a trusted Renovate PR is held for approval only because its
 * update type could not be determined, or null for any other PR.
 */
export async function renovateApprovalHoldReason(repoFullName: string, pr: PR): Promise<string | null> {
  if (!(await isTrustedRenovatePR(repoFullName, pr))) return null;
  return classifyRenovateUpdate(pr) === "unknown" ? RENOVATE_UPDATE_TYPE_UNKNOWN_REASON : null;
}

/**
 * True when the PR was opened by a trusted Renovate identity: a non-fork PR on
 * a `renovate/` branch authored by the Renovate GitHub App, by the Forgejo
 * `renovate` account (Forgejo repos only), or by an allowed human actor whose
 * PAT runs Renovate (fleet-infra). Claws' own accounts, other bots and
 * unlisted logins never qualify.
 */
export async function isTrustedRenovatePR(repoFullName: string, pr: PR): Promise<boolean> {
  if (isForkPR(pr)) return false;
  if (!pr.headRefName.startsWith("renovate/")) return false;
  const login = normalizeBotLogin(pr.author.login);
  if (login === "renovate[bot]") return true;
  if (login === FORGEJO_RENOVATE_LOGIN) return isForgejoRepo(repoFullName);
  return isAllowedHumanActor(pr.author.login, repoFullName);
}
