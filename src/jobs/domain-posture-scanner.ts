import dns from "node:dns/promises";
import tls from "node:tls";
import { parse } from "yaml";
import { z } from "zod";
import * as gh from "../github.js";
import * as log from "../log.js";
import { SELF_REPO, LABELS } from "../config.js";
import { ensureAlertIssue, closeAlertIssueIfResolved } from "../occurrence-tracking.js";
import { reportError } from "../error-reporter.js";
import { renderViolationTable } from "./scanner-runner.js";
import { retryWithBackoff } from "../retry.js";
import { mapSettledWithConcurrency } from "../util.js";

const NAME = "domain-posture-scanner";
export const MANIFEST_PATH = "docs/domains.yaml";
export const MALFORMED_ISSUE_TITLE = `[${NAME}] ${MANIFEST_PATH} could not be parsed`;

/** RDAP/DNS/TLS probes are cheap but third-party — keep fan-out well inside registry rate limits. */
const CONCURRENCY = 3;
const DAY_MS = 86_400_000;
/** Registration expiring within this many days is worth a nudge before auto-renew season. */
const EXPIRY_WARN_DAYS = 45;
/** Leaf certificate expiring within this many days means renewal has probably stalled. */
const CERT_EXPIRY_WARN_DAYS = 14;
/** RFC 6797 recommends at least six months; anything shorter barely survives a browser cache. */
const MIN_HSTS_MAX_AGE = 15_552_000; // 180 days
/** Nested RDAP entities can in principle self-reference; bound the walk. */
const MAX_ENTITY_DEPTH = 4;
const RDAP_TIMEOUT_MS = 15_000;
const WEB_FETCH_TIMEOUT_MS = 15_000;
const TLS_TIMEOUT_MS = 10_000;

/** Registries not covered by the rdap.org bootstrap (`.io` 404s there). Keyed on the last label. */
const TLD_RDAP_FALLBACKS: Record<string, string> = {
  io: "https://rdap.identitydigital.services/rdap/domain/",
};

/** Contact roles that identify the *domain owner* — deliberately excludes `registrar` and the
 *  registrar's nested `abuse` contact, which legitimately publish a real name and address. */
const OWNER_ROLES = new Set(["registrant", "administrative", "technical", "billing"]);

/** vCard properties that would identify a human if published unredacted. */
const VCARD_PROPS = new Set(["fn", "org", "email", "adr", "tel"]);

/** A vCard value matching this is the registry's redaction placeholder, not a real contact. */
const REDACTED_RE =
  /redact|privacy|withheld|not disclosed|gdpr|masked|proxy|whoisguard|data protected|anonymi[sz]ed|obscured|statutory/i;

// ── Manifest schema ──

export const DomainEntrySchema = z.object({
  domain: z.string().min(1).regex(/^[a-z0-9.-]+$/),
  project: z.string().min(1),
  web: z.array(z.string().regex(/^[a-z0-9.-]+$/)).default([]),
  ignore: z.array(z.string()).default([]),
});

export const DomainsManifestSchema = z.object({
  domains: z.array(DomainEntrySchema).default([]),
});

export type DomainEntry = z.infer<typeof DomainEntrySchema>;
export type DomainsManifest = z.infer<typeof DomainsManifestSchema>;

export type ParseDomainsManifestResult =
  | { ok: true; manifest: DomainsManifest }
  | { ok: false; error: string };

export function parseDomainsManifest(content: string): ParseDomainsManifestResult {
  let parsed: unknown;
  try {
    parsed = parse(content);
  } catch (err) {
    return { ok: false, error: `invalid YAML: ${(err as Error).message}` };
  }

  const result = DomainsManifestSchema.safeParse(parsed);
  if (!result.success) {
    const issue = result.error.issues[0]!;
    return { ok: false, error: `${issue.path.join(".")}: ${issue.message}` };
  }

  const seen = new Set<string>();
  for (const entry of result.data.domains) {
    if (seen.has(entry.domain)) return { ok: false, error: `duplicate domain "${entry.domain}"` };
    seen.add(entry.domain);
  }

  return { ok: true, manifest: result.data };
}

// ── Findings ──

