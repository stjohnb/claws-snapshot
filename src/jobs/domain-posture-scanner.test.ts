import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../config.js", () => ({
  SELF_REPO: "test-org/claws",
  LABELS: { clawsIgnore: "Claws Ignore" },
}));

vi.mock("../log.js", () => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

const { mockGh, mockOccurrence, mockReporter } = vi.hoisted(() => ({
  mockGh: {
    fetchRepoFileContent: vi.fn(),
  },
  mockOccurrence: {
    ensureAlertIssue: vi.fn(),
    closeAlertIssueIfResolved: vi.fn(),
  },
  mockReporter: {
    reportError: vi.fn(),
  },
}));

vi.mock("../github.js", () => mockGh);
vi.mock("../occurrence-tracking.js", () => mockOccurrence);
vi.mock("../error-reporter.js", () => mockReporter);

import {
  parseDomainsManifest,
  normalizeRdap,
  evaluateRdap,
  evaluateDns,
  evaluateWeb,
  cell,
  run,
  MALFORMED_ISSUE_TITLE,
  type DnsFacts,
  type Probes,
  type RdapDomain,
  type WebFacts,
} from "./domain-posture-scanner.js";

const NOW = new Date("2026-08-21T12:00:00Z");
const DAY_MS = 86_400_000;

/** Valid-on-every-axis RDAP response; individual tests override the member under test. */
function rdap(overrides: Partial<RdapDomain> = {}): RdapDomain {
  return {
    status: ["client transfer prohibited"],
    secureDNS: { delegationSigned: true },
    events: [{ eventAction: "expiration", eventDate: "2027-09-10T00:00:00Z" }],
    entities: [],
    ...overrides,
  };
}

/** The real namey.baby shape: a registrar entity with a nested abuse contact, and no owner entity. */
const REDACTED_ENTITIES: RdapDomain["entities"] = [
  {
    roles: ["registrar"],
    vcardArray: [
      "vcard",
      [
        ["version", {}, "text", "4.0"],
        ["fn", {}, "text", "NameCheap, Inc."],
      ],
    ],
    entities: [
      {
        roles: ["abuse"],
        vcardArray: [
          "vcard",
          [
            ["fn", {}, "text", "NameCheap Abuse"],
            ["email", {}, "text", "abuse@namecheap.com"],
            ["tel", {}, "text", "+1.6613102107"],
          ],
        ],
        entities: [],
      },
    ],
  },
];

function dnsFacts(overrides: Partial<DnsFacts> = {}): DnsFacts {
  return {
    caa: ['0 issue "letsencrypt.org"'],
    mx: ["mx1.example.com"],
    txt: ["v=spf1 include:spf.example.com ~all"],
    dmarc: ["v=DMARC1; p=reject; rua=mailto:dmarc@example.com"],
    ...overrides,
  };
}

function webFacts(overrides: Partial<WebFacts> = {}): WebFacts {
  return {
    authorized: true,
    authorizationError: null,
    validTo: "Oct 19 2026 GMT",
    protocol: "TLSv1.3",
    headers: {
      "strict-transport-security": "max-age=31536000; includeSubDomains",
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'self'",
    },
    httpRedirect: { status: 301, location: "https://namey.baby/" },
    ...overrides,
  };
}

const ids = (findings: { id: string }[]): string[] => findings.map((f) => f.id);

describe("parseDomainsManifest", () => {
  it("parses a valid manifest and defaults web/ignore", () => {
    const result = parseDomainsManifest(
      ["domains:", "  - domain: namey.baby", "    project: namey", "    web: [namey.baby]", "  - domain: perudo.net", "    project: perudo"].join("\n"),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.manifest.domains).toHaveLength(2);
    expect(result.manifest.domains[0]!.web).toEqual(["namey.baby"]);
    expect(result.manifest.domains[1]!.web).toEqual([]);
    expect(result.manifest.domains[1]!.ignore).toEqual([]);
  });

  it("rejects a duplicate domain", () => {
    const result = parseDomainsManifest(
      ["domains:", "  - domain: namey.baby", "    project: a", "  - domain: namey.baby", "    project: b"].join("\n"),
    );
    expect(result).toEqual({ ok: false, error: 'duplicate domain "namey.baby"' });
  });

  it("rejects an entry missing project", () => {
    const result = parseDomainsManifest(["domains:", "  - domain: namey.baby"].join("\n"));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("domains.0.project");
  });

  it("rejects invalid YAML", () => {
    const result = parseDomainsManifest("domains: [\n  - {");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("invalid YAML");
  });

  it("parses the repo's own docs/domains.yaml", async () => {
    const fs = await import("node:fs");
    const result = parseDomainsManifest(fs.readFileSync("docs/domains.yaml", "utf8"));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.manifest.domains.map((d) => d.domain)).toContain("namey.baby");
  });
});

