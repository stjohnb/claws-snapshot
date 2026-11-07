import { describe, it, expect } from "vitest";
import { buildDmarcPage } from "./dmarc.js";
import type { DmarcReportRow, DmarcRowRow, DmarcSourceIpRow } from "../db.js";

const report: DmarcReportRow = {
  org_name: "google.com",
  report_id: "1",
  report_email: "noreply-dmarc@google.com",
  domain: "example.com",
  date_begin: "2026-01-01T00:00:00Z",
  date_end: "2026-01-02T00:00:00Z",
  policy_p: "reject",
  policy_sp: "reject",
  policy_adkim: "r",
  policy_aspf: "r",
  policy_pct: 100,
  row_count: 3,
  received_at: "2026-01-02T01:00:00Z",
};

const sourceIp: DmarcSourceIpRow = {
  source_ip: "1.2.3.4",
  verdict: "aligned_pass",
  domain: "example.com",
  messages: 5,
  last_seen: "2026-01-02T00:00:00Z",
};

const row: DmarcRowRow = {
  id: 1,
  org_name: "google.com",
  report_id: "1",
  row_index: 0,
  domain: "example.com",
  date_begin: "2026-01-01T00:00:00Z",
  date_end: "2026-01-02T00:00:00Z",
  source_ip: "1.2.3.4",
  count: 2,
  disposition: "none",
  eval_dkim: "pass",
  eval_spf: "pass",
  header_from: "example.com",
  envelope_from: "example.com",
  envelope_to: "",
  dkim_results: "[]",
  spf_results: "[]",
  reasons: "",
  verdict: "aligned_pass",
  received_at: "2026-01-02T01:00:00Z",
};

describe("buildDmarcPage tables", () => {
  it("renders all tables as data-cards with data-label on the first data cell", () => {
    const html = buildDmarcPage(
      [report],
      [{ domain: "example.com", verdict: "aligned_pass", n: 3 }],
      [{ domain: "example.com", verdict: "aligned_pass", n: 10 }],
      [sourceIp],
      [row],
      "light",
    );
    expect(html).toContain('class="data-cards"');
    expect(html).toContain('class="data-cards data-cards-wide"');
    expect(html).toContain('data-label="Domain"');
    expect(html).toContain('data-label="Source IP"');
  });
});
