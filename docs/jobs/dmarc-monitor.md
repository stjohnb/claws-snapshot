# dmarc-monitor

**Source**: `src/jobs/dmarc-monitor.ts`, `src/dmarc.ts`
**Trigger**: Not separately scheduled — a handler inside [`email-monitor`](email-monitor.md), invoked once per unread inbox message
**Requires**: `emailEnabled: true` plus `emailUser`/`emailAppPassword` (the same mailbox `email-monitor` already polls). No new config keys.

Ingests RFC 7489 DMARC aggregate reports out of the Claws mailbox, stores every
`<record>` in SQLite with a verdict attached, and alerts only when a human has to
look at something. Domains publish `rua=mailto:dmarc-reports@bstjohn.net`, a Gmail
filter forwards everything sent there into the Claws inbox, and this handler takes it
from there — the job is keyed on `policy_published/domain` in the report, so it covers
every domain that starts publishing DMARC without a code change.

## Where it runs in email-monitor

`tryIngestDmarcEmail(parsed, uid)` runs immediately after `simpleParser()` and
**before** the `EMAIL_ALLOWED_SENDERS` allowlist and before any Claude call. That
ordering is the whole point: DMARC reporters (`noreply-dmarc-support@google.com`,
`dmarcreport@microsoft.com`, …) will never be in the allowlist, so with an allowlist
configured every report would be marked `\Seen` and dropped, and with an empty one
each report would burn a Claude extraction call before being discarded as "not a veg
box email".

When the handler returns `true` the message is marked `\Seen` and processing stops.
It never throws — a report Claws cannot decompress or parse is reported via
`reportError` and still consumed, so a broken attachment can't leave the message
unread and reprocessed on every 5-minute poll.

## Recognition

A message is a DMARC report if **either**:

- the subject matches the RFC 7489 form `Report domain: <domain> Submitter: <org> Report-ID: <id>`, or
- it carries an attachment whose filename ends `.zip` / `.gz` / `.gzip` / `.xml`, or whose content type is one of `application/zip`, `application/x-zip-compressed`, `application/gzip`, `application/x-gzip`, `text/xml`, `application/xml`.

Sender address is deliberately **not** part of the test — every reporter uses its own,
and Gmail forwarding rewrites the envelope anyway.

A subject-matching message with no usable attachment is still consumed (so it cannot
reach the Claude path) and reported as `dmarc-monitor:attachment`.

## Decompress and parse

No LLM call is involved — the schema is fixed, so `src/dmarc.ts` parses it
deterministically with no new npm dependency:

1. **Size gate** — attachments over 5 MB are rejected before decompression, and a
   decompressed document over 5 MB (`MAX_XML_BYTES`, tightened from 20 MB by #2838)
   throws, so a zip bomb cannot exhaust the service's memory cap. On top of the absolute
   cap, a compression-ratio guard rejects any decompressed output more than 200x the
   compressed input once that output exceeds 256 KB — real aggregate-report XML
   compresses 20-50x, so a 1000x-class zip bomb trips this long before it could reach
   the absolute cap through a slightly larger carrier archive.
2. **Decompress** by sniffing magic bytes, not the filename: `1f 8b` → `zlib.gunzipSync`,
   `50 4b` → single-entry zip, anything else → treated as bare XML.
3. **Zip reading** goes through the **central directory**, never the local file header.
   Google and Microsoft stream their archives, which writes zero compressed/uncompressed
   sizes into the local header and defers them to a trailing data descriptor; trusting
   the local header yields an empty entry. Deflate (method 8) and stored (method 0) are
   supported; anything else throws. An archive is rejected outright — before any bytes
   are read as entry data — if it has more than one entry, uses a ZIP64 sentinel, or its
   entry's declared size would run past the end of the archive; every real reporter sends
   exactly one file, so any of these shapes is treated as a bomb rather than a report.
4. **Parse** the `<feedback>` document with a minimal attribute-free XML reader.
   Malformed input throws rather than silently producing an empty tree, so a truncated
   attachment surfaces as a parse error instead of an empty report. Epoch-second
   `date_range` values are converted to ISO-8601 UTC at parse time, which is what makes
   the `date_begin` column sort lexicographically. Parsing caps a report at 1,000
   `<record>` rows and 50 `<dkim>`/`<spf>`/`<reason>` children per row
   (`MAX_ROWS_PER_REPORT` / `MAX_AUTH_RESULTS_PER_ROW`); a report that hits the row cap
   still ingests normally with `truncatedRows` set, and one synchronous
   better-sqlite3 transaction can no longer be made to block the event loop by inflating
   the record count.

Parse failures are reported as `dmarc-monitor:parse`.

## Verdicts

Each row is classified once, at ingest, so alerting and the dashboard never re-read XML.
Alignment is strict (exact domain match) when the published `adkim`/`aspf` is `s`, and
relaxed (organisational-domain suffix match either way) otherwise. An empty
`header_from` is never treated as aligned.

Rules are evaluated in order — the first match wins:

| # | Condition | Verdict | Meaning |
|---|-----------|---------|---------|
| 1 | No DKIM pass and no SPF pass | `spoof` | Nothing authenticated at all — mail forged as this domain |
| 2 | An aligned DKIM pass, no SPF pass at all | `forwarded` | Normal forwarding; informational only |
| 3 | DMARC evaluated pass **and** an aligned DKIM or SPF pass | `aligned_pass` | The healthy case |
| 4 | Neither DKIM nor SPF aligned | `unaligned_pass` | Authenticated only on an unaligned identity (e.g. DKIM under `*.gappssmtp.com` while `adkim=s`) |
| 5 | Anything else | `unknown` | Doesn't fit the above; treated like `unaligned_pass` for alerting |

`unaligned_pass` and `unknown` are the verdicts that matter before tightening a policy:
they mean either a legitimate sender nobody knew about, or DKIM alignment has regressed.

## Alerts

Alerting is batched **per report**, never per row, and only ever fires on a fresh
insert — a duplicate `(org_name, report_id)` short-circuits both the insert and the
alerting, so a re-forwarded report is silent.

| Condition | Channel |
|-----------|---------|
| One or more `spoof` / `unaligned_pass` / `unknown` rows | `upsertAlertIssue` in `SELF_REPO`, title `[dmarc] Unauthenticated or unaligned mail for <domain>`, labels `Priority` + `Manual Action`; plus one short WhatsApp line |
| The report's `policy_published` differs from the previous report for the same domain | `upsertAlertIssue`, title `[dmarc] Published policy changed for <domain>` — catches an unintended `_dmarc` DNS edit |
| Attachment could not be decompressed, or the XML could not be parsed | `reportError` (`dmarc-monitor:parse` / `dmarc-monitor:attachment`) |
| Every row is `aligned_pass` or `forwarded`, and the policy is unchanged | **Nothing** — silent by design |

The issue body is rebuilt from scratch on every report: `upsertAlertIssue` edits the
body only when it actually changed, so a recurring alert never becomes comment spam.
`org_name`, `header_from` and `<comment>` text originates in an attacker-influenceable
email, so pipes are escaped and newlines stripped before they go into the markdown
table (and every value is `escapeHtml`d on the page).

The WhatsApp line is sent to each entry of `WHATSAPP_ALLOWED_NUMBERS`, each send wrapped
individually — WhatsApp being down logs a warning and never fails ingestion, since the
report is already stored:

```
DMARC: 2 unauthenticated/unaligned row(s) for bstjohn.net (google.com, 2026-08-29T00:00:00.000Z → 2026-08-29T23:59:59.000Z), currently p=none. See https://…/dmarc
```

## Rate limits and denylist

Added by #2838 to bound the blast radius of the unauthenticated ingestion path
(see "Known risk" below) without adding authentication: a flood of forged reports
must not exhaust the host or mint unlimited issues/WhatsApp pushes.

- **Ingest window** — a rolling 1-hour window caps ingestion at 50 report emails
  (`MAX_REPORTS_PER_WINDOW`). Counted before decompression, so unparseable junk is
  throttled too. A throttled message is consumed (marked `\Seen`) without being
  decompressed or parsed; `getDmarcStatus().throttledReports` and `.lastThrottleAt`
  record it.
- **Alert window** — a separate rolling 1-hour window caps domain-titled alert issues
  (and their WhatsApp pushes) at 5 (`MAX_ALERTS_PER_WINDOW`), since the domain in every
  alert title comes straight from the attacker-controlled `policy_published/domain` —
  without this, varying the fake domain per email mints unlimited issues.
  `getDmarcStatus().suppressedAlerts` counts alerts dropped this way.
- **Flood alert** — tripping either window files one `upsertAlertIssue` with the fixed
  title `[dmarc] Ingestion rate limit tripped` (fixed so an attacker cannot mint issues
  by varying a field), at most once per 6 hours, with no WhatsApp push — a flood must
  tell the operator once, not become a push flood itself.
- **`dmarcBlockedSenders` denylist** — a hot-reloadable list of known bad actors,
  checked against the envelope `From` address before parsing and again against the
  report's own `report_metadata/email` after parsing. An entry containing `@` matches a
  full address; an entry without matches a domain and its subdomains. Matches increment
  `getDmarcStatus().blockedSenders` and are dropped with no `reportError` (a blocked
  sender is expected, not an error). Configure via `dmarcBlockedSenders` in
  `config.json` or `CLAWS_DMARC_BLOCKED_SENDERS` (comma-separated) — see
  [configuration.md](../configuration.md). This is **best-effort**: a `From` address is
  forgeable, so it stops a repeat lazy offender, not a determined attacker; the rate
  limits above are what actually bound the damage.
- Rate-limit state lives in memory and resets on restart — an attacker who waits out a
  restart still hits the caps again, and this needed no schema change.

## Storage and the dashboard

Rows land in the [`dmarc_reports` and `dmarc_rows`](../database-schema.md#dmarc_reports-table)
tables; `raw_xml` is kept only on `dmarc_reports` so `SELECT *` on the hot row table
stays small, and is retrievable via `getDmarcReportXml(orgName, reportId)` — the only
read path that touches it. Since nothing else reads it back, the stored XML is
truncated to 256 KB (`MAX_STORED_XML_BYTES`) with a trailing HTML comment marking the
cut, rather than storing an attacker-chosen 5 MB blob per email; this is enough to
debug a parse without the disk cost.

The `/dmarc` dashboard page shows the latest report per domain and reporter, verdict
counts per domain over the last 7 and 30 days, distinct source IPs with their verdicts,
and the last 100 rows — enough to answer "have the last N days been clean?" at a glance.
`getDmarcStatus()` (last ingest, last error, reports ingested, plus the rate-limit and
denylist counters from #2838) is exposed on `/status` alongside a 7-day verdict count.

Deciding to tighten a domain from `p=none` to `p=reject` stays a manual human call;
this job exists to make that decision well-informed and to make a spoofing campaign
impossible to miss.

## Known risk: unauthenticated ingestion (accepted)

The `rua=` mailbox is published in each domain's public `_dmarc` DNS TXT record by
design, so its address is not a secret. Nothing in this handler verifies who sent a
report or that a report's `policy_published/domain` belongs to an operator-owned
domain — recognition is shape-only (see Recognition above), and every field driving
storage and alerting (`domain`, `org_name`, `report_id`, per-row verdicts) is read
straight out of the sender's XML.

Concretely, anyone who reads a domain's `_dmarc` TXT record can email the mailbox a
small crafted report and, within one 5-minute poll:

- get rows classified `spoof` (verdict rule 1 above), which opens/updates a `Priority`
  + `Manual Action` issue in `SELF_REPO` and sends a WhatsApp line to every number in
  `WHATSAPP_ALLOWED_NUMBERS`;
- trip the policy-changed alert with a second report using different
  `policy_p`/`adkim`/`aspf` values, raising a false "`_dmarc` DNS changed" issue;
- repeat either, since dedupe is keyed on the attacker-controlled `(org_name, report_id)`
  pair — though as of #2838 (see "Rate limits and denylist" above) repeating it no longer
  scales without bound: at most 50 reports and 5 domain-titled alert issues land per
  rolling hour, and a repeat offender's address can be denylisted without a restart.

This was raised as #2763 along with two candidate fixes — an authenticated-reporter
allowlist keyed off the receiving MTA's `Authentication-Results` header, and an
owned-domain filter on `policy_published/domain`. The repo owner reviewed the
tradeoff and decided to accept the identity risk rather than add that gating: the
mailbox address is public by design regardless of any code change, `dmarc_reports` held
zero rows in production as of 2026-09-01, and a configured allowlist remained a possible
future mitigation if abuse was ever actually observed. That decision stands — this
handler still accepts a report from anyone, and no domain/reporter allowlist gates
ingestion. What changed with #2838 is blast radius, not identity: decompression bomb
resistance (size cap, compression-ratio guard, malformed-archive rejection, per-report
row/field caps), the ingest and alert rate limits, the `raw_xml` storage cap, and a
best-effort `dmarcBlockedSenders` denylist for repeat offenders. This section exists so
the remaining accepted tradeoff — no authentication — stays visible next to the code
that bounds its consequences.

## Notes

- Reports with zero `<record>` elements are valid: the report row is stored, nothing is alerted.
- `pruneDmarcReports(retentionDays = 365)` deletes reports and their rows past the
  retention window, run from `main.ts` daily and at startup — the same cadence as
  `pruneWorkflowRuns`. This bounds `dmarc_reports.raw_xml` growth regardless of report
  volume or authenticity.
