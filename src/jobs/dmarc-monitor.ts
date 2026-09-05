import type { Attachment, ParsedMail } from "mailparser";
import * as config from "../config.js";
import {
  getLatestDmarcReportForDomain,
  insertDmarcReport,
  type DmarcReportRow,
} from "../db.js";
import {
  decompressReportAttachment,
  isDmarcSubject,
  parseDmarcReport,
  type DmarcParsedRow,
  type DmarcReport,
} from "../dmarc.js";
import { reportError } from "../error-reporter.js";
import * as log from "../log.js";
import { upsertAlertIssue } from "../occurrence-tracking.js";
import { sendMessage } from "../whatsapp.js";

const LOG_PREFIX = "dmarc-monitor";

/** Refuse an oversized attachment before decompressing it — a zip bomb must not reach zlib. */
const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;

/** Nothing reads raw_xml back except getDmarcReportXml(); store enough to debug a parse, not an attacker-chosen 5 MB blob per email. */
const MAX_STORED_XML_BYTES = 256 * 1024;
/** Rolling window for both ingest and alert rate limits. Real volume is a handful of reports per day. */
const RATE_WINDOW_MS = 60 * 60 * 1000;
const MAX_REPORTS_PER_WINDOW = 50;
const MAX_ALERTS_PER_WINDOW = 5;
/** Don't re-file the flood alert on every throttled message. */
const RATE_ALERT_COOLDOWN_MS = 6 * 60 * 60 * 1000;

const REPORT_EXTENSIONS = [".zip", ".gz", ".gzip", ".xml"];
const REPORT_CONTENT_TYPES = [
  "application/zip",
  "application/x-zip-compressed",
  "application/gzip",
  "application/x-gzip",
  "text/xml",
  "application/xml",
];

/** Verdicts that mean "a human has to look at this before the policy can be tightened". */
const NEEDS_HUMAN: ReadonlySet<string> = new Set(["spoof", "unaligned_pass", "unknown"]);

let dmarcStatus = {
  lastIngestAt: null as string | null,
  lastError: null as string | null,
  reportsIngested: 0,
  blockedSenders: 0,
  throttledReports: 0,
  suppressedAlerts: 0,
  lastThrottleAt: null as string | null,
};

export function getDmarcStatus(): typeof dmarcStatus {
  return dmarcStatus;
}

// Rolling one-hour windows of ingest/alert timestamps, bounding both the
// event-loop cost of a flood and the number of forged issues/WhatsApp pushes
// it can produce. Module state is intentional — see docs/jobs/dmarc-monitor.md.
const recentIngests: number[] = [];
const recentAlerts: number[] = [];
let rateAlertAt = 0;

/** Test-only: module state otherwise leaks between tests in this file. */
export function resetDmarcRateLimitStateForTests(): void {
  recentIngests.length = 0;
  recentAlerts.length = 0;
  rateAlertAt = 0;
  dmarcStatus.blockedSenders = 0;
  dmarcStatus.throttledReports = 0;
  dmarcStatus.suppressedAlerts = 0;
  dmarcStatus.lastThrottleAt = null;
}

/** Drop entries older than the rolling window (in place — the arrays are module-level `const`) and return the remaining count. */
function sweep(window: number[], now: number): number {
  const cutoff = now - RATE_WINDOW_MS;
  while (window.length > 0 && window[0] < cutoff) window.shift();
  return window.length;
}

/**
 * Best-effort denylist match — a `From`/`report_metadata/email` address is
 * forgeable, so this stops a repeat lazy offender, not a determined attacker.
 * An entry containing `@` matches a full address; otherwise it matches a
 * domain and its subdomains.
 */
function isBlockedSender(addresses: string[]): string | null {
  for (const raw of addresses) {
    const address = raw.toLowerCase().trim();
    if (!address) continue;
    const atIndex = address.lastIndexOf("@");
    const addrDomain = atIndex === -1 ? "" : address.slice(atIndex + 1);
    for (const entry of config.DMARC_BLOCKED_SENDERS) {
      if (entry.includes("@")) {
        if (address === entry) return entry;
      } else if (addrDomain === entry || addrDomain.endsWith("." + entry)) {
        return entry;
      }
    }
  }
  return null;
}

