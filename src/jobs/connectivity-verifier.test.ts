import { beforeEach, describe, expect, it, vi } from "vitest";

const deferredPairingDetail =
  "pairing deferred until first active start; verify-only instances do not claim the WhatsApp device slot";

const { mockConfig, mockFs, mockExecFile, mockFetch, mockLookup, mockHealthCheck, mockInsertVerificationReport, mockGetLatestVerificationReport, mockEnsureGitHubAppConfigured, mockGetAnyInstallationToken, mockIsGitHubAppEnabled, mockBuildSshArgs, mockInfo, mockWarn, mockError, mockImapConnect, mockImapLogout } = vi.hoisted(() => {
  const mockConfig = {
    DB_PATH: "/tmp/claws.db",
    OPENROUTER_API_KEY: "openrouter-token",
    SLACK_WEBHOOK: "https://hooks.slack.com/services/T000/B000/XXX",
    EMAIL_ENABLED: true,
    EMAIL_USER: "user@example.com",
    EMAIL_APP_PASSWORD: "app-password",
    RUNNER_HOSTS: [
      {
        name: "runner-1",
        host: "runner.example.com",
        user: "claws",
        port: 22,
        identityFile: "/tmp/id_ed25519",
      },
    ],
    OLLAMA_BASE_URL: "http://ollama.local:11434",
    WHATSAPP_ENABLED: true,
    WHATSAPP_AUTH_DIR: "/tmp/whatsapp-auth",
    HOME_ASSISTANT_BASE_URL: "http://homeassistant.local:8123",
    HOME_ASSISTANT_TOKEN: "ha-token",
    ACTIVATION_STATE: "verify-only" as "verify-only" | "active",
    SESSION_BACKEND: "local-tmux" as "local-tmux" | "k8s-pod",
    SESSION_POD_SETTINGS: { namespace: "claws-sessions", image: "ghcr.io/st-john-software/claws:v1" },
    BROWSER_CDP_ENDPOINT: "",
  };
  const mockFs = {
    existsSync: vi.fn(),
    readFileSync: vi.fn(),
  };
  const mockExecFile = vi.fn();
  const mockFetch = vi.fn();
  const mockLookup = vi.fn();
  const mockHealthCheck = vi.fn();
  const mockInsertVerificationReport = vi.fn();
  const mockGetLatestVerificationReport = vi.fn();
  const mockEnsureGitHubAppConfigured = vi.fn();
  const mockGetAnyInstallationToken = vi.fn();
  const mockIsGitHubAppEnabled = vi.fn();
  const mockBuildSshArgs = vi.fn();
  const mockInfo = vi.fn();
  const mockWarn = vi.fn();
  const mockError = vi.fn();
  const mockImapConnect = vi.fn();
  const mockImapLogout = vi.fn();

  return {
    mockConfig,
    mockFs,
    mockExecFile,
    mockFetch,
    mockLookup,
    mockHealthCheck,
    mockInsertVerificationReport,
    mockGetLatestVerificationReport,
    mockEnsureGitHubAppConfigured,
    mockGetAnyInstallationToken,
    mockIsGitHubAppEnabled,
    mockBuildSshArgs,
    mockInfo,
    mockWarn,
    mockError,
    mockImapConnect,
    mockImapLogout,
  };
});