export interface Finding {
  /** Stable check id, also the token matched against a domain's `ignore:` list. */
  id: string;
  severity: "high" | "medium" | "low";
  detail: string;
  fix: string;
  /** Set for web findings so a multi-host domain shows which host is affected. */
  host?: string;
}

// ── Probe facts ──

export interface RdapEntity {
  roles: string[];
  vcardArray?: unknown;
  entities?: RdapEntity[];
}

export interface RdapDomain {
  status: string[];
  secureDNS?: { delegationSigned?: boolean };
  events: { eventAction: string; eventDate: string }[];
  entities: RdapEntity[];
}

export interface DnsFacts {
  /** `[]` means the record genuinely does not exist; `null` means the lookup failed → skip the check. */
  caa: string[] | null;
  mx: string[] | null;
  txt: string[] | null;
  dmarc: string[] | null;
  /** Lookup label → DNS error code, for the queries that failed. Used to explain skipped checks. */
  errors?: Record<string, string>;
}

export interface WebFacts {
  authorized: boolean;
  authorizationError: string | null;
  /** Leaf certificate `valid_to`, as returned by `getPeerCertificate()`. */
  validTo: string | null;
  protocol: string | null;
  /** Lowercased response headers from `https://<host>`; null when that request failed. */
  headers: Record<string, string> | null;
  /** Response to `http://<host>`; null when that request failed. */
  httpRedirect: { status: number; location: string | null } | null;
}

/** Every network call the scanner makes, behind one object so `run()` is testable without a network. */
export interface Probes {
  /** null = RDAP unavailable for this domain (registry down, no bootstrap entry) — not a finding. */
  rdap(domain: string): Promise<RdapDomain | null>;
  dns(domain: string): Promise<DnsFacts>;
  /** null = host unreachable over TLS — web checks are skipped for it, not reported. */
  web(host: string): Promise<WebFacts | null>;
}

// ── RDAP ──

class RdapHttpError extends Error {
  constructor(readonly status: number) {
    super(`RDAP HTTP ${status}`);
    this.name = "RdapHttpError";
  }
}

function isTransientRdapError(err: Error): boolean {
  if (err instanceof RdapHttpError) return err.status >= 500;
  // fetch surfaces connection failures as TypeError and AbortSignal.timeout as TimeoutError.
  return err.name === "TypeError" || err.name === "TimeoutError" || err.name === "AbortError";
}

function normalizeEntity(raw: unknown, depth: number): RdapEntity | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const nested =
    depth >= MAX_ENTITY_DEPTH || !Array.isArray(o.entities)
      ? []
      : o.entities
          .map((e) => normalizeEntity(e, depth + 1))
          .filter((e): e is RdapEntity => e !== null);
  return {
    roles: Array.isArray(o.roles) ? o.roles.filter((r): r is string => typeof r === "string") : [],
    vcardArray: o.vcardArray,
    entities: nested,
  };
}

/** Registries return wildly different extra members, so parse structurally rather than with zod —
 *  a strict schema would throw the moment a registry adds a field. */
export function normalizeRdap(raw: unknown): RdapDomain {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const events = Array.isArray(o.events)
    ? o.events
        .filter((e): e is Record<string, unknown> => !!e && typeof e === "object")
        .filter((e) => typeof e.eventAction === "string" && typeof e.eventDate === "string")
        .map((e) => ({ eventAction: e.eventAction as string, eventDate: e.eventDate as string }))
    : [];
  const secure = o.secureDNS && typeof o.secureDNS === "object"
    ? { delegationSigned: (o.secureDNS as Record<string, unknown>).delegationSigned === true }
    : undefined;
  return {
    status: Array.isArray(o.status) ? o.status.filter((s): s is string => typeof s === "string") : [],
    secureDNS: secure,
    events,
    entities: Array.isArray(o.entities)
      ? o.entities.map((e) => normalizeEntity(e, 1)).filter((e): e is RdapEntity => e !== null)
      : [],
  };
}

