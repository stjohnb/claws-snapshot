import * as zlib from "node:zlib";

/**
 * Pure DMARC aggregate-report parsing: attachment decompression, a minimal XML
 * reader for the RFC 7489 `<feedback>` schema, and per-row verdict
 * classification. No I/O, no DB, no GitHub — `src/jobs/dmarc-monitor.ts` owns
 * all of that so this module stays trivially testable.
 *
 * The XML is a fixed, attribute-free schema and the `.zip` container is always
 * a single-entry archive, so this deliberately avoids adding an XML/zip
 * dependency for what `node:zlib` plus ~100 lines already covers.
 *
 * Every input this module parses originates from an unauthenticated internet
 * sender — the `rua=` mailbox address is published in public `_dmarc` DNS
 * records, so anyone can email it a crafted attachment. All limits below are
 * hard failures, not warnings.
 */

/** Reject anything larger than this after decompression. Real aggregate reports for domains this operator publishes DMARC records for are tens of KB; 5 MB is already ~100x headroom, and every byte past it is an untrusted sender's choice. */
const MAX_XML_BYTES = 5_000_000;
/** A crafted archive can inflate ~1000x; legitimate report XML compresses ~20-50x. */
const MAX_COMPRESSION_RATIO = 200;
/** Ratio is meaningless on small payloads — only apply it once output is large. */
const RATIO_FLOOR_BYTES = 256 * 1024;
/** One synchronous better-sqlite3 transaction inserts one row per <record>; cap it so a forged report cannot block the event loop. */
export const MAX_ROWS_PER_REPORT = 1000;
/** A single <record> with thousands of <dkim>/<spf> children would blow up JSON.stringify on insert. */
const MAX_AUTH_RESULTS_PER_ROW = 50;

// ── Attachment decompression ────────────────────────────────────────────────

/** Normalise zlib's `maxOutputLength` overflow into the same error the post-hoc length check throws. */
function tooLarge(err: unknown): boolean {
  return (err as NodeJS.ErrnoException).code === "ERR_BUFFER_TOO_LARGE";
}

/**
 * Read the single entry out of a zip archive using the *central directory*
 * rather than the local file header: reporters that stream their archives
 * write zero sizes into the local header and defer them to a data descriptor,
 * so trusting the local header yields an empty entry.
 */
export function unzipSingleEntry(buf: Buffer): string {
  // End Of Central Directory record: scan backwards, bounded by the maximum
  // comment length (65535) plus the 22-byte record itself.
  let eocd = -1;
  const minStart = Math.max(0, buf.length - 65557);
  for (let i = buf.length - 22; i >= minStart; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd === -1) throw new Error("zip: no EOCD");

  // Every real reporter sends exactly one file; a multi-entry archive is a
  // bomb shape (e.g. many entries pointing at overlapping data).
  const entries = buf.readUInt16LE(eocd + 10);
  if (entries !== 1) throw new Error("zip: expected a single entry, got " + entries);

  const cdOffset = buf.readUInt32LE(eocd + 16);
  // ZIP64 sentinel — a real single-file DMARC report never needs the ZIP64
  // extension (entries === 0xffff is already excluded by the single-entry
  // check above), so rather than parse the ZIP64 locator/EOCD, refuse it outright.
  if (cdOffset === 0xffffffff) {
    throw new Error("zip: zip64 archives are not accepted");
  }
  if (cdOffset + 46 > buf.length || buf.readUInt32LE(cdOffset) !== 0x02014b50) {
    throw new Error("zip: bad central directory");
  }
  const method = buf.readUInt16LE(cdOffset + 10);
  const compSize = buf.readUInt32LE(cdOffset + 20);
  const localOffset = buf.readUInt32LE(cdOffset + 42);

  if (localOffset + 30 > buf.length || buf.readUInt32LE(localOffset) !== 0x04034b50) {
    throw new Error("zip: bad local header");
  }
  // The local header carries its own name/extra lengths, which can differ from
  // the central directory's — always use these to find the data start.
  const dataStart =
    localOffset + 30 + buf.readUInt16LE(localOffset + 26) + buf.readUInt16LE(localOffset + 28);
  // `subarray` silently clamps an out-of-range end, which would otherwise let
  // a crafted compSize read past the archive as if it were valid entry data.
  if (compSize === 0xffffffff || dataStart + compSize > buf.length) {
    throw new Error("zip: entry runs past end of archive");
  }
  const data = buf.subarray(dataStart, dataStart + compSize);

  if (method === 8) {
    try {
      return zlib.inflateRawSync(data, { maxOutputLength: MAX_XML_BYTES }).toString("utf8");
    } catch (err) {
      if (tooLarge(err)) throw new Error("dmarc: decompressed report too large");
      throw err;
    }
  }
  if (method === 0) return data.toString("utf8");
  throw new Error("zip: unsupported method " + method);
}

