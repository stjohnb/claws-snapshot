import { describe, it, expect } from "vitest";
import * as zlib from "node:zlib";
import {
  classifyRow,
  decompressReportAttachment,
  isDmarcSubject,
  parseDmarcReport,
  unzipSingleEntry,
} from "./dmarc.js";

interface FixtureRow {
  sourceIp: string;
  count: number;
  dkim: string;
  spf: string;
  headerFrom?: string;
  dkimResults?: Array<{ domain: string; selector: string; result: string }>;
  spfResults?: Array<{ domain: string; scope: string; result: string }>;
}

/** Build a `<feedback>` document in the shape Google/Microsoft actually emit. */
function fixture(opts: {
  reportId: string;
  begin: number;
  end: number;
  adkim?: string;
  aspf?: string;
  pct?: number | null;
  rows: FixtureRow[];
}): string {
  const records = opts.rows
    .map(
      (r) => `  <record>
    <row>
      <source_ip>${r.sourceIp}</source_ip>
      <count>${r.count}</count>
      <policy_evaluated>
        <disposition>none</disposition>
        <dkim>${r.dkim}</dkim>
        <spf>${r.spf}</spf>
      </policy_evaluated>
    </row>
    <identifiers>
      <header_from>${r.headerFrom ?? "bstjohn.net"}</header_from>
    </identifiers>
    <auth_results>
${(r.dkimResults ?? [])
  .map(
    (d) => `      <dkim>
        <domain>${d.domain}</domain>
        <selector>${d.selector}</selector>
        <result>${d.result}</result>
      </dkim>`,
  )
  .join("\n")}
${(r.spfResults ?? [])
  .map(
    (s) => `      <spf>
        <domain>${s.domain}</domain>
        <scope>${s.scope}</scope>
        <result>${s.result}</result>
      </spf>`,
  )
  .join("\n")}
    </auth_results>
  </record>`,
    )
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8" ?>
<feedback>
  <report_metadata>
    <org_name>google.com</org_name>
    <email>noreply-dmarc-support@google.com</email>
    <extra_contact_info>https://support.google.com/a/answer/2466580</extra_contact_info>
    <report_id>${opts.reportId}</report_id>
    <date_range>
      <begin>${opts.begin}</begin>
      <end>${opts.end}</end>
    </date_range>
  </report_metadata>
  <policy_published>
    <domain>bstjohn.net</domain>
    <adkim>${opts.adkim ?? "s"}</adkim>
    <aspf>${opts.aspf ?? "s"}</aspf>
    <p>none</p>
    <sp>none</sp>
${opts.pct === null ? "" : `    <pct>${opts.pct ?? 100}</pct>\n`}  </policy_published>
${records}
</feedback>`;
}

const ALIGNED = fixture({
  reportId: "1785249275027635048",
  begin: 1788134400,
  end: 1788220799,
  rows: [
    {
      sourceIp: "209.85.220.69",
      count: 1,
      dkim: "pass",
      spf: "pass",
      dkimResults: [
        { domain: "bstjohn.net", selector: "google", result: "pass" },
        { domain: "google.com", selector: "20251104", result: "pass" },
      ],
      spfResults: [{ domain: "bstjohn.net", scope: "mfrom", result: "pass" }],
    },
  ],
});

describe("parseDmarcReport", () => {
  it("maps report metadata and the published policy", () => {
    const report = parseDmarcReport(ALIGNED);
    expect(report.orgName).toBe("google.com");
    expect(report.reportId).toBe("1785249275027635048");
    expect(report.reportEmail).toBe("noreply-dmarc-support@google.com");
    expect(report.domain).toBe("bstjohn.net");
    expect(report.dateBegin).toBe("2026-08-31T00:00:00.000Z");
    expect(report.dateEnd).toBe("2026-08-31T23:59:59.000Z");
    expect(report.policyP).toBe("none");
    expect(report.policySp).toBe("none");
    expect(report.policyAdkim).toBe("s");
    expect(report.policyAspf).toBe("s");
    expect(report.policyPct).toBe(100);
  });

  it("maps a record's row, identifiers and auth results", () => {
    const [row] = parseDmarcReport(ALIGNED).rows;
    expect(row.sourceIp).toBe("209.85.220.69");
    expect(row.count).toBe(1);
    expect(row.disposition).toBe("none");
    expect(row.evalDkim).toBe("pass");
    expect(row.evalSpf).toBe("pass");
    expect(row.headerFrom).toBe("bstjohn.net");
    expect(row.dkimResults).toEqual([
      { domain: "bstjohn.net", selector: "google", result: "pass" },
      { domain: "google.com", selector: "20251104", result: "pass" },
    ]);
    expect(row.spfResults).toEqual([{ domain: "bstjohn.net", scope: "mfrom", result: "pass" }]);
    expect(row.reasons).toEqual([]);
  });

  it("stores a missing pct as null", () => {
    const report = parseDmarcReport(fixture({ reportId: "x", begin: 1788134400, end: 1788220799, pct: null, rows: [] }));
    expect(report.policyPct).toBeNull();
  });

  it("accepts a report with zero records", () => {
    expect(parseDmarcReport(fixture({ reportId: "x", begin: 1, end: 2, rows: [] })).rows).toEqual([]);
  });

  it("throws on XML that is not a feedback document", () => {
    expect(() => parseDmarcReport("<html><body>hello</body></html>")).toThrow(
      "not a DMARC aggregate report",
    );
  });

  it("throws on malformed XML rather than returning an empty tree", () => {
    expect(() => parseDmarcReport("<feedback><report_metadata></feedback>")).toThrow(/xml:/);
  });

  it("caps rows at MAX_ROWS_PER_REPORT and reports the rest as truncated", () => {
    const rows: FixtureRow[] = Array.from({ length: 1200 }, (_, i) => ({
      sourceIp: `10.0.${Math.floor(i / 256)}.${i % 256}`,
      count: 1,
      dkim: "pass",
      spf: "pass",
    }));
    const report = parseDmarcReport(
      fixture({ reportId: "huge", begin: 1788134400, end: 1788220799, rows }),
    );
    expect(report.rows.length).toBe(1000);
    expect(report.truncatedRows).toBe(200);
  });

  it("caps auth results per row at MAX_AUTH_RESULTS_PER_ROW", () => {
    const dkimResults = Array.from({ length: 100 }, (_, i) => ({
      domain: "bstjohn.net",
      selector: `s${i}`,
      result: "pass",
    }));
    const [row] = parseDmarcReport(
      fixture({
        reportId: "many-dkim",
        begin: 1788134400,
        end: 1788220799,
        rows: [{ sourceIp: "1.2.3.4", count: 1, dkim: "pass", spf: "pass", dkimResults }],
      }),
    ).rows;
    expect(row.dkimResults.length).toBe(50);
  });
});

describe("verdict classification", () => {
  it("classifies a fully aligned Google row as aligned_pass", () => {
    expect(parseDmarcReport(ALIGNED).rows[0].verdict).toBe("aligned_pass");
  });

  it("classifies a row with no passing auth results as spoof", () => {
    const xml = fixture({
      reportId: "spoof-1",
      begin: 1787961600,
      end: 1788047999,
      rows: [
        {
          sourceIp: "181.66.138.209",
          count: 1,
          dkim: "fail",
          spf: "fail",
          spfResults: [{ domain: "bstjohn.net", scope: "mfrom", result: "softfail" }],
        },
      ],
    });
    const [row] = parseDmarcReport(xml).rows;
    expect(row.sourceIp).toBe("181.66.138.209");
    expect(row.verdict).toBe("spoof");
  });

  it("classifies a DKIM-only pass on an unaligned domain as unaligned_pass under adkim=s", () => {
    const xml = fixture({
      reportId: "unaligned-1",
      begin: 1787702400,
      end: 1787788799,
      rows: [
        {
          sourceIp: "209.85.220.41",
          count: 1,
          dkim: "fail",
          spf: "fail",
          dkimResults: [
            { domain: "bstjohn-net.20251104.gappssmtp.com", selector: "20251104", result: "pass" },
          ],
          spfResults: [{ domain: "bstjohn.net", scope: "mfrom", result: "fail" }],
        },
      ],
    });
    expect(parseDmarcReport(xml).rows[0].verdict).toBe("unaligned_pass");
  });

  it("still classifies the gappssmtp.com DKIM domain as unaligned_pass under adkim=r", () => {
    const xml = fixture({
      reportId: "unaligned-2",
      begin: 1787702400,
      end: 1787788799,
      adkim: "r",
      aspf: "r",
      rows: [
        {
          sourceIp: "209.85.220.41",
          count: 1,
          dkim: "fail",
          spf: "fail",
          dkimResults: [
            { domain: "bstjohn-net.20251104.gappssmtp.com", selector: "20251104", result: "pass" },
          ],
          spfResults: [{ domain: "bstjohn.net", scope: "mfrom", result: "fail" }],
        },
      ],
    });
    expect(parseDmarcReport(xml).rows[0].verdict).toBe("unaligned_pass");
  });

  it("classifies an aligned DKIM pass with a failing SPF as forwarded", () => {
    const xml = fixture({
      reportId: "forwarded-1",
      begin: 1787702400,
      end: 1787788799,
      rows: [
        {
          sourceIp: "198.51.100.7",
          count: 3,
          dkim: "pass",
          spf: "fail",
          dkimResults: [{ domain: "bstjohn.net", selector: "google", result: "pass" }],
          spfResults: [{ domain: "forwarder.example", scope: "mfrom", result: "fail" }],
        },
      ],
    });
    expect(parseDmarcReport(xml).rows[0].verdict).toBe("forwarded");
  });

  it("never treats an empty header_from as aligned", () => {
    const verdict = classifyRow(
      {
        sourceIp: "203.0.113.5",
        count: 1,
        disposition: "none",
        evalDkim: "pass",
        evalSpf: "fail",
        headerFrom: "",
        envelopeFrom: "",
        envelopeTo: "",
        dkimResults: [{ domain: "", selector: "s", result: "pass" }],
        spfResults: [],
        reasons: [],
      },
      "r",
      "r",
    );
    expect(verdict).toBe("unaligned_pass");
  });

  it("aligns a subdomain under relaxed mode but not under strict", () => {
    const row = {
      sourceIp: "203.0.113.9",
      count: 1,
      disposition: "none",
      evalDkim: "pass",
      evalSpf: "pass",
      headerFrom: "bstjohn.net",
      envelopeFrom: "",
      envelopeTo: "",
      dkimResults: [{ domain: "mail.bstjohn.net", selector: "s", result: "pass" }],
      spfResults: [{ domain: "mail.bstjohn.net", scope: "mfrom", result: "pass" }],
      reasons: [],
    };
    expect(classifyRow(row, "r", "r")).toBe("aligned_pass");
    expect(classifyRow(row, "s", "s")).toBe("unaligned_pass");
  });
});

describe("decompressReportAttachment", () => {
  it("round-trips a gzipped report", () => {
    const buf = zlib.gzipSync(Buffer.from(ALIGNED, "utf8"));
    expect(decompressReportAttachment(buf)).toBe(ALIGNED);
  });

  it("passes a bare XML attachment through unchanged", () => {
    expect(decompressReportAttachment(Buffer.from(ALIGNED, "utf8"))).toBe(ALIGNED);
  });

  it("reads a deflated single-entry zip via the central directory", () => {
    expect(decompressReportAttachment(buildZip("report.xml", ALIGNED, 8))).toBe(ALIGNED);
  });

  it("reads a stored single-entry zip", () => {
    expect(decompressReportAttachment(buildZip("report.xml", ALIGNED, 0))).toBe(ALIGNED);
  });

  it("ignores zeroed local-header sizes written by a streaming writer", () => {
    const zip = buildZip("report.xml", ALIGNED, 8, { zeroLocalSizes: true });
    expect(decompressReportAttachment(zip)).toBe(ALIGNED);
  });

  it("rejects a gzip bomb during decompression rather than after", () => {
    // Highly compressible: a tiny gzip payload that would inflate past the cap.
    const bomb = zlib.gzipSync(Buffer.alloc(21_000_000, 0x61));
    expect(bomb.length).toBeLessThan(100_000);
    expect(() => decompressReportAttachment(bomb)).toThrow("dmarc: decompressed report too large");
  });

  it("rejects a zip bomb during decompression rather than after", () => {
    const zip = buildZip("report.xml", "a".repeat(21_000_000), 8);
    expect(() => decompressReportAttachment(zip)).toThrow("dmarc: decompressed report too large");
  });

  it("rejects a gzip payload whose compression ratio exceeds the cap", () => {
    const bomb = zlib.gzipSync(Buffer.alloc(1_000_000, 0x41));
    expect(() => decompressReportAttachment(bomb)).toThrow(/compression ratio/);
  });

  it("rejects a bare XML attachment over the size cap", () => {
    const huge = Buffer.alloc(6_000_000, 0x20);
    expect(() => decompressReportAttachment(huge)).toThrow(/too large/);
  });
});

describe("unzipSingleEntry", () => {
  it("throws when there is no end-of-central-directory record", () => {
    expect(() => unzipSingleEntry(Buffer.alloc(200, 0x41))).toThrow("zip: no EOCD");
  });

  it("rejects an oversized deflated entry during decompression", () => {
    const zip = buildZip("report.xml", "a".repeat(21_000_000), 8);
    expect(() => unzipSingleEntry(zip)).toThrow("dmarc: decompressed report too large");
  });

  it("rejects an archive whose EOCD reports more than one entry", () => {
    const zip = buildZip("report.xml", ALIGNED, 8);
    zip.writeUInt16LE(2, zip.length - 22 + 10);
    expect(() => unzipSingleEntry(zip)).toThrow(/expected a single entry, got 2/);
  });

  it("rejects a zip64 archive via the EOCD central-directory-offset sentinel", () => {
    const zip = buildZip("report.xml", ALIGNED, 8);
    zip.writeUInt32LE(0xffffffff, zip.length - 22 + 16);
    expect(() => unzipSingleEntry(zip)).toThrow("zip: zip64 archives are not accepted");
  });

  it("rejects a central-directory entry whose size runs past the archive", () => {
    const zip = buildZip("report.xml", ALIGNED, 8);
    const cdOffset = zip.readUInt32LE(zip.length - 22 + 16);
    zip.writeUInt32LE(zip.length, cdOffset + 20);
    expect(() => unzipSingleEntry(zip)).toThrow("zip: entry runs past end of archive");
  });
});

describe("isDmarcSubject", () => {
  it("matches an RFC 7489 aggregate report subject", () => {
    expect(
      isDmarcSubject("Report domain: bstjohn.net Submitter: google.com Report-ID: 1785249275027635048"),
    ).toBe(true);
  });

  it("rejects a veg box subject", () => {
    expect(isDmarcSubject("Your organic veg box this week")).toBe(false);
  });
});

/**
 * Hand-build a single-entry zip so the central-directory read is exercised
 * without pulling in a zip dependency. `zeroLocalSizes` reproduces the
 * streaming writers (Google, Microsoft) that defer sizes to a data descriptor.
 */
function buildZip(
  name: string,
  content: string,
  method: 0 | 8,
  opts: { zeroLocalSizes?: boolean } = {},
): Buffer {
  const raw = Buffer.from(content, "utf8");
  const data = method === 8 ? zlib.deflateRawSync(raw) : raw;
  const nameBuf = Buffer.from(name, "utf8");
  const crc = 0; // never validated by unzipSingleEntry

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4); // version needed
  local.writeUInt16LE(opts.zeroLocalSizes ? 0x0008 : 0, 6); // data-descriptor flag
  local.writeUInt16LE(method, 8);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(opts.zeroLocalSizes ? 0 : data.length, 18);
  local.writeUInt32LE(opts.zeroLocalSizes ? 0 : raw.length, 22);
  local.writeUInt16LE(nameBuf.length, 26);
  local.writeUInt16LE(0, 28);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(method, 10);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(raw.length, 24);
  central.writeUInt16LE(nameBuf.length, 28);
  central.writeUInt32LE(0, 42); // local header offset

  const cdOffset = local.length + nameBuf.length + data.length;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(central.length + nameBuf.length, 12);
  eocd.writeUInt32LE(cdOffset, 16);

  return Buffer.concat([local, nameBuf, data, central, nameBuf, eocd]);
}