async function fetchRdapUrl(url: string): Promise<RdapDomain | null> {
  const res = await fetch(url, {
    headers: { Accept: "application/rdap+json" },
    signal: AbortSignal.timeout(RDAP_TIMEOUT_MS),
    redirect: "follow",
  });
  if (res.status === 404) return null; // no bootstrap entry here — caller tries the fallback
  if (!res.ok) throw new RdapHttpError(res.status);
  return normalizeRdap(await res.json());
}

async function probeRdap(domain: string): Promise<RdapDomain | null> {
  const tld = domain.split(".").pop() ?? "";
  const urls = [`https://rdap.org/domain/${encodeURIComponent(domain)}`];
  const fallback = TLD_RDAP_FALLBACKS[tld];
  if (fallback) urls.push(`${fallback}${encodeURIComponent(domain)}`);

  for (const url of urls) {
    try {
      const result = await retryWithBackoff(
        () => fetchRdapUrl(url),
        2,
        isTransientRdapError,
        `${NAME} rdap ${domain}`,
      );
      if (result) return result;
    } catch (err) {
      log.warn(`[${NAME}] RDAP query ${url} failed: ${err}`);
    }
  }
  log.warn(`[${NAME}] RDAP unavailable for ${domain} — registrar checks skipped`);
  return null;
}

// ── DNS ──

/** ENODATA/ENOTFOUND mean the record genuinely does not exist (a real finding); every other code
 *  means the lookup itself failed, so the check must be skipped rather than reported. */
const RECORD_ABSENT_CODES = new Set(["ENODATA", "ENOTFOUND"]);

async function lookup<T>(
  label: string,
  fn: () => Promise<T[]>,
  map: (rows: T[]) => string[],
  errors: Record<string, string>,
): Promise<string[] | null> {
  try {
    return map(await fn());
  } catch (err) {
    const code = String((err as NodeJS.ErrnoException)?.code ?? "EUNKNOWN");
    if (RECORD_ABSENT_CODES.has(code)) return [];
    errors[label] = code;
    return null;
  }
}

// TXT records longer than 255 bytes arrive split into chunks — rejoin before matching.
const joinTxt = (rows: string[][]): string[] => rows.map((chunks) => chunks.join(""));

async function probeDns(domain: string): Promise<DnsFacts> {
  const errors: Record<string, string> = {};
  const [caa, mx, txt, dmarc] = await Promise.all([
    lookup("CAA", () => dns.resolveCaa(domain), (rows) => rows.map((r) => JSON.stringify(r)), errors),
    lookup("MX", () => dns.resolveMx(domain), (rows) => rows.map((r) => r.exchange), errors),
    lookup("TXT", () => dns.resolveTxt(domain), joinTxt, errors),
    lookup("DMARC", () => dns.resolveTxt(`_dmarc.${domain}`), joinTxt, errors),
  ]);
  return { caa, mx, txt, dmarc, errors };
}

// ── Web ──

interface TlsFacts {
  authorized: boolean;
  authorizationError: string | null;
  validTo: string | null;
  protocol: string | null;
}

function probeTls(host: string): Promise<TlsFacts> {
  return new Promise((resolve, reject) => {
    const socket = tls.connect(
      { host, port: 443, servername: host, timeout: TLS_TIMEOUT_MS, rejectUnauthorized: false },
      () => {
        const cert = socket.getPeerCertificate();
        resolve({
          authorized: socket.authorized,
          authorizationError: socket.authorizationError ? String(socket.authorizationError) : null,
          validTo: cert && typeof cert.valid_to === "string" ? cert.valid_to : null,
          protocol: socket.getProtocol(),
        });
        socket.destroy();
      },
    );
    socket.once("timeout", () => {
      socket.destroy();
      reject(new Error(`TLS connection to ${host} timed out`));
    });
    socket.once("error", (err) => {
      socket.destroy();
      reject(err);
    });
  });
}