/**
 * Decompress a report attachment, sniffing the magic bytes rather than
 * trusting the filename — reporters disagree on extensions and Gmail
 * forwarding can rewrite content types.
 *
 * `maxOutputLength` bounds the decompressor itself (it throws
 * `ERR_BUFFER_TOO_LARGE` once the growing output buffer exceeds the cap)
 * rather than letting a pathological ratio fully inflate before a
 * post-hoc length check ever runs.
 */
export function decompressReportAttachment(buf: Buffer): string {
  let xml: string;
  if (buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b) {
    try {
      xml = zlib.gunzipSync(buf, { maxOutputLength: MAX_XML_BYTES }).toString("utf8");
    } catch (err) {
      if (tooLarge(err)) throw new Error("dmarc: decompressed report too large");
      throw err;
    }
  } else if (buf.length >= 2 && buf[0] === 0x50 && buf[1] === 0x4b) {
    xml = unzipSingleEntry(buf);
  } else {
    xml = buf.toString("utf8");
  }
  if (xml.length > MAX_XML_BYTES) throw new Error("dmarc: decompressed report too large");
  // The bare-XML path has ratio 1 (buf.length === xml.length), so it never trips this.
  if (xml.length > RATIO_FLOOR_BYTES && xml.length > buf.length * MAX_COMPRESSION_RATIO) {
    throw new Error(
      `dmarc: compression ratio ${Math.round(xml.length / buf.length)}:1 exceeds ${MAX_COMPRESSION_RATIO}:1 — treated as a zip bomb`,
    );
  }
  return xml;
}

// ── Minimal XML reader ──────────────────────────────────────────────────────

export interface XmlNode {
  children: Map<string, XmlNode[]>;
  text: string;
}

function newNode(): XmlNode {
  return { children: new Map(), text: "" };
}

const ENTITIES: Record<string, string> = {
  lt: "<",
  gt: ">",
  amp: "&",
  quot: '"',
  apos: "'",
};

function decodeEntities(s: string): string {
  return s.replace(/&(#\d+|#x[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, ref: string) => {
    if (ref.startsWith("#x") || ref.startsWith("#X")) {
      return String.fromCodePoint(parseInt(ref.slice(2), 16));
    }
    if (ref.startsWith("#")) return String.fromCodePoint(parseInt(ref.slice(1), 10));
    return ENTITIES[ref.toLowerCase()] ?? match;
  });
}

const TOKEN_RE = /<\/([A-Za-z_][\w.:-]*)\s*>|<([A-Za-z_][\w.:-]*)([^>]*?)(\/?)>|([^<]+)/g;

/**
 * Parse XML into a nested node tree, discarding attributes (DMARC aggregate
 * reports use none). Malformed input throws rather than silently yielding an
 * empty tree, so a truncated attachment surfaces as a parse error.
 */