vi.mock("../config.js", () => mockConfig);
vi.mock("node:fs", () => ({ default: mockFs }));
vi.mock("node:child_process", () => ({
  execFile: (_cmd: string, _args: string[], _opts: unknown, cb: (...args: unknown[]) => void) => {
    mockExecFile(_cmd, _args, _opts, cb);
  },
}));
vi.mock("node:util", () => ({
  promisify: (fn: (...args: unknown[]) => unknown) => {
    return (...args: unknown[]) =>
      new Promise((resolve, reject) => {
        fn(...args, (err: unknown, stdoutOrResult: unknown, stderr?: unknown) => {
          if (err) {
            reject(err);
            return;
          }
          if (typeof stderr !== "undefined") {
            resolve({ stdout: stdoutOrResult, stderr });
            return;
          }
          resolve(stdoutOrResult);
        });
      });
  },
}));
vi.mock("node:dns/promises", () => ({
  default: {
    lookup: mockLookup,
  },
}));
vi.mock("../db.js", () => ({
  healthCheck: mockHealthCheck,
  insertVerificationReport: mockInsertVerificationReport,
  getLatestVerificationReport: mockGetLatestVerificationReport,
  describeDatabaseTarget: () => "SQLite (/tmp/claws.db)",
}));
vi.mock("../log.js", () => ({
  info: mockInfo,
  warn: mockWarn,
  error: mockError,
}));
vi.mock("../github-app.js", () => ({
  ensureGitHubAppConfigured: mockEnsureGitHubAppConfigured,
  getAnyInstallationToken: mockGetAnyInstallationToken,
  isGitHubAppEnabled: mockIsGitHubAppEnabled,
}));
vi.mock("../ssh.js", () => ({
  buildSshArgs: mockBuildSshArgs,
}));
const { mockIsContainer, mockAccessReview } = vi.hoisted(() => ({
  mockIsContainer: vi.fn(() => false),
  mockAccessReview: vi.fn(),
}));
vi.mock("../runtime-env.js", () => ({ isContainer: mockIsContainer }));
vi.mock("../k8s/api.js", () => ({
  createK8sClient: () => ({ selfSubjectAccessReview: mockAccessReview }),
}));

const { MockImapFlow } = vi.hoisted(() => {
  class MockImapFlow {
    async connect() {
      return mockImapConnect();
    }

    async logout() {
      return mockImapLogout();
    }
  }

  return { MockImapFlow };
});

vi.mock("imapflow", () => ({
  ImapFlow: MockImapFlow,
}));

vi.stubGlobal("fetch", mockFetch);

import { runConnectivityVerification } from "./connectivity-verifier.js";

function installSuccessfulBaseline() {
  mockFs.existsSync.mockImplementation((file: string) => file.endsWith("creds.json"));
  mockFs.readFileSync.mockReturnValue(JSON.stringify({ me: { id: "447700900000:1@s.whatsapp.net" } }));
  mockIsGitHubAppEnabled.mockReturnValue(true);
  mockGetAnyInstallationToken.mockResolvedValue("gh-token-1234");
  mockLookup.mockResolvedValue({ address: "127.0.0.1", family: 4 });
  mockBuildSshArgs.mockReturnValue(["-o", "StrictHostKeyChecking=yes"]);
  mockImapConnect.mockResolvedValue(undefined);
  mockImapLogout.mockResolvedValue(undefined);
  mockFetch.mockImplementation(async (url: string) => {
    if (url === "https://openrouter.ai/api/v1/models") return { ok: true, status: 200 };
    if (url === "http://ollama.local:11434/api/tags") return { ok: true, status: 200 };
    if (url === "http://homeassistant.local:8123/api/") return { ok: true, status: 200 };
    throw new Error(`unexpected fetch ${url}`);
  });
  mockExecFile.mockImplementation(
    (_cmd: string, _args: string[], _opts: unknown, cb: (err: null, stdout: string, stderr: string) => void) => {
      cb(null, "ok\n", "");
    },
  );
}

async function getWhatsAppRow() {
  const report = await runConnectivityVerification();
  const row = report.checks.find((check) => check.name === "whatsapp-auth");
  expect(row).toBeDefined();
  return row!;
}

describe("connectivity-verifier whatsapp auth", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockConfig.ACTIVATION_STATE = "verify-only";
    mockConfig.WHATSAPP_ENABLED = true;
    installSuccessfulBaseline();
  });

  it("reports deferred pairing as OK in verify-only mode when creds.json is absent", async () => {
    mockFs.existsSync.mockReturnValue(false);

    const row = await getWhatsAppRow();

    expect(row.ok).toBe(true);
    expect(row.detail).toBe(deferredPairingDetail);
  });

  it("reports deferred pairing as OK in verify-only mode when creds.json is unregistered", async () => {
    mockFs.readFileSync.mockReturnValue(JSON.stringify({}));

    const row = await getWhatsAppRow();

    expect(row.ok).toBe(true);
    expect(row.detail).toBe(deferredPairingDetail);
  });

  it("fails in active mode when creds.json is absent", async () => {
    mockConfig.ACTIVATION_STATE = "active";
    mockFs.existsSync.mockReturnValue(false);

    const row = await getWhatsAppRow();

    expect(row.ok).toBe(false);
    expect(row.detail).toBe("pairing required on first active start (no creds.json)");
  });

  it("fails in active mode when creds.json is present but unregistered", async () => {
    mockConfig.ACTIVATION_STATE = "active";
    mockFs.readFileSync.mockReturnValue(JSON.stringify({}));

    const row = await getWhatsAppRow();

    expect(row.ok).toBe(false);
    expect(row.detail).toBe("creds.json present but not registered — pairing required");
  });

  it("reports a registered session as paired in any mode", async () => {
    mockConfig.ACTIVATION_STATE = "active";

    const row = await getWhatsAppRow();

    expect(row.ok).toBe(true);
    expect(row.detail).toBe("paired (/tmp/whatsapp-auth/creds.json exists)");
  });
});