/** Fixed title so an attacker cannot mint issues by varying a field — a flood must tell the operator once, not once per forged domain. */
async function raiseRateLimitAlert(kind: string, detail: string): Promise<void> {
  if (Date.now() - rateAlertAt < RATE_ALERT_COOLDOWN_MS) return;
  await upsertAlertIssue({
    repo: config.SELF_REPO,
    title: `[dmarc] Ingestion rate limit tripped`,
    body: [
      `The DMARC ${kind} rate limit tripped in the last ${RATE_WINDOW_MS / 60000} minutes.`,
      "",
      detail,
      "",
      `Caps: ${MAX_REPORTS_PER_WINDOW} ingests / ${MAX_ALERTS_PER_WINDOW} alert issues per ${RATE_WINDOW_MS / 60000}-minute window. The DMARC \`rua=\` mailbox is public, so this is expected to happen under a flood of forged reports — no WhatsApp push is sent for this alert.`,
    ].join("\n"),
    labels: [config.LABELS.priority, config.LABELS.manualAction],
    logPrefix: LOG_PREFIX,
    createdDetail: kind,
  });
  rateAlertAt = Date.now();
}

function looksLikeReportAttachment(att: Attachment): boolean {
  const name = (att.filename ?? "").toLowerCase();
  if (REPORT_EXTENSIONS.some((ext) => name.endsWith(ext))) return true;
  const type = (att.contentType ?? "").toLowerCase();
  return REPORT_CONTENT_TYPES.includes(type);
}

/** Markdown table cells carry attacker-influenceable text (org_name, header_from, comments). */
function cell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/[\r\n]+/g, " ").trim() || "—";
}

function authSummary(results: Array<{ domain: string; result: string }>): string {
  if (results.length === 0) return "—";
  return results.map((r) => `${r.result} (${r.domain || "?"})`).join(", ");
}

function policyLine(r: {
  policyP: string;
  policySp: string;
  policyAdkim: string;
  policyAspf: string;
  policyPct: number | null;
}): string {
  return `p=${r.policyP || "—"}; sp=${r.policySp || "—"}; adkim=${r.policyAdkim || "—"}; aspf=${r.policyAspf || "—"}; pct=${r.policyPct ?? "—"}`;
}

function buildOffendingRowsBody(report: DmarcReport, rows: DmarcParsedRow[]): string {
  const table = [
    "| Verdict | Source IP | Count | Header from | SPF | DKIM | Disposition |",
    "|---|---|---|---|---|---|---|",
    ...rows.map((r) =>
      `| ${cell(r.verdict)} | ${cell(r.sourceIp)} | ${r.count} | ${cell(r.headerFrom)} | ${cell(authSummary(r.spfResults))} | ${cell(authSummary(r.dkimResults))} | ${cell(r.disposition)} |`,
    ),
  ].join("\n");

  return [
    `Aggregate report from **${cell(report.orgName)}** (report ID \`${cell(report.reportId)}\`) contains ${rows.length} row(s) that did not authenticate on an aligned identity.`,
    "",
    `**Window:** ${report.dateBegin} → ${report.dateEnd}`,
    `**Published policy:** \`${policyLine(report)}\``,
    "",
    table,
    "",
    `Every one of these must be explained — a legitimate sender that needs DKIM/SPF alignment fixing, or a spoofer — before \`${cell(report.domain)}\` can be tightened to \`p=reject\`. See the [DMARC dashboard](${config.DASHBOARD_URL}/dmarc) for the full history.`,
    ...(report.truncatedRows > 0
      ? [
          "",
          `**Note:** this report contained more than 1,000 records; ${report.truncatedRows} were dropped at parse time.`,
        ]
      : []),
  ].join("\n");
}

function buildPolicyChangeBody(report: DmarcReport, prev: DmarcReportRow): string {
  const previous = {
    policyP: prev.policy_p,
    policySp: prev.policy_sp,
    policyAdkim: prev.policy_adkim,
    policyAspf: prev.policy_aspf,
    policyPct: prev.policy_pct,
  };
  return [
    `The DMARC policy reporters see published for \`${cell(report.domain)}\` has changed. If this was not an intended DNS edit, check the \`_dmarc.${cell(report.domain)}\` TXT record.`,
    "",
    `**Previous:** \`${policyLine(previous)}\` (report \`${cell(prev.report_id)}\` from ${cell(prev.org_name)}, window ${prev.date_begin} → ${prev.date_end})`,
    `**Current:** \`${policyLine(report)}\` (report \`${cell(report.reportId)}\` from ${cell(report.orgName)}, window ${report.dateBegin} → ${report.dateEnd})`,
  ].join("\n");
}

function policyChanged(report: DmarcReport, prev: DmarcReportRow): boolean {
  return (
    prev.policy_p !== report.policyP ||
    prev.policy_sp !== report.policySp ||
    prev.policy_adkim !== report.policyAdkim ||
    prev.policy_aspf !== report.policyAspf ||
    prev.policy_pct !== report.policyPct
  );
}