export function parseXml(xml: string): XmlNode {
  const stripped = xml
    .replace(/<\?[\s\S]*?\?>/g, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<!DOCTYPE[^>]*>/gi, "");

  const root = newNode();
  const stack: XmlNode[] = [root];
  const names: string[] = [];
  TOKEN_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TOKEN_RE.exec(stripped)) !== null) {
    const [, closeName, openName, , selfClose, text] = m;
    if (closeName !== undefined) {
      if (names.length === 0) throw new Error(`xml: unexpected closing tag </${closeName}>`);
      if (names[names.length - 1] !== closeName) {
        throw new Error(`xml: mismatched closing tag </${closeName}>`);
      }
      names.pop();
      stack.pop();
    } else if (openName !== undefined) {
      const node = newNode();
      const parent = stack[stack.length - 1];
      const siblings = parent.children.get(openName);
      if (siblings) siblings.push(node);
      else parent.children.set(openName, [node]);
      if (selfClose !== "/") {
        stack.push(node);
        names.push(openName);
      }
    } else if (text !== undefined) {
      stack[stack.length - 1].text += decodeEntities(text);
    }
  }
  if (stack.length !== 1) throw new Error("xml: unclosed tags");
  return root;
}

export function kid(n: XmlNode | undefined, name: string): XmlNode | undefined {
  return n?.children.get(name)?.[0];
}

export function kids(n: XmlNode | undefined, name: string): XmlNode[] {
  return n?.children.get(name) ?? [];
}

export function txt(n: XmlNode | undefined, name: string): string {
  return kid(n, name)?.text.trim() ?? "";
}

// ── Report model ────────────────────────────────────────────────────────────

export type DmarcVerdict = "aligned_pass" | "spoof" | "unaligned_pass" | "forwarded" | "unknown";

export interface DmarcAuthResult {
  domain: string;
  selector?: string;
  scope?: string;
  result: string;
}

export interface DmarcParsedRow {
  sourceIp: string;
  count: number;
  disposition: string;
  evalDkim: string;
  evalSpf: string;
  headerFrom: string;
  envelopeFrom: string;
  envelopeTo: string;
  dkimResults: DmarcAuthResult[];
  spfResults: DmarcAuthResult[];
  reasons: Array<{ type: string; comment: string }>;
  verdict: DmarcVerdict;
}

export interface DmarcReport {
  orgName: string;
  reportId: string;
  reportEmail: string;
  domain: string;
  /** ISO-8601 UTC — converted from the report's epoch seconds so the column sorts lexicographically. */
  dateBegin: string;
  dateEnd: string;
  policyP: string;
  policySp: string;
  policyAdkim: string;
  policyAspf: string;
  policyPct: number | null;
  rows: DmarcParsedRow[];
  /** `<record>` elements dropped by `MAX_ROWS_PER_REPORT`; non-zero means a suspiciously large report. */
  truncatedRows: number;
}

function epochToIso(sec: string): string {
  const n = Number(sec);
  if (!Number.isFinite(n)) return "";
  return new Date(n * 1000).toISOString();
}

/** Relaxed alignment allows an organisational-domain relationship; strict requires an exact match. */
function aligned(candidate: string, headerFrom: string, mode: string): boolean {
  if (!candidate || !headerFrom) return false;
  if (mode === "s") return candidate === headerFrom;
  return (
    candidate === headerFrom ||
    candidate.endsWith("." + headerFrom) ||
    headerFrom.endsWith("." + candidate)
  );
}

/**
 * Classify a row so alerting and the dashboard never have to re-read the XML.
 *
 * - `spoof` — nothing authenticated at all
 * - `forwarded` — DKIM aligned but SPF broke (normal for forwarded mail)
 * - `aligned_pass` — DMARC passed on an aligned identity
 * - `unaligned_pass` — authenticated only on an unaligned identity; the case
 *   that must be resolved before tightening a policy to `p=reject`
 * - `unknown` — anything else
 */
export function classifyRow(
  row: Omit<DmarcParsedRow, "verdict">,
  policyAdkim: string,
  policyAspf: string,
): DmarcVerdict {
  const headerFrom = row.headerFrom;
  const dkimPassing = row.dkimResults.filter((r) => r.result === "pass");
  const spfPassing = row.spfResults.filter((r) => r.result === "pass");
  const dkimAligned = dkimPassing.some((r) => aligned(r.domain, headerFrom, policyAdkim));
  const spfAligned = spfPassing.some((r) => aligned(r.domain, headerFrom, policyAspf));
  const dmarcPass = row.evalDkim === "pass" || row.evalSpf === "pass";

  if (dkimPassing.length === 0 && spfPassing.length === 0) return "spoof";
  if (dkimAligned && spfPassing.length === 0) return "forwarded";
  if (dmarcPass && (dkimAligned || spfAligned)) return "aligned_pass";
  if (!dkimAligned && !spfAligned) return "unaligned_pass";
  return "unknown";
}