async function probeWeb(host: string): Promise<WebFacts | null> {
  let tlsFacts: TlsFacts;
  try {
    tlsFacts = await probeTls(host);
  } catch (err) {
    log.warn(`[${NAME}] ${host} unreachable over TLS (${err}) — web checks skipped`);
    return null;
  }

  let headers: Record<string, string> | null = null;
  try {
    const res = await fetch(`https://${host}`, {
      redirect: "manual",
      signal: AbortSignal.timeout(WEB_FETCH_TIMEOUT_MS),
    });
    headers = {};
    res.headers.forEach((value, key) => {
      headers![key.toLowerCase()] = value;
    });
  } catch (err) {
    log.warn(`[${NAME}] HTTPS request to ${host} failed: ${err}`);
  }

  let httpRedirect: WebFacts["httpRedirect"] = null;
  try {
    const res = await fetch(`http://${host}`, {
      redirect: "manual",
      signal: AbortSignal.timeout(WEB_FETCH_TIMEOUT_MS),
    });
    httpRedirect = { status: res.status, location: res.headers.get("location") };
  } catch (err) {
    log.warn(`[${NAME}] HTTP request to ${host} failed: ${err}`);
  }

  return { ...tlsFacts, headers, httpRedirect };
}

export const defaultProbes: Probes = { rdap: probeRdap, dns: probeDns, web: probeWeb };

// ── Evaluators (pure) ──

function vcardValues(vcardArray: unknown): { prop: string; value: string }[] {
  if (!Array.isArray(vcardArray) || vcardArray.length < 2) return [];
  const entries = vcardArray[1];
  if (!Array.isArray(entries)) return [];

  const out: { prop: string; value: string }[] = [];
  for (const entry of entries) {
    if (!Array.isArray(entry) || entry.length < 4) continue;
    const prop = typeof entry[0] === "string" ? entry[0].toLowerCase() : "";
    if (!VCARD_PROPS.has(prop)) continue;
    const raw = entry[3];
    // `adr` values are arrays of address components; everything else is a plain string.
    const value = Array.isArray(raw)
      ? raw.filter((v): v is string => typeof v === "string" && v.trim() !== "").join(", ")
      : typeof raw === "string"
        ? raw
        : "";
    if (value.trim() === "") continue;
    out.push({ prop, value: value.trim() });
  }
  return out;
}

function collectOwnerEntities(entities: RdapEntity[], depth = 1): RdapEntity[] {
  if (depth > MAX_ENTITY_DEPTH) return [];
  const out: RdapEntity[] = [];
  for (const entity of entities) {
    if (entity.roles.some((r) => OWNER_ROLES.has(r.toLowerCase()))) out.push(entity);
    out.push(...collectOwnerEntities(entity.entities ?? [], depth + 1));
  }
  return out;
}

/** Registrar display name, for the alert issue intro. */
export function registrarName(rdap: RdapDomain): string | null {
  for (const entity of rdap.entities) {
    if (!entity.roles.some((r) => r.toLowerCase() === "registrar")) continue;
    const fn = vcardValues(entity.vcardArray).find((v) => v.prop === "fn");
    if (fn) return fn.value;
  }
  return null;
}

/** Registration expiry date (ISO string) as reported by the registry. */
export function expiryDate(rdap: RdapDomain): string | null {
  return rdap.events.find((e) => e.eventAction === "expiration")?.eventDate ?? null;
}

const truncate = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export function evaluateRdap(rdap: RdapDomain | null, now: Date): Finding[] {
  // RDAP unavailable is a scanner limitation, not a posture problem — never a finding.
  if (!rdap) return [];

  const findings: Finding[] = [];

  for (const entity of collectOwnerEntities(rdap.entities)) {
    const role = entity.roles.find((r) => OWNER_ROLES.has(r.toLowerCase())) ?? "contact";
    for (const { prop, value } of vcardValues(entity.vcardArray)) {
      if (REDACTED_RE.test(value)) continue;
      findings.push({
        id: "whois-contact-exposed",
        severity: "high",
        detail: `RDAP/WHOIS publishes the ${role} \`${prop}\` as "${truncate(value, 60)}".`,
        fix: "Enable WHOIS/RDAP privacy (registrar-provided proxy or redaction) for this contact in the registrar console.",
      });
    }
  }

  if (!rdap.status.some((s) => s.toLowerCase().includes("transfer prohibited"))) {
    findings.push({
      id: "registrar-lock-missing",
      severity: "medium",
      detail: `No transfer lock in RDAP status (${rdap.status.length > 0 ? rdap.status.join(", ") : "no statuses reported"}).`,
      fix: "Turn on the registrar/transfer lock (`clientTransferProhibited`) in the registrar console.",
    });
  }

  if (rdap.secureDNS?.delegationSigned !== true) {
    findings.push({
      id: "dnssec-unsigned",
      severity: "medium",
      detail: "The delegation is not DNSSEC-signed, so responses for this zone can be spoofed by an on-path resolver.",
      fix: "Enable DNSSEC at the DNS host and publish the resulting DS record at the registrar.",
    });
  }

  const expiry = expiryDate(rdap);
  const expiryMs = expiry ? Date.parse(expiry) : NaN;
  if (!Number.isNaN(expiryMs)) {
    const days = Math.floor((expiryMs - now.getTime()) / DAY_MS);
    if (days < EXPIRY_WARN_DAYS) {
      findings.push({
        id: "registration-expiring",
        severity: "high",
        detail: `Registration expires ${expiry} (${days} day(s) away).`,
        fix: "Renew the domain, or confirm auto-renew is on and the registrar has a valid payment method.",
      });
    }
  }

  return findings;
}