describe("normalizeRdap", () => {
  it("parses a realistic raw RDAP payload, tolerating extra members and malformed arrays", () => {
    const raw = {
      objectClassName: "domain",
      handle: "EXAMPLE1-COM",
      ldhName: "EXAMPLE.COM",
      links: [{ value: "https://rdap.example.com/domain/EXAMPLE.COM", rel: "self" }],
      status: ["client transfer prohibited", 42, null, "active"],
      events: [
        { eventAction: "registration", eventDate: "2010-01-01T00:00:00Z", eventActor: null },
        { eventAction: "expiration", eventDate: "2027-01-01T00:00:00Z" },
        { eventAction: "last changed" }, // missing eventDate — dropped
        "not an event object", // dropped
      ],
      entities: [
        {
          objectClassName: "entity",
          handle: "REG1",
          roles: ["registrar", 7, null],
          vcardArray: ["vcard", [["fn", {}, "text", "Example Registrar, Inc."]]],
          entities: [
            {
              roles: ["technical"],
              entities: [
                {
                  roles: ["administrative"],
                  entities: [
                    {
                      roles: ["billing"],
                      entities: [
                        // depth 5 — beyond MAX_ENTITY_DEPTH (4), must be dropped entirely.
                        { roles: ["registrant"], vcardArray: ["vcard", [["fn", {}, "text", "Too Deep"]]] },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
        "not an entity object", // dropped
        null, // dropped
      ],
      notices: [{ title: "Terms of Use" }],
    };

    const result = normalizeRdap(raw);

    expect(result.status).toEqual(["client transfer prohibited", "active"]);
    expect(result.secureDNS).toBeUndefined();
    expect(result.events).toEqual([
      { eventAction: "registration", eventDate: "2010-01-01T00:00:00Z" },
      { eventAction: "expiration", eventDate: "2027-01-01T00:00:00Z" },
    ]);

    expect(result.entities).toHaveLength(1);
    const registrar = result.entities[0]!;
    expect(registrar.roles).toEqual(["registrar"]);

    let node = registrar;
    for (let depth = 1; depth <= 3; depth++) {
      expect(node.entities).toHaveLength(1);
      node = node.entities![0]!;
    }
    expect(node.entities).toEqual([]);
  });

  it("defaults every field for a non-object or empty payload", () => {
    expect(normalizeRdap(null)).toEqual({ status: [], secureDNS: undefined, events: [], entities: [] });
    expect(normalizeRdap("not json")).toEqual({ status: [], secureDNS: undefined, events: [], entities: [] });
    expect(normalizeRdap({})).toEqual({ status: [], secureDNS: undefined, events: [], entities: [] });
  });

  it("normalizes secureDNS.delegationSigned strictly to a boolean", () => {
    expect(normalizeRdap({ secureDNS: { delegationSigned: true } }).secureDNS).toEqual({
      delegationSigned: true,
    });
    expect(normalizeRdap({ secureDNS: { delegationSigned: "true" } }).secureDNS).toEqual({
      delegationSigned: false,
    });
    expect(normalizeRdap({ secureDNS: {} }).secureDNS).toEqual({ delegationSigned: false });
  });
});

describe("evaluateRdap", () => {
  it("returns no findings when RDAP is unavailable", () => {
    expect(evaluateRdap(null, NOW)).toEqual([]);
  });

  it("does not flag the real redacted namey.baby shape", () => {
    expect(evaluateRdap(rdap({ entities: REDACTED_ENTITIES }), NOW)).toEqual([]);
  });

  it("flags an unredacted registrant vCard value", () => {
    const findings = evaluateRdap(
      rdap({
        entities: [
          {
            roles: ["registrant"],
            vcardArray: [
              "vcard",
              [
                ["version", {}, "text", "4.0"],
                ["fn", {}, "text", "Brendan St John"],
                ["adr", {}, "text", ["", "", "1 Example Street", "London", "", "SW1A 1AA", "GB"]],
              ],
            ],
            entities: [],
          },
        ],
      }),
      NOW,
    );
    expect(ids(findings)).toEqual(["whois-contact-exposed", "whois-contact-exposed"]);
    expect(findings[0]!.detail).toContain("Brendan St John");
    expect(findings[1]!.detail).toContain("1 Example Street, London, SW1A 1AA, GB");
  });

  it("does not flag redaction placeholders or an entity with no vCard", () => {
    const findings = evaluateRdap(
      rdap({
        entities: [
          {
            roles: ["registrant"],
            vcardArray: ["vcard", [["fn", {}, "text", "REDACTED FOR PRIVACY"]]],
            entities: [],
          },
          { roles: ["technical"], entities: [] },
        ],
      }),
      NOW,
    );
    expect(findings).toEqual([]);
  });

  it("flags a missing transfer lock", () => {
    expect(ids(evaluateRdap(rdap({ status: ["active"] }), NOW))).toEqual(["registrar-lock-missing"]);
  });

  it("flags an unsigned delegation", () => {
    expect(ids(evaluateRdap(rdap({ secureDNS: { delegationSigned: false } }), NOW))).toEqual([
      "dnssec-unsigned",
    ]);
    expect(ids(evaluateRdap(rdap({ secureDNS: undefined }), NOW))).toEqual(["dnssec-unsigned"]);
  });

  it("flags expiry inside 45 days but not outside it", () => {
    const at = (days: number) => new Date(NOW.getTime() + days * DAY_MS).toISOString();
    const within = rdap({ events: [{ eventAction: "expiration", eventDate: at(44) }] });
    const outside = rdap({ events: [{ eventAction: "expiration", eventDate: at(46) }] });
    expect(ids(evaluateRdap(within, NOW))).toEqual(["registration-expiring"]);
    expect(ids(evaluateRdap(outside, NOW))).toEqual([]);
  });

  it("ignores an unparseable or absent expiry date", () => {
    expect(ids(evaluateRdap(rdap({ events: [] }), NOW))).toEqual([]);
    expect(
      ids(evaluateRdap(rdap({ events: [{ eventAction: "expiration", eventDate: "never" }] }), NOW)),
    ).toEqual([]);
  });
});

describe("evaluateDns", () => {
  it("returns no findings for a healthy zone", () => {
    expect(evaluateDns(dnsFacts(), NOW)).toEqual([]);
  });

  it("flags an empty record set but skips a failed lookup", () => {
    expect(ids(evaluateDns(dnsFacts({ caa: [] }), NOW))).toEqual(["caa-missing"]);
    expect(ids(evaluateDns(dnsFacts({ caa: null }), NOW))).toEqual([]);
    expect(ids(evaluateDns(dnsFacts({ dmarc: [] }), NOW))).toEqual(["dmarc-missing"]);
    expect(ids(evaluateDns(dnsFacts({ dmarc: null }), NOW))).toEqual([]);
    expect(ids(evaluateDns(dnsFacts({ txt: [] }), NOW))).toEqual(["spf-missing"]);
    expect(ids(evaluateDns(dnsFacts({ txt: null }), NOW))).toEqual([]);
  });

  it("flags p=none but not p=quarantine", () => {
    expect(ids(evaluateDns(dnsFacts({ dmarc: ["v=DMARC1; p=none; rua=mailto:x@y"] }), NOW))).toEqual([
      "dmarc-policy-none",
    ]);
    expect(ids(evaluateDns(dnsFacts({ dmarc: ["v=DMARC1; p=quarantine"] }), NOW))).toEqual([]);
  });

  it("flags +all and a bare all, but not ~all or -all", () => {
    expect(ids(evaluateDns(dnsFacts({ txt: ["v=spf1 include:x +all"] }), NOW))).toEqual([
      "spf-permissive",
    ]);
    expect(ids(evaluateDns(dnsFacts({ txt: ["v=spf1 all"] }), NOW))).toEqual(["spf-permissive"]);
    expect(ids(evaluateDns(dnsFacts({ txt: ["v=spf1 include:x ~all"] }), NOW))).toEqual([]);
    expect(ids(evaluateDns(dnsFacts({ txt: ["v=spf1 include:x -all"] }), NOW))).toEqual([]);
  });

  it("mentions MX records in the spf-missing detail when the domain receives mail", () => {
    const [finding] = evaluateDns(dnsFacts({ txt: [], mx: ["mx1.example.com"] }), NOW);
    expect(finding!.detail).toContain("1 MX record(s)");
  });
});

describe("evaluateWeb", () => {
  it("returns no findings for a well-configured host", () => {
    expect(evaluateWeb("namey.baby", webFacts(), NOW)).toEqual([]);
  });

  it("flags an invalid certificate", () => {
    const findings = evaluateWeb(
      "namey.baby",
      webFacts({ authorized: false, authorizationError: "ERR_TLS_CERT_ALTNAME_INVALID" }),
      NOW,
    );
    expect(ids(findings)).toEqual(["tls-invalid"]);
    expect(findings[0]!.detail).toContain("ERR_TLS_CERT_ALTNAME_INVALID");
    expect(findings[0]!.host).toBe("namey.baby");
  });

  it("flags a certificate expiring inside 14 days but not outside it", () => {
    const at = (days: number) => new Date(NOW.getTime() + days * DAY_MS).toUTCString();
    expect(ids(evaluateWeb("h", webFacts({ validTo: at(13) }), NOW))).toEqual(["tls-expiring"]);
    expect(ids(evaluateWeb("h", webFacts({ validTo: at(15) }), NOW))).toEqual([]);
  });

  it("flags a missing HTTP→HTTPS redirect but accepts a 308 to https", () => {
    expect(
      ids(evaluateWeb("h", webFacts({ httpRedirect: { status: 200, location: null } }), NOW)),
    ).toEqual(["https-redirect-missing"]);
    expect(
      ids(evaluateWeb("h", webFacts({ httpRedirect: { status: 301, location: "http://h/" } }), NOW)),
    ).toEqual(["https-redirect-missing"]);
    expect(
      ids(evaluateWeb("h", webFacts({ httpRedirect: { status: 308, location: "https://h/" } }), NOW)),
    ).toEqual([]);
    expect(ids(evaluateWeb("h", webFacts({ httpRedirect: null }), NOW))).toEqual([]);
  });

  it("accepts a 180-day HSTS max-age and flags a short or absent one", () => {
    const withHeaders = (headers: Record<string, string>) => webFacts({ headers });
    const base = {
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'self'",
    };
    expect(
      ids(evaluateWeb("h", withHeaders({ ...base, "strict-transport-security": "max-age=31536000" }), NOW)),
    ).toEqual([]);
    expect(
      ids(evaluateWeb("h", withHeaders({ ...base, "strict-transport-security": "max-age=600" }), NOW)),
    ).toEqual(["hsts-missing"]);
    expect(ids(evaluateWeb("h", withHeaders(base), NOW))).toEqual(["hsts-missing"]);
  });

  it("reports one finding listing every missing security header", () => {
    const findings = evaluateWeb(
      "h",
      webFacts({ headers: { "strict-transport-security": "max-age=31536000" } }),
      NOW,
    );
    expect(ids(findings)).toEqual(["security-header-missing"]);
    expect(findings[0]!.detail).toContain("X-Content-Type-Options");
    expect(findings[0]!.detail).toContain("Content-Security-Policy");
  });

  it("accepts a report-only CSP", () => {
    expect(
      ids(
        evaluateWeb(
          "h",
          webFacts({
            headers: {
              "strict-transport-security": "max-age=31536000",
              "x-content-type-options": "nosniff",
              "content-security-policy-report-only": "default-src 'self'",
            },
          }),
          NOW,
        ),
      ),
    ).toEqual([]);
  });

  it("skips header checks when the HTTPS request failed", () => {
    expect(ids(evaluateWeb("h", webFacts({ headers: null }), NOW))).toEqual([]);
  });
});

describe("cell", () => {
  it("escapes pipes, strips backticks and newlines, and truncates", () => {
    expect(cell("a|b`c\nd")).toBe("a\\|bc d");
    expect(cell("x".repeat(200))).toHaveLength(120);
  });
});

describe("run", () => {
  const manifest = (body: string) => body;

  function stubProbes(over: Partial<Probes> = {}): Probes {
    return {
      rdap: vi.fn().mockResolvedValue(rdap({ entities: REDACTED_ENTITIES })),
      dns: vi.fn().mockResolvedValue(dnsFacts()),
      web: vi.fn().mockResolvedValue(webFacts()),
      ...over,
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mockOccurrence.ensureAlertIssue.mockResolvedValue({ outcome: "created", issueNumber: 1 });
    mockOccurrence.closeAlertIssueIfResolved.mockResolvedValue(null);
    mockGh.fetchRepoFileContent.mockResolvedValue(
      manifest(["domains:", "  - domain: namey.baby", "    project: namey"].join("\n")),
    );
  });

  it("does nothing when the manifest is missing", async () => {
    mockGh.fetchRepoFileContent.mockResolvedValue(null);

    await run(stubProbes());

    expect(mockOccurrence.ensureAlertIssue).not.toHaveBeenCalled();
    expect(mockOccurrence.closeAlertIssueIfResolved).not.toHaveBeenCalled();
  });

  it("files a malformed-manifest alert and scans nothing", async () => {
    mockGh.fetchRepoFileContent.mockResolvedValue("domains:\n  - domain: a.com\n  - domain: a.com\n");
    const probes = stubProbes();

    await run(probes);

    expect(mockOccurrence.ensureAlertIssue).toHaveBeenCalledTimes(1);
    expect(mockOccurrence.ensureAlertIssue.mock.calls[0]![0].title).toBe(MALFORMED_ISSUE_TITLE);
    expect(probes.rdap).not.toHaveBeenCalled();
  });

  it("closes the malformed-manifest alert once the manifest parses", async () => {
    await run(stubProbes());

    expect(mockOccurrence.closeAlertIssueIfResolved).toHaveBeenCalledWith(
      expect.objectContaining({ title: MALFORMED_ISSUE_TITLE }),
    );
  });

  it("closes the per-domain alert when a domain is clean", async () => {
    await run(stubProbes());

    const titles = mockOccurrence.closeAlertIssueIfResolved.mock.calls.map((c) => c[0].title);
    expect(titles).toContain("[domain-posture-scanner] Sub-optimal settings for namey.baby");
    expect(mockOccurrence.ensureAlertIssue).not.toHaveBeenCalled();
  });

  it("treats a domain whose only output is skipped-probe notes as clean", async () => {
    await run(
      stubProbes({
        rdap: vi.fn().mockResolvedValue(null),
        dns: vi.fn().mockResolvedValue({
          caa: null,
          mx: null,
          txt: null,
          dmarc: null,
          errors: { CAA: "ESERVFAIL", MX: "ESERVFAIL", TXT: "ESERVFAIL", DMARC: "ESERVFAIL" },
        } satisfies DnsFacts),
      }),
    );

    expect(mockOccurrence.ensureAlertIssue).not.toHaveBeenCalled();
    expect(mockOccurrence.closeAlertIssueIfResolved).toHaveBeenCalledWith(
      expect.objectContaining({ title: "[domain-posture-scanner] Sub-optimal settings for namey.baby" }),
    );
  });

  it("files one refreshing, Claws-Ignore-labelled issue per failing domain", async () => {
    await run(stubProbes({ dns: vi.fn().mockResolvedValue(dnsFacts({ caa: [], dmarc: [] })) }));

    expect(mockOccurrence.ensureAlertIssue).toHaveBeenCalledTimes(1);
    const opts = mockOccurrence.ensureAlertIssue.mock.calls[0]![0];
    expect(opts.title).toBe("[domain-posture-scanner] Sub-optimal settings for namey.baby");
    expect(opts.repo).toBe("test-org/claws");
    expect(opts.labels).toEqual(["Claws Ignore"]);
    expect(opts.refreshBody).toBe(true);
    expect(opts.body).toContain("`caa-missing`");
    expect(opts.body).toContain("`dmarc-missing`");
    expect(opts.body).toContain("NameCheap, Inc.");
    expect(opts.body).toContain("2027-09-10");
  });

  it("suppresses checks listed in the domain's ignore list", async () => {
    mockGh.fetchRepoFileContent.mockResolvedValue(
      ["domains:", "  - domain: namey.baby", "    project: namey", "    ignore: [caa-missing]"].join("\n"),
    );

    await run(stubProbes({ dns: vi.fn().mockResolvedValue(dnsFacts({ caa: [] })) }));

    expect(mockOccurrence.ensureAlertIssue).not.toHaveBeenCalled();
  });

  it("records skipped-probe notes in the body of an issue that is filed anyway", async () => {
    await run(
      stubProbes({
        rdap: vi.fn().mockResolvedValue(null),
        dns: vi.fn().mockResolvedValue(dnsFacts({ caa: [], mx: null, errors: { MX: "ESERVFAIL" } })),
      }),
    );

    const opts = mockOccurrence.ensureAlertIssue.mock.calls[0]![0];
    expect(opts.body).toContain("RDAP unavailable");
    expect(opts.body).toContain("DNS lookup for MX failed (ESERVFAIL)");
  });

  it("prefixes web findings with the host when a domain has several", async () => {
    mockGh.fetchRepoFileContent.mockResolvedValue(
      [
        "domains:",
        "  - domain: namey.baby",
        "    project: namey",
        "    web: [namey.baby, www.namey.baby]",
      ].join("\n"),
    );

    await run(
      stubProbes({
        web: vi.fn(async (host: string) =>
          host === "www.namey.baby" ? webFacts({ headers: {} }) : webFacts(),
        ),
      }),
    );

    const opts = mockOccurrence.ensureAlertIssue.mock.calls[0]![0];
    expect(opts.body).toContain("`www.namey.baby: hsts-missing`");
  });

  it("skips web checks for an unreachable host without filing anything", async () => {
    mockGh.fetchRepoFileContent.mockResolvedValue(
      ["domains:", "  - domain: namey.baby", "    project: namey", "    web: [namey.baby]"].join("\n"),
    );

    await run(stubProbes({ web: vi.fn().mockResolvedValue(null) }));

    expect(mockOccurrence.ensureAlertIssue).not.toHaveBeenCalled();
  });

  it("reports an unexpected failure through reportError", async () => {
    mockGh.fetchRepoFileContent.mockRejectedValue(new Error("boom"));

    await run(stubProbes());

    expect(mockReporter.reportError).toHaveBeenCalledWith(
      "domain-posture-scanner",
      "domain posture scan failed",
      expect.any(Error),
    );
  });

  it("keeps scanning other domains when one throws", async () => {
    mockGh.fetchRepoFileContent.mockResolvedValue(
      [
        "domains:",
        "  - domain: broken.test",
        "    project: a",
        "  - domain: namey.baby",
        "    project: namey",
      ].join("\n"),
    );

    await run(
      stubProbes({
        rdap: vi.fn(async (domain: string) => {
          if (domain === "broken.test") throw new Error("registry exploded");
          return rdap({ entities: REDACTED_ENTITIES });
        }),
      }),
    );

    expect(mockReporter.reportError).not.toHaveBeenCalled();
    const titles = mockOccurrence.closeAlertIssueIfResolved.mock.calls.map((c) => c[0].title);
    expect(titles).toContain("[domain-posture-scanner] Sub-optimal settings for namey.baby");
  });
});
