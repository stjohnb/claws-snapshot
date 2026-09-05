import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Attachment, ParsedMail } from "mailparser";
import type { DmarcReportRow } from "../db.js";

const { mockConfig } = vi.hoisted(() => ({
  mockConfig: {
    DASHBOARD_URL: "https://dash.example.com",
    LABELS: { priority: "Priority", manualAction: "Manual Action" },
    SELF_REPO: "test-org/claws",
    WHATSAPP_ALLOWED_NUMBERS: ["441234567890"],
    DMARC_BLOCKED_SENDERS: [] as string[],
  },
}));

vi.mock("../config.js", () => mockConfig);

vi.mock("../log.js", () => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));

const { mockReportError } = vi.hoisted(() => ({
  mockReportError: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../error-reporter.js", () => ({
  reportError: mockReportError,
}));

const { mockDb } = vi.hoisted(() => ({
  mockDb: {
    getLatestDmarcReportForDomain: vi.fn(),
    insertDmarcReport: vi.fn(),
  },
}));
vi.mock("../db.js", () => mockDb);

const { mockUpsertAlertIssue } = vi.hoisted(() => ({
  mockUpsertAlertIssue: vi.fn().mockResolvedValue("created"),
}));
vi.mock("../occurrence-tracking.js", () => ({
  upsertAlertIssue: mockUpsertAlertIssue,
}));

const { mockSendMessage } = vi.hoisted(() => ({
  mockSendMessage: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../whatsapp.js", () => ({
  sendMessage: mockSendMessage,
}));

import { tryIngestDmarcEmail, getDmarcStatus, resetDmarcRateLimitStateForTests } from "./dmarc-monitor.js";

interface RowOpts {
  sourceIp: string;
  count: number;
  headerFrom: string;
  evalDkim: string;
  evalSpf: string;
  dkim?: Array<{ domain: string; result: string }>;
  spf?: Array<{ domain: string; result: string }>;
}

/** Build a minimal RFC 7489 aggregate report; passed straight through as bare XML (no zip/gzip needed). */
function buildReportXml(opts: {
  orgName?: string;
  reportId: string;
  domain?: string;
  begin?: number;
  end?: number;
  p?: string;
  sp?: string;
  adkim?: string;
  aspf?: string;
  pct?: number;
  rows: RowOpts[];
}): string {
  const records = opts.rows
    .map(
      (r) => `  <record>
    <row>
      <source_ip>${r.sourceIp}</source_ip>
      <count>${r.count}</count>
      <policy_evaluated>
        <disposition>none</disposition>
        <dkim>${r.evalDkim}</dkim>
        <spf>${r.evalSpf}</spf>
      </policy_evaluated>
    </row>
    <identifiers>
      <header_from>${r.headerFrom}</header_from>
    </identifiers>
    <auth_results>
      ${(r.dkim ?? [])
        .map((d) => `<dkim><domain>${d.domain}</domain><result>${d.result}</result></dkim>`)
        .join("\n      ")}
      ${(r.spf ?? [])
        .map((s) => `<spf><domain>${s.domain}</domain><result>${s.result}</result></spf>`)
        .join("\n      ")}
    </auth_results>
  </record>`,
    )
    .join("\n");

  return `<?xml version="1.0"?>
<feedback>
  <report_metadata>
    <org_name>${opts.orgName ?? "google.com"}</org_name>
    <email>noreply-dmarc-support@google.com</email>
    <report_id>${opts.reportId}</report_id>
    <date_range><begin>${opts.begin ?? 1756598400}</begin><end>${opts.end ?? 1756684799}</end></date_range>
  </report_metadata>
  <policy_published>
    <domain>${opts.domain ?? "example.com"}</domain>
    <adkim>${opts.adkim ?? "r"}</adkim>
    <aspf>${opts.aspf ?? "r"}</aspf>
    <p>${opts.p ?? "none"}</p>
    <sp>${opts.sp ?? "none"}</sp>
    <pct>${opts.pct ?? 100}</pct>
  </policy_published>
${records}
</feedback>`;
}

const ALIGNED_ROW: RowOpts = {
  sourceIp: "1.2.3.4",
  count: 5,
  headerFrom: "example.com",
  evalDkim: "pass",
  evalSpf: "pass",
  dkim: [{ domain: "example.com", result: "pass" }],
  spf: [{ domain: "example.com", result: "pass" }],
};

const SPOOF_ROW: RowOpts = {
  sourceIp: "9.9.9.9",
  count: 3,
  headerFrom: "example.com",
  evalDkim: "fail",
  evalSpf: "fail",
};

function attachment(xml: string, filename = "report.xml"): Attachment {
  return {
    filename,
    contentType: "text/xml",
    content: Buffer.from(xml, "utf8"),
  } as unknown as Attachment;
}