describe("connectivity-verifier kubectl and tmux", () => {
  beforeEach(() => {
    installSuccessfulBaseline();
  });

  it("reports the kubectl client version when available", async () => {
    mockExecFile.mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown, cb: (err: unknown, stdout: string, stderr: string) => void) => {
        if (_cmd === "kubectl") {
          cb(null, JSON.stringify({ clientVersion: { gitVersion: "v1.31.4" } }), "");
          return;
        }
        cb(null, "ok\n", "");
      },
    );

    const report = await runConnectivityVerification();
    const row = report.checks.find((c) => c.name === "kubectl");

    expect(row?.ok).toBe(true);
    expect(row?.detail).toBe("v1.31.4");
  });

  it("fails the kubectl check when the binary is missing", async () => {
    mockExecFile.mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown, cb: (err: unknown, stdout: string | null, stderr: string | null) => void) => {
        if (_cmd === "kubectl") {
          cb(new Error("kubectl: command not found"), null, null);
          return;
        }
        cb(null, "ok\n", "");
      },
    );

    const report = await runConnectivityVerification();
    const row = report.checks.find((c) => c.name === "kubectl");

    expect(row?.ok).toBe(false);
    expect(row?.detail).toContain("command not found");
  });

  it("reports tmux using its -V version flag", async () => {
    let tmuxArgs: string[] | undefined;
    mockExecFile.mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown, cb: (err: unknown, stdout: string, stderr: string) => void) => {
        if (_cmd === "tmux") {
          tmuxArgs = _args;
          cb(null, "tmux 3.4\n", "");
          return;
        }
        cb(null, "ok\n", "");
      },
    );

    const report = await runConnectivityVerification();
    const row = report.checks.find((c) => c.name === "tmux");

    expect(tmuxArgs).toEqual(["-V"]);
    expect(row?.ok).toBe(true);
    expect(row?.detail).toBe("tmux 3.4");
  });
});