export function evaluateDns(facts: DnsFacts, _now: Date): Finding[] {
  const findings: Finding[] = [];

  if (facts.caa !== null && facts.caa.length === 0) {
    findings.push({
      id: "caa-missing",
      severity: "low",
      detail: "No CAA record, so any public CA may issue a certificate for this domain.",
      fix: "Publish a CAA record naming the CAs you actually use, e.g. `0 issue \"letsencrypt.org\"`.",
    });
  }

  if (facts.dmarc !== null) {
    const dmarc = facts.dmarc.find((r) => r.trim().toLowerCase().startsWith("v=dmarc1"));
    if (!dmarc) {
      findings.push({
        id: "dmarc-missing",
        severity: "medium",
        detail: "No DMARC record at `_dmarc`, so nothing tells receivers what to do with spoofed mail.",
        fix: "Publish a `_dmarc` TXT record, e.g. `v=DMARC1; p=quarantine; rua=mailto:…`.",
      });
    } else if (/[;\s]p\s*=\s*none/i.test(dmarc)) {
      findings.push({
        id: "dmarc-policy-none",
        severity: "low",
        detail: "DMARC policy is `p=none` — reports are collected but spoofed mail is still delivered.",
        fix: "Once reports look clean, move the policy to `p=quarantine` and then `p=reject`.",
      });
    }
  }

  if (facts.txt !== null) {
    const spf = facts.txt.find((r) => r.trim().toLowerCase().startsWith("v=spf1"));
    if (!spf) {
      const mailHint =
        facts.mx && facts.mx.length > 0
          ? ` The domain publishes ${facts.mx.length} MX record(s), so it does receive mail.`
          : "";
      findings.push({
        id: "spf-missing",
        severity: "medium",
        detail: `No SPF record, so any host can send mail claiming to be from this domain.${mailHint}`,
        fix: "Publish an SPF TXT record ending in `~all` (or `-all`), listing only your real senders.",
      });
      // `+all` / a bare `all` accept every sender. `~all` and `-all` are correct and must not flag.
    } else if (/[+\s]all\s*$/i.test(spf.trim())) {
      findings.push({
        id: "spf-permissive",
        severity: "medium",
        detail: `SPF record ends in a permissive \`all\` mechanism: \`${truncate(spf.trim(), 60)}\`.`,
        fix: "Change the trailing mechanism to `~all` (softfail) or `-all` (fail).",
      });
    }
  }

  return findings;
}