function mail(opts: { subject?: string; attachments?: Attachment[]; from?: string }): ParsedMail {
  return {
    subject: opts.subject,
    attachments: opts.attachments ?? [],
    from: opts.from ? { value: [{ address: opts.from }] } : undefined,
  } as unknown as ParsedMail;
}

const DMARC_SUBJECT = "Report domain: example.com Submitter: google.com Report-ID: 12345";

describe("tryIngestDmarcEmail", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDb.getLatestDmarcReportForDomain.mockReturnValue(undefined);
    mockDb.insertDmarcReport.mockReturnValue(true);
    mockConfig.DMARC_BLOCKED_SENDERS = [];
    resetDmarcRateLimitStateForTests();
  });

  it("returns false for a message with no DMARC subject and no report attachment", async () => {
    const result = await tryIngestDmarcEmail(mail({ subject: "Your organic veg box this week" }), 1);
    expect(result).toBe(false);
    expect(mockDb.insertDmarcReport).not.toHaveBeenCalled();
  });

  it("recognises a report by attachment shape alone, regardless of subject", async () => {
    const xml = buildReportXml({ reportId: "r1", rows: [ALIGNED_ROW] });
    const result = await tryIngestDmarcEmail(mail({ subject: "fwd: fyi", attachments: [attachment(xml)] }), 2);
    expect(result).toBe(true);
    expect(mockDb.insertDmarcReport).toHaveBeenCalledOnce();
  });

  it("recognises a report by subject alone, but reports an error when there is no attachment", async () => {
    const result = await tryIngestDmarcEmail(mail({ subject: DMARC_SUBJECT }), 3);
    expect(result).toBe(true);
    expect(mockDb.insertDmarcReport).not.toHaveBeenCalled();
    expect(mockReportError).toHaveBeenCalledWith(
      "dmarc-monitor:attachment",
      expect.stringContaining("UID 3"),
      expect.any(Error),
    );
    expect(getDmarcStatus().lastError).toContain("UID 3");
  });

  it("short-circuits a duplicate report with no alert", async () => {
    mockDb.insertDmarcReport.mockReturnValue(false);
    const xml = buildReportXml({ reportId: "dupe", rows: [SPOOF_ROW] });
    const result = await tryIngestDmarcEmail(mail({ subject: DMARC_SUBJECT, attachments: [attachment(xml)] }), 4);
    expect(result).toBe(true);
    expect(mockUpsertAlertIssue).not.toHaveBeenCalled();
    expect(mockSendMessage).not.toHaveBeenCalled();
  });

  it("stays silent when every row is aligned_pass or forwarded and the policy hasn't changed", async () => {
    const xml = buildReportXml({ reportId: "clean", rows: [ALIGNED_ROW] });
    await tryIngestDmarcEmail(mail({ subject: DMARC_SUBJECT, attachments: [attachment(xml)] }), 5);
    expect(mockUpsertAlertIssue).not.toHaveBeenCalled();
    expect(mockSendMessage).not.toHaveBeenCalled();
  });

  it("batches all rows needing review into a single alert issue and a single WhatsApp notification", async () => {
    const xml = buildReportXml({ reportId: "spoofy", rows: [ALIGNED_ROW, SPOOF_ROW, SPOOF_ROW] });
    await tryIngestDmarcEmail(mail({ subject: DMARC_SUBJECT, attachments: [attachment(xml)] }), 6);

    expect(mockUpsertAlertIssue).toHaveBeenCalledOnce();
    const call = mockUpsertAlertIssue.mock.calls[0][0];
    expect(call.title).toContain("example.com");
    expect(call.body).toContain("9.9.9.9");
    expect((call.body.match(/9\.9\.9\.9/g) ?? []).length).toBe(2);
    expect(call.body).not.toContain("1.2.3.4");
    expect(mockSendMessage).toHaveBeenCalledOnce();
  });

  it("raises a separate policy-drift alert when the published policy changes", async () => {
    const prev: DmarcReportRow = {
      org_name: "google.com",
      report_id: "prev",
      report_email: "noreply-dmarc-support@google.com",
      domain: "example.com",
      date_begin: "2026-08-01T00:00:00.000Z",
      date_end: "2026-08-01T23:59:59.000Z",
      policy_p: "none",
      policy_sp: "none",
      policy_adkim: "r",
      policy_aspf: "r",
      policy_pct: 100,
      row_count: 1,
      received_at: "2026-08-01T00:00:00.000Z",
    };
    mockDb.getLatestDmarcReportForDomain.mockReturnValue(prev);

    const xml = buildReportXml({ reportId: "drifted", p: "quarantine", rows: [ALIGNED_ROW] });
    await tryIngestDmarcEmail(mail({ subject: DMARC_SUBJECT, attachments: [attachment(xml)] }), 7);

    expect(mockUpsertAlertIssue).toHaveBeenCalledOnce();
    const call = mockUpsertAlertIssue.mock.calls[0][0];
    expect(call.title).toContain("Published policy changed");
    expect(call.body).toContain("quarantine");
  });

  it("does not raise a policy-drift alert when the published policy is unchanged", async () => {
    const prev: DmarcReportRow = {
      org_name: "google.com",
      report_id: "prev",
      report_email: "noreply-dmarc-support@google.com",
      domain: "example.com",
      date_begin: "2026-08-01T00:00:00.000Z",
      date_end: "2026-08-01T23:59:59.000Z",
      policy_p: "none",
      policy_sp: "none",
      policy_adkim: "r",
      policy_aspf: "r",
      policy_pct: 100,
      row_count: 1,
      received_at: "2026-08-01T00:00:00.000Z",
    };
    mockDb.getLatestDmarcReportForDomain.mockReturnValue(prev);

    const xml = buildReportXml({ reportId: "stable", rows: [ALIGNED_ROW] });
    await tryIngestDmarcEmail(mail({ subject: DMARC_SUBJECT, attachments: [attachment(xml)] }), 8);

    expect(mockUpsertAlertIssue).not.toHaveBeenCalled();
  });

  it("never throws on an undecompressable attachment, and reports it instead", async () => {
    const bad = attachment("not xml at all <<<", "report.xml");
    const result = await tryIngestDmarcEmail(mail({ subject: DMARC_SUBJECT, attachments: [bad] }), 9);
    expect(result).toBe(true);
    expect(mockDb.insertDmarcReport).not.toHaveBeenCalled();
    expect(mockReportError).toHaveBeenCalledWith(
      "dmarc-monitor:parse",
      expect.stringContaining("UID 9"),
      expect.anything(),
    );
  });

  it("drops a report from a denylisted From domain before parsing or storing", async () => {
    mockConfig.DMARC_BLOCKED_SENDERS = ["evil.example"];
    const xml = buildReportXml({ reportId: "denied", rows: [ALIGNED_ROW] });
    const result = await tryIngestDmarcEmail(
      mail({ subject: DMARC_SUBJECT, attachments: [attachment(xml)], from: "attacker@evil.example" }),
      10,
    );
    expect(result).toBe(true);
    expect(mockDb.insertDmarcReport).not.toHaveBeenCalled();
    expect(getDmarcStatus().blockedSenders).toBe(1);
  });

  it("throttles ingestion once the rolling window exceeds MAX_REPORTS_PER_WINDOW", async () => {
    for (let i = 0; i < 51; i++) {
      const xml = buildReportXml({ reportId: `window-${i}`, rows: [ALIGNED_ROW] });
      await tryIngestDmarcEmail(mail({ subject: DMARC_SUBJECT, attachments: [attachment(xml)] }), 100 + i);
    }
    expect(mockDb.insertDmarcReport).toHaveBeenCalledTimes(50);
    expect(getDmarcStatus().throttledReports).toBe(1);
  });

  it("caps domain-titled alert issues per window and files one fixed flood title instead", async () => {
    for (let i = 0; i < 6; i++) {
      const xml = buildReportXml({ reportId: `spoof-${i}`, domain: `spoof${i}.example`, rows: [SPOOF_ROW] });
      await tryIngestDmarcEmail(mail({ subject: DMARC_SUBJECT, attachments: [attachment(xml)] }), 200 + i);
    }
    const titles = mockUpsertAlertIssue.mock.calls.map((call) => call[0].title as string);
    const domainTitled = titles.filter((t) => t.startsWith("[dmarc] Unauthenticated"));
    expect(domainTitled.length).toBeLessThanOrEqual(5);
    expect(titles).toContain("[dmarc] Ingestion rate limit tripped");
  });

  it("truncates stored raw_xml over the cap while still inserting the report", async () => {
    const bigRows = Array.from({ length: 3000 }, () => ALIGNED_ROW);
    const xml = buildReportXml({ reportId: "big-xml", rows: bigRows });
    expect(xml.length).toBeGreaterThan(256 * 1024);

    await tryIngestDmarcEmail(mail({ subject: DMARC_SUBJECT, attachments: [attachment(xml)] }), 300);

    expect(mockDb.insertDmarcReport).toHaveBeenCalledOnce();
    const storedXml = mockDb.insertDmarcReport.mock.calls[0][1] as string;
    expect(storedXml.length).toBeLessThan(xml.length);
    expect(storedXml).toMatch(/truncated by claws/);
  });
});