/** Parse an RFC 7489 aggregate report. Throws when the document is not a `<feedback>` report. */
export function parseDmarcReport(xml: string): DmarcReport {
  const root = parseXml(xml);
  const feedback = kid(root, "feedback");
  if (!feedback) throw new Error("not a DMARC aggregate report");

  const meta = kid(feedback, "report_metadata");
  const range = kid(meta, "date_range");
  const policy = kid(feedback, "policy_published");

  const policyAdkim = txt(policy, "adkim").toLowerCase();
  const policyAspf = txt(policy, "aspf").toLowerCase();
  const pctRaw = txt(policy, "pct");
  const pct = pctRaw === "" || !Number.isFinite(Number(pctRaw)) ? null : Number(pctRaw);

  const rows: DmarcParsedRow[] = [];
  let truncated = 0;
  for (const record of kids(feedback, "record")) {
    if (rows.length >= MAX_ROWS_PER_REPORT) {
      truncated++;
      continue;
    }
    const row = kid(record, "row");
    const evaluated = kid(row, "policy_evaluated");
    const identifiers = kid(record, "identifiers");
    const auth = kid(record, "auth_results");

    const base: Omit<DmarcParsedRow, "verdict"> = {
      sourceIp: txt(row, "source_ip"),
      count: Number(txt(row, "count")) || 0,
      disposition: txt(evaluated, "disposition").toLowerCase(),
      evalDkim: txt(evaluated, "dkim").toLowerCase(),
      evalSpf: txt(evaluated, "spf").toLowerCase(),
      headerFrom: txt(identifiers, "header_from").toLowerCase(),
      envelopeFrom: txt(identifiers, "envelope_from").toLowerCase(),
      envelopeTo: txt(identifiers, "envelope_to").toLowerCase(),
      dkimResults: kids(auth, "dkim")
        .slice(0, MAX_AUTH_RESULTS_PER_ROW)
        .map((d) => {
          const selector = txt(d, "selector");
          return {
            domain: txt(d, "domain").toLowerCase(),
            ...(selector ? { selector } : {}),
            result: txt(d, "result").toLowerCase(),
          };
        }),
      spfResults: kids(auth, "spf")
        .slice(0, MAX_AUTH_RESULTS_PER_ROW)
        .map((s) => {
          const scope = txt(s, "scope");
          return {
            domain: txt(s, "domain").toLowerCase(),
            ...(scope ? { scope } : {}),
            result: txt(s, "result").toLowerCase(),
          };
        }),
      reasons: kids(evaluated, "reason")
        .slice(0, MAX_AUTH_RESULTS_PER_ROW)
        .map((r) => ({
          type: txt(r, "type"),
          comment: txt(r, "comment"),
        })),
    };
    rows.push({ ...base, verdict: classifyRow(base, policyAdkim, policyAspf) });
  }

  return {
    orgName: txt(meta, "org_name"),
    reportId: txt(meta, "report_id"),
    reportEmail: txt(meta, "email"),
    domain: txt(policy, "domain").toLowerCase(),
    dateBegin: epochToIso(txt(range, "begin")),
    dateEnd: epochToIso(txt(range, "end")),
    policyP: txt(policy, "p").toLowerCase(),
    policySp: txt(policy, "sp").toLowerCase(),
    policyAdkim,
    policyAspf,
    truncatedRows: truncated,
    policyPct: pct,
    rows,
  };
}

/** RFC 7489 §7.2.1.1 aggregate-report subject. Reporter addresses vary, subjects don't. */
export function isDmarcSubject(subject: string): boolean {
  return /^\s*Report domain:\s*\S+\s+Submitter:\s*\S+\s+Report-ID:\s*\S+/i.test(subject);
}