export function evaluateWeb(host: string, facts: WebFacts, now: Date): Finding[] {
  const findings: Finding[] = [];

  if (facts.authorized === false) {
    findings.push({
      id: "tls-invalid",
      severity: "high",
      host,
      detail: `TLS certificate did not validate: ${facts.authorizationError ?? "unknown error"}.`,
      fix: "Reissue or reinstall the certificate so it chains to a public root and matches the hostname.",
    });
  }

  const validToMs = facts.validTo ? Date.parse(facts.validTo) : NaN;
  if (!Number.isNaN(validToMs)) {
    const days = Math.floor((validToMs - now.getTime()) / DAY_MS);
    if (days < CERT_EXPIRY_WARN_DAYS) {
      findings.push({
        id: "tls-expiring",
        severity: "high",
        host,
        detail: `Certificate expires ${facts.validTo} (${days} day(s) away).`,
        fix: "Check the ACME/cert-manager renewal job — renewal normally happens 30 days out.",
      });
    }
  }

  if (facts.httpRedirect !== null) {
    const { status, location } = facts.httpRedirect;
    const redirects =
      [301, 302, 307, 308].includes(status) && (location ?? "").toLowerCase().startsWith("https://");
    if (!redirects) {
      findings.push({
        id: "https-redirect-missing",
        severity: "medium",
        host,
        detail: `\`http://${host}\` answered ${status}${location ? ` → ${truncate(location, 60)}` : ""} instead of redirecting to HTTPS.`,
        fix: "Add an HTTP→HTTPS redirect at the ingress (e.g. the `ssl-redirect` annotation).",
      });
    }
  }

  if (facts.headers !== null) {
    const hsts = facts.headers["strict-transport-security"];
    const maxAge = hsts ? Number(hsts.match(/max-age\s*=\s*(\d+)/i)?.[1] ?? NaN) : NaN;
    if (!hsts) {
      findings.push({
        id: "hsts-missing",
        severity: "medium",
        host,
        detail: "No `Strict-Transport-Security` response header.",
        fix: `Send \`Strict-Transport-Security: max-age=${MIN_HSTS_MAX_AGE}; includeSubDomains\`.`,
      });
    } else if (Number.isNaN(maxAge) || maxAge < MIN_HSTS_MAX_AGE) {
      findings.push({
        id: "hsts-missing",
        severity: "medium",
        host,
        detail: `\`Strict-Transport-Security\` max-age is too short: \`${truncate(hsts, 60)}\`.`,
        fix: `Raise max-age to at least ${MIN_HSTS_MAX_AGE} (180 days).`,
      });
    }

    const missing: string[] = [];
    if (facts.headers["x-content-type-options"]?.toLowerCase() !== "nosniff") {
      missing.push("`X-Content-Type-Options: nosniff`");
    }
    if (
      !facts.headers["content-security-policy"] &&
      !facts.headers["content-security-policy-report-only"]
    ) {
      missing.push("`Content-Security-Policy`");
    }
    if (missing.length > 0) {
      findings.push({
        id: "security-header-missing",
        severity: "low",
        host,
        detail: `Missing response header(s): ${missing.join(", ")}.`,
        fix: "Add the headers at the ingress or in the application's response middleware.",
      });
    }
  }

  return findings;
}

// ── Reporting ──

/** RDAP registrar names, vCard values and HTTP header values are third-party strings — a stray `|`
 *  or backtick would break the Markdown table or the surrounding code span. */