/** WhatsApp being unreachable must never fail ingestion — the report is already stored. */
async function notifyWhatsApp(text: string): Promise<void> {
  for (const number of config.WHATSAPP_ALLOWED_NUMBERS) {
    try {
      await sendMessage(`${number}@s.whatsapp.net`, text);
    } catch (err) {
      log.warn(`[${LOG_PREFIX}] WhatsApp notification to ${number} failed: ${err}`);
    }
  }
}

/**
 * Bounds the "unlimited forged issues + WhatsApp pushes" harm: at most
 * `MAX_ALERTS_PER_WINDOW` domain-titled issues per window, since the domain
 * in every alert title comes straight from the attacker-controlled
 * `policy_published/domain`. Returns true when the caller must not file the
 * alert it was about to.
 */
async function alertRateLimited(detail: string): Promise<boolean> {
  if (sweep(recentAlerts, Date.now()) >= MAX_ALERTS_PER_WINDOW) {
    dmarcStatus.suppressedAlerts++;
    log.warn(`[${LOG_PREFIX}] alert rate limit tripped — suppressing: ${detail}`);
    await raiseRateLimitAlert("alerts", `Suppressed alert: ${detail}`).catch((err) => {
      log.error(`[${LOG_PREFIX}] failed to raise rate-limit alert: ${err}`);
    });
    return true;
  }
  recentAlerts.push(Date.now());
  return false;
}

async function alertOnReport(report: DmarcReport, prev: DmarcReportRow | undefined): Promise<void> {
  const needsHuman = report.rows.filter((r) => NEEDS_HUMAN.has(r.verdict));
  const drifted = prev !== undefined && policyChanged(report, prev);

  if (needsHuman.length === 0 && !drifted) {
    log.info(
      `[${LOG_PREFIX}] ${report.domain}: ${report.rows.length} row(s) all aligned or forwarded — no alert`,
    );
    return;
  }

  if (needsHuman.length > 0 && !(await alertRateLimited(`unauthenticated/unaligned mail for ${report.domain}`))) {
    await upsertAlertIssue({
      repo: config.SELF_REPO,
      title: `[dmarc] Unauthenticated or unaligned mail for ${report.domain}`,
      body: buildOffendingRowsBody(report, needsHuman),
      labels: [config.LABELS.priority, config.LABELS.manualAction],
      logPrefix: LOG_PREFIX,
      createdDetail: `${needsHuman.length} row(s) needing review`,
    });
    await notifyWhatsApp(
      `DMARC: ${needsHuman.length} unauthenticated/unaligned row(s) for ${report.domain} (${report.orgName}, ${report.dateBegin} → ${report.dateEnd}), currently p=${report.policyP || "?"}. See ${config.DASHBOARD_URL}/dmarc`,
    );
  }

  if (drifted && prev && !(await alertRateLimited(`policy change for ${report.domain}`))) {
    await upsertAlertIssue({
      repo: config.SELF_REPO,
      title: `[dmarc] Published policy changed for ${report.domain}`,
      body: buildPolicyChangeBody(report, prev),
      labels: [config.LABELS.priority, config.LABELS.manualAction],
      logPrefix: LOG_PREFIX,
      createdDetail: report.domain,
    });
  }
}

/**
 * Recognise, parse and store a DMARC aggregate report from an inbox message.
 * Returns true when the message was a DMARC report (and so must not fall
 * through to the veg-box path, which would burn a Claude call and mark the
 * message seen); false when the caller should keep processing it.
 *
 * This handler runs *before* `EMAIL_ALLOWED_SENDERS` (see `email-monitor.ts`)
 * because real reporters are never in that allowlist — every field below
 * (subject, attachment bytes, and every value the parser extracts from them)
 * is attacker-controlled. The `rua=` mailbox address is published in the
 * operator's public `_dmarc` DNS records, so this is reachable by anyone on
 * the internet. The caps and rate limits in this file exist because of that,
 * not because ingestion is expected to see hostile traffic often.
 *
 * Never throws — a report Claws cannot decompress or parse is reported via
 * `reportError` and still consumed, so a broken attachment cannot leave the
 * message unseen and reprocessed on every poll.
 */
