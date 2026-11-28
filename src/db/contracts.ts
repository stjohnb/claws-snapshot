// Contract audits, contract status and contract gap reconfirmations.
// Reached only through the src/db.ts façade.
import { getDb } from "./core.js";

// ── Contract audits ──
// One row per (contract, repo): the newest contract-audit agent run's HEAD,
// time and findings. Replaced on each audit; read by the contract's daily scanner.

export interface ContractAuditRow {
  contract: string;
  repo: string;
  headSha: string;
  /** ISO 8601. */
  auditedAt: string;
  /** Parsed `findings` JSON; each item a DriftFinding (`rule`, `key`, `file?`, `line?`, `message`). */
  findings: unknown[];
}

/** The latest stored audit of `repo` under `contract`, or null when it has never been audited. */
export async function getContractAudit(contract: string, repo: string): Promise<ContractAuditRow | null> {
  const row = await getDb().get(
    `SELECT contract, repo, head_sha, audited_at, findings FROM contract_audits WHERE contract = ? AND repo = ?`,
    [contract, repo],
  ) as { contract: string; repo: string; head_sha: string; audited_at: string; findings: string } | undefined;
  if (!row) return null;
  let findings: unknown[] = [];
  try {
    const parsed: unknown = JSON.parse(row.findings);
    if (Array.isArray(parsed)) findings = parsed;
  } catch {
    // A corrupt row reads as no findings; the next audit replaces it.
  }
  return { contract: row.contract, repo: row.repo, headSha: row.head_sha, auditedAt: row.audited_at, findings };
}

/** Stores an audit of `repo` under `contract`, replacing any earlier one. */
export async function saveContractAudit(
  contract: string,
  repo: string,
  headSha: string,
  auditedAt: string,
  findings: readonly unknown[],
): Promise<void> {
  await getDb().run(`
    INSERT INTO contract_audits (contract, repo, head_sha, audited_at, findings)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(contract, repo) DO UPDATE SET
      head_sha = excluded.head_sha,
      audited_at = excluded.audited_at,
      findings = excluded.findings
  `, [contract, repo, headSha, auditedAt, JSON.stringify(findings)]);
}

// ── Contract status ──
// One row per (contract, repo): the contract's daily scanner's latest snapshot
// (src/contract-status.ts ContractStatusSnapshot). Replaced on each scan; read
// by the dashboard's /contracts pages.

export interface ContractStatusRow {
  contract: string;
  repo: string;
  /** ISO 8601. */
  scannedAt: string;
  /** Parsed `snapshot` JSON; null when the stored text is corrupt. */
  snapshot: unknown;
}

interface ContractStatusDbRow { contract: string; repo: string; scanned_at: string; snapshot: string }

function toContractStatusRow(row: ContractStatusDbRow): ContractStatusRow {
  let snapshot: unknown = null;
  try {
    snapshot = JSON.parse(row.snapshot);
  } catch {
    // A corrupt row reads as no snapshot; the next scan replaces it.
  }
  return { contract: row.contract, repo: row.repo, scannedAt: row.scanned_at, snapshot };
}

/** Stores the scanner's snapshot of `repo` under `contract`, replacing any earlier one. */
export async function saveContractStatus(contract: string, repo: string, scannedAt: string, snapshot: unknown): Promise<void> {
  await getDb().run(`
    INSERT INTO contract_status (contract, repo, scanned_at, snapshot)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(contract, repo) DO UPDATE SET
      scanned_at = excluded.scanned_at,
      snapshot = excluded.snapshot
  `, [contract, repo, scannedAt, JSON.stringify(snapshot)]);
}

/** Every stored contract snapshot, ordered by repo then contract. */
export async function listContractStatuses(): Promise<ContractStatusRow[]> {
  const rows = await getDb().all(
    `SELECT contract, repo, scanned_at, snapshot FROM contract_status ORDER BY repo, contract`,
  ) as ContractStatusDbRow[];
  return rows.map(toContractStatusRow);
}

/** The stored contract snapshots of `repo`, ordered by contract. */
export async function getContractStatuses(repo: string): Promise<ContractStatusRow[]> {
  const rows = await getDb().all(
    `SELECT contract, repo, scanned_at, snapshot FROM contract_status WHERE repo = ? ORDER BY contract`,
    [repo],
  ) as ContractStatusDbRow[];
  return rows.map(toContractStatusRow);
}

// ── Contract gap reconfirmations ──
// One row per (contract, repo): when a person last reconfirmed the repo's
// accepted Known gaps for the contract in the fleet-wide accepted-gaps review,
// and the keys of the gaps reconfirmed (src/contract-gap-review.ts).

export interface ContractGapReconfirmationRow {
  contract: string;
  repo: string;
  /** ISO 8601. */
  reconfirmedAt: string;
  /** `gapKey` of every accepted gap reconfirmed; empty when the stored text is corrupt. */
  gapKeys: string[];
}

/** Stores the reconfirmation of `repo`'s accepted `contract` gaps, replacing any earlier one. */
export async function saveContractGapReconfirmation(
  contract: string,
  repo: string,
  reconfirmedAt: string,
  gapKeys: readonly string[],
): Promise<void> {
  await getDb().run(`
    INSERT INTO contract_gap_reconfirmations (contract, repo, reconfirmed_at, gap_keys)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(contract, repo) DO UPDATE SET
      reconfirmed_at = excluded.reconfirmed_at,
      gap_keys = excluded.gap_keys
  `, [contract, repo, reconfirmedAt, JSON.stringify(gapKeys)]);
}

/** Every stored reconfirmation, ordered by repo then contract. */
export async function listContractGapReconfirmations(): Promise<ContractGapReconfirmationRow[]> {
  const rows = await getDb().all(
    `SELECT contract, repo, reconfirmed_at, gap_keys FROM contract_gap_reconfirmations ORDER BY repo, contract`,
  ) as Array<{ contract: string; repo: string; reconfirmed_at: string; gap_keys: string }>;
  return rows.map((r) => {
    let gapKeys: string[] = [];
    try {
      const parsed: unknown = JSON.parse(r.gap_keys);
      if (Array.isArray(parsed)) gapKeys = parsed.filter((k): k is string => typeof k === "string");
    } catch {
      // A corrupt row reads as nothing reconfirmed; the next reconfirmation replaces it.
    }
    return { contract: r.contract, repo: r.repo, reconfirmedAt: r.reconfirmed_at, gapKeys };
  });
}

/** When each (contract, repo) was last audited and the HEAD it read; findings are not read. */
export async function listContractAuditTimes(): Promise<Array<{ contract: string; repo: string; auditedAt: string; headSha: string }>> {
  const rows = await getDb().all(
    `SELECT contract, repo, audited_at, head_sha FROM contract_audits ORDER BY repo, contract`,
  ) as Array<{ contract: string; repo: string; audited_at: string; head_sha: string }>;
  return rows.map((r) => ({ contract: r.contract, repo: r.repo, auditedAt: r.audited_at, headSha: r.head_sha }));
}