export function cell(s: string): string {
  return truncate(s.replace(/[\r\n]+/g, " ").replace(/`/g, "").replace(/\|/g, "\\|"), 120);
}

const SEVERITY_ORDER: Record<Finding["severity"], number> = { high: 0, medium: 1, low: 2 };

function issueTitle(domain: string): string {
  return `[${NAME}] Sub-optimal settings for ${domain}`;
}

export function buildBody(
  entry: DomainEntry,
  rdap: RdapDomain | null,
  findings: Finding[],
  notes: string[],
): string {
  const registrar = rdap ? registrarName(rdap) : null;
  const expiry = rdap ? expiryDate(rdap) : null;
  const multiHost = entry.web.length > 1;

  const sorted = [...findings].sort(
    (a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || a.id.localeCompare(b.id),
  );

  const intro = [
    `Domain posture checks for \`${entry.domain}\` (project: ${entry.project}) found ` +
      `${findings.length} sub-optimal setting(s).`,
    "",
    `- **Registrar:** ${registrar ? cell(registrar) : "unknown"}`,
    `- **Registration expires:** ${expiry ? cell(expiry) : "unknown"}`,
    "",
  ].join("\n");

  const footer = [
    ...(notes.length > 0 ? ["### Checks skipped this run", "", ...notes.map((n) => `- ${n}`), ""] : []),
    `Suppress a check by adding its id to \`ignore:\` for this domain in \`${MANIFEST_PATH}\`.`,
  ];

  return renderViolationTable({
    intro,
    columns: ["Check", "Severity", "Detail", "Fix"],
    rows: sorted,
    cells: (f) => [
      `\`${f.host && multiHost ? `${f.host}: ${f.id}` : f.id}\``,
      f.severity,
      cell(f.detail),
      cell(f.fix),
    ],
    footer,
  });
}

async function scanDomain(entry: DomainEntry, probes: Probes, now: Date): Promise<void> {
  const notes: string[] = [];

  const rdap = await probes.rdap(entry.domain);
  if (!rdap) notes.push("RDAP unavailable — registrar checks skipped this run.");

  const dnsFacts = await probes.dns(entry.domain);
  for (const [label, code] of Object.entries(dnsFacts.errors ?? {})) {
    notes.push(`DNS lookup for ${label} failed (${code}) — skipped.`);
  }

  const findings = [...evaluateRdap(rdap, now), ...evaluateDns(dnsFacts, now)];

  for (const host of entry.web) {
    const webFacts = await probes.web(host);
    if (!webFacts) {
      notes.push(`${host} unreachable over TLS — web checks skipped.`);
      continue;
    }
    findings.push(...evaluateWeb(host, webFacts, now));
  }

  const ignored = new Set(entry.ignore);
  const kept = findings.filter((f) => !ignored.has(f.id));

  const title = issueTitle(entry.domain);

  // Notes alone must never open or hold open an issue: a flaky registry or a temporary SERVFAIL
  // would otherwise file noise that never clears.
  if (kept.length === 0) {
    await closeAlertIssueIfResolved({
      repo: SELF_REPO,
      title,
      logPrefix: NAME,
      reason: `${entry.domain}: no posture findings`,
    });
    log.info(`[${NAME}] ${entry.domain}: clean${notes.length > 0 ? ` (${notes.length} check(s) skipped)` : ""}`);
    return;
  }

  await ensureAlertIssue({
    repo: SELF_REPO,
    title,
    body: buildBody(entry, rdap, kept, notes),
    // Claws Ignore keeps the issue-dispatcher from trying to "implement" a registrar-console change.
    labels: [LABELS.clawsIgnore],
    logPrefix: NAME,
    // The body is a pure function of current state — a fixed check must disappear from it.
    refreshBody: true,
  });
  log.info(`[${NAME}] ${entry.domain}: ${kept.length} finding(s) reported`);
}

export async function run(probes: Probes = defaultProbes): Promise<void> {
  try {
    const content = await gh.fetchRepoFileContent(SELF_REPO, MANIFEST_PATH);
    if (content === null) {
      log.info(`[${NAME}] ${MANIFEST_PATH} not found in ${SELF_REPO} — nothing to scan`);
      return;
    }

    const parsed = parseDomainsManifest(content);
    if (!parsed.ok) {
      await ensureAlertIssue({
        repo: SELF_REPO,
        title: MALFORMED_ISSUE_TITLE,
        body: [
          `\`${MANIFEST_PATH}\` could not be parsed, so no domains were checked this run.`,
          "",
          "```",
          parsed.error,
          "```",
        ].join("\n"),
        labels: [LABELS.clawsIgnore],
        logPrefix: NAME,
        refreshBody: true,
      });
      return;
    }

    await closeAlertIssueIfResolved({
      repo: SELF_REPO,
      title: MALFORMED_ISSUE_TITLE,
      logPrefix: NAME,
      reason: `${MANIFEST_PATH} parses cleanly`,
    });

    const now = new Date();
    const settled = await mapSettledWithConcurrency(parsed.manifest.domains, CONCURRENCY, (entry) =>
      scanDomain(entry, probes, now),
    );
    for (let i = 0; i < settled.length; i++) {
      const result = settled[i]!;
      if (result.status === "rejected") {
        log.warn(
          `[${NAME}] Failed to scan ${parsed.manifest.domains[i]!.domain}: ${result.reason}`,
        );
      }
    }
    log.info(`[${NAME}] Checked ${parsed.manifest.domains.length} domain(s)`);
  } catch (err) {
    await reportError(NAME, "domain posture scan failed", err);
  }
}
