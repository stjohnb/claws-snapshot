import { writeFileSync, renameSync } from "node:fs";
import type { KubeconfigRefresh } from "../config.js";
import * as log from "../log.js";
import { buildSshArgs, execCapture, isSafeAbsolutePath } from "../ssh.js";

interface TsStatus { HostName?: string; DNSName?: string; TailscaleIPs?: string[]; Online?: boolean }

/** True when a kubectl error suggests a stale/unreachable kubeconfig (cluster
 * rebuilt → endpoint, CA, or client cert changed). Excludes Claws-side defects
 * (missing binary/kubeconfig file, RBAC Forbidden) a refresh cannot fix. */
export function isStaleKubeconfigError(err: Error): boolean {
  const m = err.message;
  if (/\bForbidden\b/.test(m)) return false;
  if (/command not found|not found in \$PATH/i.test(m)) return false;
  return /timed out after 30s/i.test(m)
    || /unable to connect to the server/i.test(m)
    || /connection refused/i.test(m)
    || /no route to host/i.test(m)
    || /no such host/i.test(m)
    || /i\/o timeout/i.test(m)
    || /TLS handshake timeout/i.test(m)
    || /x509|certificate signed by unknown authority|certificate has expired/i.test(m)
    || /You must be logged in to the server|Unauthorized/i.test(m);
}

/** Suffix of `name` relative to `target`, tolerating Tailscale's `-N` rename:
 * exact match → 0, "target-7" → 7, anything else → null. */
function nameSuffix(name: string, target: string): number | null {
  if (name === target) return 0;
  if (name.startsWith(`${target}-`)) {
    const rest = name.slice(target.length + 1);
    if (/^\d+$/.test(rest)) return Number(rest);
  }
  return null;
}

/** Resolve a Tailscale device name to its current IPv4 via `tailscale status --json`.
 * Matches HostName or the DNSName's leading label (case-insensitive). Tailscale
 * suffixes a `-N` to a rebuilt node's name when the prior (now offline) device of
 * the same name is still registered, so the live node may be "prod-k8s-8" rather
 * than "prod-k8s" — we match the base name or any "-N" variant and prefer the
 * Online device with the highest suffix (the most recently created). Throws if no
 * match. */
export async function resolveTailscaleHost(hostname: string): Promise<string> {
  const raw = await execCapture("tailscale", ["status", "--json"], { timeout: 15_000 });
  const status = JSON.parse(raw) as { Self?: TsStatus; Peer?: Record<string, TsStatus> };
  const all: TsStatus[] = [status.Self, ...Object.values(status.Peer ?? {})].filter(Boolean) as TsStatus[];
  const target = hostname.toLowerCase();
  const matches = all
    .map((p) => {
      const hn = nameSuffix((p.HostName ?? "").toLowerCase(), target);
      const dns = nameSuffix((p.DNSName ?? "").toLowerCase().split(".")[0], target);
      const suffixes = [hn, dns].filter((s): s is number => s !== null);
      // The OS HostName often stays "prod-k8s" across rebuilds while only the
      // tailnet DNSName gets bumped, so take the max to track the live device.
      return suffixes.length ? { peer: p, suffix: Math.max(...suffixes) } : null;
    })
    .filter((m): m is { peer: TsStatus; suffix: number } => m !== null)
    .sort((a, b) => b.suffix - a.suffix);
  const chosen = (matches.find((m) => m.peer.Online) ?? matches[0])?.peer;
  const ipv4 = chosen?.TailscaleIPs?.find((ip) => /^\d{1,3}(\.\d{1,3}){3}$/.test(ip));
  if (!ipv4) throw new Error(`tailscale: no online IPv4 found for device "${hostname}"`);
  return ipv4;
}

function sshCapture(cfg: KubeconfigRefresh, host: string, command: string, timeoutMs = 20_000): Promise<string> {
  const args = buildSshArgs(cfg);
  args.push(cfg.user ? `${cfg.user}@${host}` : host, command);
  return execCapture("ssh", args, { timeout: timeoutMs });
}

/** Discover the host (tailscale or literal), SSH in, read the remote kubeconfig,
 * rewrite its server URL, and atomically write it to localPath. Throws on any
 * failure; callers should treat this as best-effort (catch and fall through). */
export async function refreshKubeconfig(cfg: KubeconfigRefresh, localPath: string, logPrefix: string): Promise<void> {
  if (!isSafeAbsolutePath(cfg.remotePath)) throw new Error(`unsafe remotePath: ${cfg.remotePath}`);

  let host = cfg.host ?? "";
  let resolvedIp: string | null = null;
  if (cfg.tailscaleHostname) {
    resolvedIp = await resolveTailscaleHost(cfg.tailscaleHostname);
    host = resolvedIp;
    log.info(`[${logPrefix}] Resolved tailscale device "${cfg.tailscaleHostname}" → ${resolvedIp}`);
  }
  if (!host) throw new Error("kubeconfigRefresh: neither tailscaleHostname nor host resolved a target");

  log.info(`[${logPrefix}] Refreshing kubeconfig from ${cfg.user ? cfg.user + "@" : ""}${host}:${cfg.remotePath}`);
  let contents = await sshCapture(cfg, host, `cat ${cfg.remotePath}`);
  if (!/^\s*server:\s*\S+/m.test(contents)) {
    throw new Error("fetched kubeconfig has no server: field — refusing to overwrite");
  }

  // When tailscaleHostname is absent, resolvedIp is null and serverUrl stays null, so
  // the remote kubeconfig's server: field is copied verbatim. k3s kubeconfigs typically
  // embed https://127.0.0.1:6443, so callers must set serverOverride when using host: directly.
  const serverUrl = cfg.serverOverride
    ?? (resolvedIp ? `https://${resolvedIp}:${cfg.serverPort ?? 6443}` : null);
  if (serverUrl) contents = contents.replace(/^(\s*server:\s*).*$/m, `$1${serverUrl}`);

  const tmp = `${localPath}.tmp`;
  writeFileSync(tmp, contents, { mode: 0o600 });
  renameSync(tmp, localPath);
  log.info(`[${logPrefix}] Kubeconfig refreshed → ${localPath}${serverUrl ? ` (server ${serverUrl})` : ""}`);
}
