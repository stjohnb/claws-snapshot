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
 * The `Update` column values of Renovate's `| Package | Update | Change |`
 * body table, or null when the body has no such table with at least one row.
 */
export function renovateUpdateTypes(body: string | undefined): string[] | null {
  if (!body) return null;
  const lines = body.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const header = tableCells(lines[i]);
    if (!header) continue;
    const col = header.findIndex((c) => plainCell(c) === "update");
    if (col < 0) continue;
    const types: string[] = [];
    for (let j = i + 1; j < lines.length; j++) {
      const cells = tableCells(lines[j]);
      if (!cells) break;
      if (cells.every((c) => /^:?-+:?$/.test(c))) continue; // separator row
      types.push(plainCell(cells[col] ?? ""));
    }
    if (types.length > 0) return types;
  }
  return null;
}

/**
 * True when a Renovate PR is — or may be — a major update: a `major-update`
 * label, a `major` row in the body's Update column, a title ending `(major)`,
 * or a `renovate/major-` branch. A body with no parseable Update column also
 * counts, so an unrecognised PR shape fails closed and waits for a human.
 */
export function isRenovateMajorUpdate(pr: PR): boolean {
  if (pr.labels.some((l) => l.name === "major-update")) return true;
  if (/\(major\)\s*$/i.test(pr.title)) return true;
  if (pr.headRefName.startsWith("renovate/major-")) return true;
  const types = renovateUpdateTypes(pr.body);
  if (types === null) return true;
  return types.includes("major");
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