describe("connectivity-verifier session-backend", () => {
  beforeEach(() => {
    installSuccessfulBaseline();
    mockConfig.SESSION_BACKEND = "local-tmux";
    mockConfig.SESSION_POD_SETTINGS = { namespace: "claws-sessions", image: "ghcr.io/st-john-software/claws:v1" };
    mockIsContainer.mockReturnValue(false);
    mockAccessReview.mockReset();
  });

  async function sessionRow() {
    const report = await runConnectivityVerification();
    const row = report.checks.find((c) => c.name === "session-backend");
    expect(row).toBeDefined();
    return row!;
  }

  it("passes local-tmux on a host when tmux runs", async () => {
    const row = await sessionRow();
    expect(row.ok).toBe(true);
    expect(row.detail).toContain("local-tmux");
  });

  it("fails local-tmux inside a container as a cutover blocker", async () => {
    mockIsContainer.mockReturnValue(true);
    const row = await sessionRow();
    expect(row.ok).toBe(false);
    expect(row.detail).toContain("local tmux inside the service container is killed by every rollout — cutover blocker (#3026)");
  });

  it("fails k8s-pod when the image is empty", async () => {
    mockConfig.SESSION_BACKEND = "k8s-pod";
    mockConfig.SESSION_POD_SETTINGS = { namespace: "claws-sessions", image: "" };
    const row = await sessionRow();
    expect(row.ok).toBe(false);
    expect(row.detail).toContain("CLAWS_SESSION_IMAGE");
    expect(mockAccessReview).not.toHaveBeenCalled();
  });

  it("passes k8s-pod when every required verb is allowed", async () => {
    mockConfig.SESSION_BACKEND = "k8s-pod";
    mockAccessReview.mockResolvedValue({ ok: true, value: { allowed: true } });
    const row = await sessionRow();
    expect(row.ok).toBe(true);
    const asked = mockAccessReview.mock.calls.map(([r]) => `${r.verb} ${r.resource}`).sort();
    expect(asked).toEqual([
      "create persistentvolumeclaims", "create pods", "create secrets", "create services",
      "delete persistentvolumeclaims", "delete pods", "delete secrets", "delete services",
      "get persistentvolumeclaims", "get pods", "get secrets", "get services",
      "list persistentvolumeclaims", "list pods",
      "patch secrets",
    ]);
    for (const [r] of mockAccessReview.mock.calls) expect(r.namespace).toBe("claws-sessions");
  });

  it("names the denied verbs for k8s-pod", async () => {
    mockConfig.SESSION_BACKEND = "k8s-pod";
    mockAccessReview.mockImplementation(async (r: { verb: string; resource: string }) => ({
      ok: true,
      value: { allowed: !(r.resource === "secrets" && r.verb === "patch") },
    }));
    const row = await sessionRow();
    expect(row.ok).toBe(false);
    expect(row.detail).toContain("patch secrets");
  });

  it("fails k8s-pod when the access review itself fails", async () => {
    mockConfig.SESSION_BACKEND = "k8s-pod";
    mockAccessReview.mockResolvedValue({ ok: false, kind: "unreachable", message: "POST /apis/...: ECONNREFUSED" });
    const row = await sessionRow();
    expect(row.ok).toBe(false);
    expect(row.detail).toContain("access review failed");
  });
});

describe("connectivity-verifier browser-service", () => {
  beforeEach(() => {
    installSuccessfulBaseline();
    mockConfig.BROWSER_CDP_ENDPOINT = "";
  });

  async function browserRow() {
    const report = await runConnectivityVerification();
    const row = report.checks.find((c) => c.name === "browser-service");
    expect(row).toBeDefined();
    return row!;
  }

  it("passes as optional when no endpoint is configured", async () => {
    const row = await browserRow();
    expect(row).toMatchObject({ ok: true, detail: "not configured (optional) — local Chromium" });
  });

  it("reports running and queued counts without the token when reachable", async () => {
    mockConfig.BROWSER_CDP_ENDPOINT = "ws://browser.default.svc.cluster.local:3000/?token=browserless-secret";
    const baseline = mockFetch.getMockImplementation()!;
    mockFetch.mockImplementation(async (url: string, init?: unknown) => {
      if (url === "http://browser.default.svc.cluster.local:3000/pressure?token=browserless-secret") {
        return { ok: true, status: 200, json: async () => ({ pressure: { running: 1, maxConcurrent: 2, queued: 0, maxQueued: 10 } }) };
      }
      return baseline(url, init);
    });
    const row = await browserRow();
    expect(row).toMatchObject({ ok: true, detail: "ws://browser.default.svc.cluster.local:3000/: running 1/2, queued 0/10" });
  });

  it("fails with the error name only when unreachable", async () => {
    mockConfig.BROWSER_CDP_ENDPOINT = "ws://browser.default.svc.cluster.local:3000/?token=browserless-secret";
    const row = await browserRow();
    expect(row.ok).toBe(false);
    expect(row.detail).toBe("ws://browser.default.svc.cluster.local:3000/: unreachable (Error)");
    expect(row.detail).not.toContain("browserless-secret");
  });

  it("fails with the HTTP status on a non-2xx response", async () => {
    mockConfig.BROWSER_CDP_ENDPOINT = "ws://browser.default.svc.cluster.local:3000/?token=browserless-secret";
    const baseline = mockFetch.getMockImplementation()!;
    mockFetch.mockImplementation(async (url: string, init?: unknown) =>
      url.includes("/pressure") ? { ok: false, status: 401 } : baseline(url, init),
    );
    const row = await browserRow();
    expect(row).toMatchObject({ ok: false, detail: "ws://browser.default.svc.cluster.local:3000/: HTTP 401" });
  });
});
