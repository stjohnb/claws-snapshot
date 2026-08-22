# domain-posture-scanner

A daily, deterministic (no LLM, no worktree) scan of every domain the org owns.
It reads a repo-owned manifest, checks each domain's registrar, DNS and — for
domains that serve a site — TLS and HTTP security posture, and files one
deduplicated alert issue per domain in `SELF_REPO`. When a domain comes clean the
issue is closed automatically.

Runs at 6 AM local time (`schedules.domainPostureScannerHour`). Source:
`src/jobs/domain-posture-scanner.ts`.

## Not a pentesting service

Every check is a *passive* read of public registry, DNS and HTTP data: an RDAP
lookup, four DNS queries, one TLS handshake and two HTTP requests per host. There
is no port scanning, no fuzzing, no authentication testing and no active probing
of any kind. Issue #2574 raised the idea of growing this into a pentesting
service; that is deliberately out of scope here, and adding active probing would
need its own design (authorization, rate limits, blast radius).

## The manifest — `docs/domains.yaml`

Read at runtime from `main` via the GitHub contents API, so editing it takes
effect on the next run without a redeploy.

```yaml
domains:
  - domain: namey.baby        # registrable domain (required)
    project: namey            # owning project, shown in the alert body (required)
    web: [namey.baby, www.namey.baby]   # hostnames to probe; omit or [] to skip web checks
    ignore: [caa-missing]     # check ids to suppress for this domain
```

To **add a domain**, append an entry and open a PR. To **silence a check you have
decided not to fix**, add its id to that domain's `ignore:` list — the alert body
says so in its footer.

If the file is missing the job logs and does nothing. If it fails to parse, the
job files `[domain-posture-scanner] docs/domains.yaml could not be parsed` and
scans nothing that run; that issue closes once the file parses again.

## Checks

Each finding carries a stable **id** — that is what you put in `ignore:`.

### Registrar (RDAP)

| id | Severity | What it means | How to fix |
|---|---|---|---|
| `whois-contact-exposed` | high | The registry publishes a real name, org, email, address or phone number for the registrant/admin/tech/billing contact instead of a redaction placeholder. | Turn on WHOIS/RDAP privacy for that contact in the registrar console. |
| `registrar-lock-missing` | medium | No `transfer prohibited` status — the domain can be transferred away without the lock stopping it. | Enable the registrar/transfer lock (`clientTransferProhibited`). |
| `dnssec-unsigned` | medium | The delegation is not DNSSEC-signed. | Enable DNSSEC at the DNS host, then publish the DS record at the registrar. |
| `registration-expiring` | high | Registration expires within 45 days. | Renew, or confirm auto-renew is on and the payment method is valid. |

The registrar's own entity — and its nested `abuse` contact, which legitimately
carries a real address — are excluded from `whois-contact-exposed`; only
registrant/administrative/technical/billing roles are checked, and only when the
vCard actually carries a non-empty value.

### DNS

| id | Severity | What it means | How to fix |
|---|---|---|---|
| `caa-missing` | low | No CAA record, so any public CA may issue for the domain. | Publish `0 issue "letsencrypt.org"` (or whichever CAs you use). |
| `dmarc-missing` | medium | No `_dmarc` TXT record. | Publish `v=DMARC1; p=quarantine; rua=mailto:…`. |
| `dmarc-policy-none` | low | DMARC exists but is `p=none` — reporting only. | Move to `p=quarantine`, then `p=reject`. |
| `spf-missing` | medium | No `v=spf1` TXT record. | Publish an SPF record ending in `~all` or `-all`. |
| `spf-permissive` | medium | SPF ends in `+all` or a bare `all`, which authorises every sender. | Change the trailing mechanism to `~all` or `-all`. |

`~all` and `-all` are both correct and are never flagged.

### Web (only for hostnames listed under `web:`)

| id | Severity | What it means | How to fix |
|---|---|---|---|
| `tls-invalid` | high | The certificate did not validate (chain or hostname). | Reissue/reinstall the certificate. |
| `tls-expiring` | high | The leaf certificate expires within 14 days. | Check the ACME/cert-manager renewal job — renewal normally happens 30 days out. |
| `https-redirect-missing` | medium | `http://host` did not answer with a 301/302/307/308 to an `https://` location. | Add an HTTP→HTTPS redirect at the ingress. |
| `hsts-missing` | medium | No `Strict-Transport-Security`, or its `max-age` is under 180 days. | Send `Strict-Transport-Security: max-age=15552000; includeSubDomains`. |
| `security-header-missing` | low | `X-Content-Type-Options: nosniff` and/or a `Content-Security-Policy` (report-only counts) is absent. | Add the headers at the ingress or in response middleware. |

Apex and `www.` hosts are probed separately even when they share a certificate,
because redirects and headers can differ per host. When a domain lists more than
one host, findings are shown as `www.example.com: hsts-missing` in the table —
the bare id is still what `ignore:` matches.

## Why an unavailable probe is never a finding

RDAP has no universal bootstrap (`.io` is not in rdap.org's, so the job falls back
to Identity Digital's endpoint), registries go down, and resolvers return
`SERVFAIL`. Treating those as findings would file noise that clears itself.

- **RDAP unreachable** → registrar checks are skipped for that run.
- **DNS lookup fails with anything other than `ENODATA`/`ENOTFOUND`** → that check
  is skipped. `ENODATA`/`ENOTFOUND` genuinely mean "the record does not exist" and
  *are* reported.
- **TLS handshake fails** → all web checks for that host are skipped.

Skipped probes are listed under "Checks skipped this run" in an issue that gets
filed anyway. A domain whose *only* output is skipped-probe notes is treated as
clean: notes alone never open or hold open an issue.

## The alert issue

One issue per domain, titled
`[domain-posture-scanner] Sub-optimal settings for <domain>`, filed in
`SELF_REPO` via `ensureAlertIssue` with `refreshBody: true` — the body is a pure
function of current state, so a check you fix disappears from the table on the
next run. It carries the **Claws Ignore** label: fixes live in a registrar
console or a DNS zone, not in this repo, so the issue-dispatcher must not try to
plan or implement them.

Registrar names, vCard values and HTTP header values are third-party strings and
are sanitised before they reach the Markdown table (pipes escaped, backticks and
newlines stripped, truncated to 120 characters).
