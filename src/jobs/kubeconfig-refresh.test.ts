import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Hoisted mocks ──

const mockExecFile = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({
  execFile: mockExecFile,
}));

const mockWriteFileSync = vi.hoisted(() => vi.fn());
const mockRenameSync = vi.hoisted(() => vi.fn());
vi.mock("node:fs", () => ({
  writeFileSync: mockWriteFileSync,
  renameSync: mockRenameSync,
}));

vi.mock("../log.js", () => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

import { isStaleKubeconfigError, resolveTailscaleHost, refreshKubeconfig } from "./kubeconfig-refresh.js";

// ── Helpers ──

function makeTailscaleStatus(peers: Array<{ HostName: string; TailscaleIPs: string[]; Online: boolean }>) {
  const Peer: Record<string, unknown> = {};
  peers.forEach((p, i) => { Peer[`nodekey:${i}`] = p; });
  return JSON.stringify({ Self: { HostName: "claws-host", TailscaleIPs: ["100.1.1.1"], Online: true }, Peer });
}

function makeExecFile(responses: Array<{ cmd: string; out: string } | { cmd: string; err: string }>) {
  let idx = 0;
  mockExecFile.mockImplementation(
    (cmd: string, _args: string[], _opts: unknown, cb: (err: Error | null, stdout: string, stderr: string) => void) => {
      const r = responses[idx++];
      if (!r) { cb(new Error("unexpected execFile call"), "", ""); return; }
      if ("err" in r) { cb(new Error(r.err), "", r.err); }
      else { cb(null, r.out, ""); }
    },
  );
}

const VALID_KUBECONFIG = `apiVersion: v1
clusters:
- cluster:
    server: https://127.0.0.1:6443
  name: local
contexts: []
current-context: local
`;

// ── isStaleKubeconfigError ──

describe("isStaleKubeconfigError", () => {
  it("true for #1686 timeout message", () => {
    expect(isStaleKubeconfigError(new Error("kubectl get pods --all-namespaces timed out after 30s (server https://100.86.229.9:6443, cluster unreachable?)"))).toBe(true);
  });

  it("true for connection refused", () => {
    expect(isStaleKubeconfigError(new Error("connection refused"))).toBe(true);
  });

  it("true for x509 cert error", () => {
    expect(isStaleKubeconfigError(new Error("x509: certificate signed by unknown authority"))).toBe(true);
  });

  it("true for Unauthorized", () => {
    expect(isStaleKubeconfigError(new Error("You must be logged in to the server (Unauthorized)"))).toBe(true);
  });

  it("false for Forbidden", () => {
    expect(isStaleKubeconfigError(new Error("Forbidden: user cannot list pods"))).toBe(false);
  });

  it("false for command not found", () => {
    expect(isStaleKubeconfigError(new Error("kubectl: command not found"))).toBe(false);
  });
});

// ── resolveTailscaleHost ──

describe("resolveTailscaleHost", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("returns IPv4 for matching peer by HostName", async () => {
    makeExecFile([{
      cmd: "tailscale",
      out: makeTailscaleStatus([{ HostName: "prod-k8s", TailscaleIPs: ["100.86.229.9", "fd7a::1"], Online: true }]),
    }]);
    const ip = await resolveTailscaleHost("prod-k8s");
    expect(ip).toBe("100.86.229.9");
  });

  it("prefers the Online peer when two share the same name", async () => {
    const status = JSON.stringify({
      Self: { HostName: "claws-host", TailscaleIPs: ["100.1.1.1"], Online: true },
      Peer: {
        "nodekey:0": { HostName: "prod-k8s", TailscaleIPs: ["100.86.229.9"], Online: false },
        "nodekey:1": { HostName: "prod-k8s", TailscaleIPs: ["100.86.229.10"], Online: true },
      },
    });
    makeExecFile([{ cmd: "tailscale", out: status }]);
    const ip = await resolveTailscaleHost("prod-k8s");
    expect(ip).toBe("100.86.229.10");
  });

  it("matches on the leading label of DNSName (FQDN)", async () => {
    const status = JSON.stringify({
      Self: { HostName: "claws-host", TailscaleIPs: ["100.1.1.1"], Online: true },
      Peer: {
        "nodekey:0": { HostName: "some-other-name", DNSName: "prod-k8s.example.ts.net.", TailscaleIPs: ["100.86.229.9"], Online: true },
      },
    });
    makeExecFile([{ cmd: "tailscale", out: status }]);
    const ip = await resolveTailscaleHost("prod-k8s");
    expect(ip).toBe("100.86.229.9");
  });

  it("matches a -N suffixed device when the base name has none (rebuilt node)", async () => {
    // The configured name is "prod-k8s" but the live device has been renamed
    // "prod-k8s-8" by Tailscale after repeated rebuilds (its DNSName carries the
    // suffix even though the OS HostName stays "prod-k8s").
    const status = JSON.stringify({
      Self: { HostName: "claws-host", TailscaleIPs: ["100.1.1.1"], Online: true },
      Peer: {
        "nodekey:0": { HostName: "prod-k8s", DNSName: "prod-k8s-8.example.ts.net.", TailscaleIPs: ["100.86.229.20"], Online: true },
      },
    });
    makeExecFile([{ cmd: "tailscale", out: status }]);
    const ip = await resolveTailscaleHost("prod-k8s");
    expect(ip).toBe("100.86.229.20");
  });

  it("prefers the Online device over a higher-suffixed offline one", async () => {
    // Stale -7 device lingers offline; the live device is the online -8.
    const status = JSON.stringify({
      Self: { HostName: "claws-host", TailscaleIPs: ["100.1.1.1"], Online: true },
      Peer: {
        "nodekey:0": { HostName: "prod-k8s", DNSName: "prod-k8s.example.ts.net.", TailscaleIPs: ["100.86.229.1"], Online: false },
        "nodekey:1": { HostName: "prod-k8s", DNSName: "prod-k8s-7.example.ts.net.", TailscaleIPs: ["100.86.229.7"], Online: false },
        "nodekey:2": { HostName: "prod-k8s", DNSName: "prod-k8s-8.example.ts.net.", TailscaleIPs: ["100.86.229.8"], Online: true },
      },
    });
    makeExecFile([{ cmd: "tailscale", out: status }]);
    const ip = await resolveTailscaleHost("prod-k8s");
    expect(ip).toBe("100.86.229.8");
  });

  it("falls back to the highest suffix when none report Online", async () => {
    const status = JSON.stringify({
      Self: { HostName: "claws-host", TailscaleIPs: ["100.1.1.1"], Online: true },
      Peer: {
        "nodekey:0": { HostName: "prod-k8s", DNSName: "prod-k8s-3.example.ts.net.", TailscaleIPs: ["100.86.229.3"], Online: false },
        "nodekey:1": { HostName: "prod-k8s", DNSName: "prod-k8s-11.example.ts.net.", TailscaleIPs: ["100.86.229.11"], Online: false },
      },
    });
    makeExecFile([{ cmd: "tailscale", out: status }]);
    const ip = await resolveTailscaleHost("prod-k8s");
    expect(ip).toBe("100.86.229.11");
  });

  it("does not match a different device that merely shares the prefix", async () => {
    // "prod-k8s-monitor" is a distinct device, not a "prod-k8s" rename (suffix is
    // not all-digits), so it must not be selected.
    makeExecFile([{
      cmd: "tailscale",
      out: makeTailscaleStatus([{ HostName: "prod-k8s-monitor", TailscaleIPs: ["100.1.2.3"], Online: true }]),
    }]);
    await expect(resolveTailscaleHost("prod-k8s")).rejects.toThrow(/no online IPv4 found for device "prod-k8s"/);
  });

  it("throws when no candidate matches", async () => {
    makeExecFile([{
      cmd: "tailscale",
      out: makeTailscaleStatus([{ HostName: "other-host", TailscaleIPs: ["100.1.2.3"], Online: true }]),
    }]);
    await expect(resolveTailscaleHost("prod-k8s")).rejects.toThrow(/no online IPv4 found for device "prod-k8s"/);
  });
});