export async function tryIngestDmarcEmail(parsed: ParsedMail, uid: number): Promise<boolean> {
  const subjectMatches = isDmarcSubject(parsed.subject ?? "");
  const attachments = parsed.attachments ?? [];
  const att = attachments.find(looksLikeReportAttachment);

  if (!subjectMatches && !att) return false;

  if (!att) {
    dmarcStatus.lastError = `UID ${uid}: DMARC subject with no report attachment`;
    log.warn(`[${LOG_PREFIX}] UID ${uid} has a DMARC subject but no report attachment`);
    reportError(
      "dmarc-monitor:attachment",
      `DMARC report email UID ${uid} has no decompressible attachment (subject: ${parsed.subject ?? ""})`,
      new Error("no report attachment"),
    ).catch(() => {});
    return true;
  }

  // Denylist, pre-parse: a From header is forgeable, so this stops a repeat
  // lazy offender rather than authenticating anything — see isBlockedSender.
  const fromAddrs = (parsed.from?.value ?? [])
    .map((a) => (a.address ?? "").toLowerCase())
    .filter(Boolean);
  const blockedFrom = isBlockedSender(fromAddrs);
  if (blockedFrom) {
    dmarcStatus.blockedSenders++;
    log.warn(`[${LOG_PREFIX}] UID ${uid} dropped — sender matched denylist entry "${blockedFrom}"`);
    return true;
  }

  // Ingest rate limit, counted before decompression so unparseable junk is
  // throttled too — a flood of garbage attachments must not bypass the cap.
  const now = Date.now();
  if (sweep(recentIngests, now) >= MAX_REPORTS_PER_WINDOW) {
    dmarcStatus.throttledReports++;
    dmarcStatus.lastThrottleAt = new Date(now).toISOString();
    log.warn(`[${LOG_PREFIX}] UID ${uid} throttled — ingest rate limit tripped`);
    try {
      await raiseRateLimitAlert(
        "ingest",
        `More than ${MAX_REPORTS_PER_WINDOW} report emails arrived in the last ${RATE_WINDOW_MS / 60000} minutes. Most recent throttled UID: ${uid}, from: ${fromAddrs.join(", ") || "(unknown)"}.`,
      );
    } catch (err) {
      log.error(`[${LOG_PREFIX}] failed to raise rate-limit alert: ${err}`);
    }
    return true;
  }
  recentIngests.push(now);

  let report: DmarcReport;
  let xml: string;
  try {
    if (att.content.length > MAX_ATTACHMENT_BYTES) {
      throw new Error(`attachment is ${att.content.length} bytes, over the ${MAX_ATTACHMENT_BYTES} byte cap`);
    }
    xml = decompressReportAttachment(att.content);
    report = parseDmarcReport(xml);
  } catch (err) {
    dmarcStatus.lastError = `UID ${uid}: ${err}`;
    log.error(`[${LOG_PREFIX}] Failed to parse DMARC report from UID ${uid}: ${err}`);
    reportError(
      "dmarc-monitor:parse",
      `Failed to parse DMARC report from UID ${uid} (${att.filename ?? "unnamed attachment"})`,
      err,
    ).catch(() => {});
    return true;
  }

  // Denylist, post-parse: the report's own metadata email can differ from the
  // envelope From (e.g. a forwarder), so check it separately before any DB write.
  const blockedReportEmail = isBlockedSender([report.reportEmail]);
  if (blockedReportEmail) {
    dmarcStatus.blockedSenders++;
    log.warn(
      `[${LOG_PREFIX}] UID ${uid} dropped — report_metadata/email matched denylist entry "${blockedReportEmail}"`,
    );
    return true;
  }

  // Captured before the insert — the "previous report" comparison must not see
  // the report currently being ingested.
  const prev = getLatestDmarcReportForDomain(report.domain);
  const storedXml =
    xml.length > MAX_STORED_XML_BYTES
      ? xml.slice(0, MAX_STORED_XML_BYTES) +
        "\n<!-- truncated by claws: report exceeded " + MAX_STORED_XML_BYTES + " bytes -->"
      : xml;
  const inserted = insertDmarcReport(report, storedXml, new Date().toISOString());
  if (!inserted) {
    log.info(`[${LOG_PREFIX}] duplicate report ${report.orgName}/${report.reportId} — ignored`);
    return true;
  }

  dmarcStatus.lastIngestAt = new Date().toISOString();
  dmarcStatus.lastError = null;
  dmarcStatus.reportsIngested++;
  log.info(
    `[${LOG_PREFIX}] Ingested report ${report.orgName}/${report.reportId} for ${report.domain} (${report.rows.length} row(s)` +
      (report.truncatedRows > 0 ? `, ${report.truncatedRows} truncated` : "") +
      ")",
  );

  try {
    await alertOnReport(report, prev);
  } catch (err) {
    log.error(`[${LOG_PREFIX}] Alerting failed for ${report.orgName}/${report.reportId}: ${err}`);
    reportError(
      "dmarc-monitor:alert",
      `Failed to raise DMARC alerts for report ${report.reportId} (${report.domain})`,
      err,
    ).catch(() => {});
  }
  return true;
}