// ── refreshKubeconfig ──

describe("refreshKubeconfig", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("rewrites server URL using tailscale-resolved IP when no serverOverride", async () => {
    makeExecFile([
      { cmd: "tailscale", out: makeTailscaleStatus([{ HostName: "prod-k8s", TailscaleIPs: ["100.86.229.9"], Online: true }]) },
      { cmd: "ssh", out: VALID_KUBECONFIG },
    ]);

    await refreshKubeconfig(
      { tailscaleHostname: "prod-k8s", remotePath: "/etc/rancher/k3s/k3s.yaml" },
      "/tmp/test-kubeconfig",
      "test",
    );

    expect(mockWriteFileSync).toHaveBeenCalledOnce();
    const written: string = mockWriteFileSync.mock.calls[0][1] as string;
    expect(written).toMatch(/^\s*server:\s*https:\/\/100\.86\.229\.9:6443\s*$/m);
    expect(mockRenameSync).toHaveBeenCalledWith("/tmp/test-kubeconfig.tmp", "/tmp/test-kubeconfig");
  });

  it("serverOverride wins over tailscale-derived URL", async () => {
    makeExecFile([
      { cmd: "tailscale", out: makeTailscaleStatus([{ HostName: "prod-k8s", TailscaleIPs: ["100.86.229.9"], Online: true }]) },
      { cmd: "ssh", out: VALID_KUBECONFIG },
    ]);

    await refreshKubeconfig(
      { tailscaleHostname: "prod-k8s", remotePath: "/etc/rancher/k3s/k3s.yaml", serverOverride: "https://my-lb.example.com:6443" },
      "/tmp/test-kubeconfig",
      "test",
    );

    const written: string = mockWriteFileSync.mock.calls[0][1] as string;
    expect(written).toMatch(/^\s*server:\s*https:\/\/my-lb\.example\.com:6443\s*$/m);
  });

  it("throws without writing when fetched content has no server: field", async () => {
    makeExecFile([
      { cmd: "tailscale", out: makeTailscaleStatus([{ HostName: "prod-k8s", TailscaleIPs: ["100.86.229.9"], Online: true }]) },
      { cmd: "ssh", out: "apiVersion: v1\nclusters: []\n" },
    ]);

    await expect(
      refreshKubeconfig(
        { tailscaleHostname: "prod-k8s", remotePath: "/etc/rancher/k3s/k3s.yaml" },
        "/tmp/test-kubeconfig",
        "test",
      ),
    ).rejects.toThrow(/no server: field/);
    expect(mockWriteFileSync).not.toHaveBeenCalled();
  });

  it("copies server URL verbatim from remote kubeconfig when only host is set (no tailscaleHostname, no serverOverride)", async () => {
    // No tailscale call — host is used directly for SSH.
    makeExecFile([{ cmd: "ssh", out: VALID_KUBECONFIG }]);

    await refreshKubeconfig(
      { host: "100.86.229.9", remotePath: "/etc/rancher/k3s/k3s.yaml" },
      "/tmp/test-kubeconfig",
      "test",
    );

    expect(mockWriteFileSync).toHaveBeenCalledOnce();
    const written: string = mockWriteFileSync.mock.calls[0][1] as string;
    // server URL is copied verbatim (127.0.0.1 from the remote kubeconfig); callers must
    // set serverOverride when the remote kubeconfig embeds 127.0.0.1.
    expect(written).toMatch(/^\s*server:\s*https:\/\/127\.0\.0\.1:6443\s*$/m);
    expect(mockRenameSync).toHaveBeenCalledWith("/tmp/test-kubeconfig.tmp", "/tmp/test-kubeconfig");
  });
});
