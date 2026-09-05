import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile as _execFile } from "node:child_process";
import { promisify } from "node:util";
import { WORK_DIR, SELF_REPO } from "../config.js";
import * as log from "../log.js";
import { notify } from "../slack.js";
import { ensureAlertIssue, closeAlertIssueIfResolved } from "../occurrence-tracking.js";
import { enrichedPath } from "../claude.js";
import * as worktreeCleaner from "./worktree-cleaner.js";
import { isContainer } from "../runtime-env.js";

const execFile = promisify(_execFile);

/**
 * Thresholds are tighter than runner-monitor's 85/90. The claws host's steady
 * state sits near 70%, so an 85% tier-1 trigger leaves almost no headroom
 * before a single dependency install blows past it (#2386).
 */
export const WARN_PERCENT = 80;
export const CRITICAL_PERCENT = 88;

/** Under disk pressure, reap worktrees far more eagerly than the daily sweep does. */
const AGGRESSIVE_WORKTREE_STALE_MS = 24 * 60 * 60 * 1000;

/** Large (~3 G combined) and regenerable, but slow to re-download — tier 2 only. */
const BROWSER_CACHES = ["puppeteer", "Cypress", "ms-playwright", "ms-playwright-mcp" /* 1.3 G on openclaw, 2026-09-02 */];

/**
 * Regenerable tool caches, ~900 M combined on openclaw. Deliberately excludes
 * `claude-cli-nodejs`, `opencode` and `nix` (live processes own them) and
 * `huggingface` (small today, but model re-downloads are asymmetrically slow).
 */
const TOOL_CACHES = ["uv", "gh", "pnpm", "next-swc", "node-gyp", "pip", "yarn" /* 483 M on openclaw, 2026-09-02 */];

/**
 * `nix-collect-garbage` lives in the single-user Nix profile, which is on
 * neither the systemd unit's PATH nor enrichedPath's EXTRA_BIN_DIRS — so it
 * must be located by absolute path or the biggest cleanup win silently no-ops.
 */
const NIX_GC_CANDIDATES = [
  path.join(os.homedir(), ".nix-profile/bin/nix-collect-garbage"),
  "/nix/var/nix/profiles/default/bin/nix-collect-garbage",
];

/**
 * Age below which a /tmp file is assumed to belong to live work. The sweep is
 * file-level, not directory-level: a session directory can be days old while a
 * subagent is still writing into it, so ageing the *files* is what keeps a
 * long-running agent's scratch alive. Everything swept is regenerable.
 */
const TMP_STALE_MINUTES = 1440;

/**
 * Generic /tmp entries — agent shell scratch (`/tmp/all_files.txt`,
 * `/tmp/db620ci/`, …) rather than the four machine-generated roots — are aged
 * 3 days, not 24 h. Measured on openclaw 2026-09-02: 72 h reclaims 3.55 GiB /
 * 126,657 files against 3.59 GiB at 24 h — within 1% of the win, with much
 * less chance of deleting a file a session that started yesterday still needs.
 */
const TMP_GENERIC_STALE_MINUTES = 4320;

/**
 * Tier 2 is expensive (a full nix GC can take minutes, and re-downloading the
 * browser caches is slow), so warn-band escalation into it is rate-limited.
 * The critical path (> CRITICAL_PERCENT) ignores this — that is an emergency.
 */
const TIER2_COOLDOWN_MS = 6 * 60 * 60 * 1000;
let lastTier2At = 0;

/** Test seam — module-level cooldown state would otherwise leak between cases. */
export function __resetTier2CooldownForTests(): void {
  lastTier2At = 0;
}

// Computed per call rather than at module load so os.hostname() stays mockable.
function diskTitle(): string {
  return `[host-disk-monitor] Persistent high disk on ${os.hostname()}`;
}

function runtimeTitle(): string {
  return `[host-disk-monitor] Container runtime present on plan-only host ${os.hostname()}`;
}

/**
 * Usage of the filesystem holding WORK_DIR, rounded the way `df` rounds.
 * Capacity excludes root-reserved blocks (bfree - bavail), so this matches the
 * percentage a human sees in `df -h`.
 */
export function usagePercent(): number | null {
  try {
    const st = fs.statfsSync(WORK_DIR);
    const used = Number(st.blocks) - Number(st.bfree);
    const capacity = used + Number(st.bavail);
    if (!(capacity > 0)) return null;
    return Math.ceil((used / capacity) * 100);
  } catch {
    return null;
  }
}

async function runCmd(cmd: string, args: string[], timeoutMs: number): Promise<string> {
  // 64 MiB: the last real nix-collect-garbage -d deleted 19,384 store paths,
  // one line each — the 1 MiB default would surface a success as a failure.
  const { stdout } = await execFile(cmd, args, {
    timeout: timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, PATH: enrichedPath(process.env["PATH"]) },
  });
  return stdout;
}

/**
 * Reclaim regenerable scratch under /tmp — the Claude CLI's per-session task
 * output, leaked `nix develop` TMPDIRs, the node/jest compile caches, and
 * (uid-scoped, 72 h stale) everything else under /tmp. Measured at
 * 7.4 G / 334 k files for the four named roots (#2535) and 3.55 GiB / 126,657
 * files for the generic sweep (#2791) on openclaw. Returns true unless
 * `readdirSync(os.tmpdir())` itself fails.
 *
 * Uses `find` rather than fs recursion: the same idiom runner-monitor.ts
 * already uses for /tmp, and 334 k unlinks in-process would stall the event
 * loop. No `sudo` — every root is owned by the account Claws runs as.
 */
export async function sweepTmp(): Promise<boolean> {
  const tmp = os.tmpdir();

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(tmp, { withFileTypes: true });
  } catch {
    return false;
  }

  const roots = entries
    .filter(e => e.isDirectory() && (/^claude-\d+$/.test(e.name) || /^nix-shell\./.test(e.name) || e.name === "node-compile-cache" || e.name === "jest_rs"))
    .map(e => path.join(tmp, e.name));

  if (roots.length > 0) {
    try {
      await runCmd("find", [...roots, "-xdev", "-type", "f", "-mmin", `+${TMP_STALE_MINUTES}`, "-delete"], 300_000);
    } catch (err) {
      log.debug(`[host-disk-monitor] /tmp file-age pass failed: ${err}`);
    }

    try {
      await runCmd("find", [...roots, "-xdev", "-mindepth", "1", "-type", "d", "-empty", "-delete"], 300_000);
    } catch (err) {
      log.debug(`[host-disk-monitor] /tmp empty-dir pass failed: ${err}`);
    }
  }

  const uid = String(process.getuid?.() ?? 0);
  // Subtrees the generic passes must not touch. `${tmp}/claude-*` covers both the
  // claude-<uid> roots (passes 1–2 own them) and claude-shell-snapshot-*, which is
  // sourced by every Bash call of a live session and must never be swept.
  const excludes = [
    `${tmp}/claude-*`,
    `${tmp}/nix-shell.*`,
    `${tmp}/node-compile-cache*`,
    `${tmp}/jest_rs*`,
    `${tmp}/.*`,
    `${tmp}/systemd-private-*`,
    `${tmp}/snap*`,
  ].flatMap(p => ["!", "-path", p]);

  try {
    await runCmd("find", [tmp, "-xdev", "-mindepth", "1", "-uid", uid, ...excludes,
      "-type", "f", "-mmin", `+${TMP_GENERIC_STALE_MINUTES}`, "-delete"], 300_000);
  } catch (err) {
    log.debug(`[host-disk-monitor] /tmp generic file-age pass failed: ${err}`);
  }

  try {
    await runCmd("find", [tmp, "-xdev", "-mindepth", "1", "-uid", uid, ...excludes,
      "-type", "d", "-empty", "-mmin", `+${TMP_GENERIC_STALE_MINUTES}`, "-delete"], 300_000);
  } catch (err) {
    log.debug(`[host-disk-monitor] /tmp generic empty-dir pass failed: ${err}`);
  }

  return true;
}

/**
 * Cheap, regenerable caches. Every step is independently try/caught — a host
 * without apt or without passwordless sudo just skips those steps.
 *
 * Note there is no `docker`/`podman` command anywhere in this file: Docker is
 * deliberately absent from this host, and a cleanup path that shells out to it
 * would normalise its presence.
 */
async function tier1(freed: string[]): Promise<void> {
  try {
    await runCmd("npm", ["cache", "clean", "--force"], 300_000);
    freed.push("npm cache");
  } catch (err) {
    log.debug(`[host-disk-monitor] npm cache clean failed: ${err}`);
  }

  try {
    fs.rmSync(path.join(os.homedir(), ".npm/_npx"), { recursive: true, force: true });
    freed.push("npx cache");
  } catch (err) {
    log.debug(`[host-disk-monitor] npx cache removal failed: ${err}`);
  }

  try {
    if (await sweepTmp()) freed.push("/tmp scratch");
  } catch (err) {
    log.debug(`[host-disk-monitor] /tmp sweep failed: ${err}`);
  }

  try {
    const r = await worktreeCleaner.run({ staleMs: AGGRESSIVE_WORKTREE_STALE_MS });
    if (r.removed > 0) {
      freed.push(`stale worktrees (${(r.freedBytes / 1024 ** 3).toFixed(1)} GiB)`);
    }
  } catch (err) {
    log.debug(`[host-disk-monitor] worktree cleanup failed: ${err}`);
  }

  // `-n` is mandatory: without it sudo can block forever on a password prompt
  // with no TTY attached.
  if (!isContainer()) {
    try {
      await runCmd("sudo", ["-n", "journalctl", "--vacuum-size=200M"], 120_000);
      freed.push("journal vacuum");
    } catch (err) {
      log.debug(`[host-disk-monitor] journal vacuum failed: ${err}`);
    }

    try {
      await runCmd("sudo", ["-n", "apt-get", "clean"], 120_000);
      freed.push("apt cache");
    } catch (err) {
      log.debug(`[host-disk-monitor] apt-get clean failed: ${err}`);
    }
  }
}

async function tier2(freed: string[]): Promise<void> {
  // No sudo: the Nix store here is single-user and owned by the same account
  // claws runs as. Safe against in-flight work — live `nix develop` shells hold
  // auto GC roots under /nix/var/nix/gcroots/auto.
  if (!isContainer()) {
    try {
      const bin = NIX_GC_CANDIDATES.find(p => fs.existsSync(p)) ?? "nix-collect-garbage";
      await runCmd(bin, ["-d"], 900_000);
      freed.push("nix gc");
    } catch (err) {
      log.debug(`[host-disk-monitor] nix-collect-garbage failed: ${err}`);
    }
  }

  let removedCaches = false;
  for (const cache of [...BROWSER_CACHES, ...TOOL_CACHES]) {
    try {
      fs.rmSync(path.join(os.homedir(), ".cache", cache), { recursive: true, force: true });
      removedCaches = true;
    } catch (err) {
      log.debug(`[host-disk-monitor] ${cache} cache removal failed: ${err}`);
    }
  }
  if (removedCaches) freed.push("browser + tool caches");
}

/** Best-effort disk breakdown for the alert body — every probe is optional. */
async function breakdown(): Promise<string> {
  const lines: string[] = [];

  try {
    const out = await runCmd("df", ["-h", WORK_DIR], 60_000);
    if (out.trim()) lines.push("Filesystem:", out.trim());
  } catch { /* skip */ }

  const home = os.homedir();
  const userDirs = [
    path.join(home, ".claws/worktrees"),
    path.join(home, ".claws/repos"),
    path.join(home, ".cache"),
    path.join(home, ".npm"),
    path.join(home, ".nvm"),
    path.join(home, ".local"),
    path.join(home, ".claude"),
    path.join(home, ".platformio"),
    path.join(home, ".rustup"),
  ];
  const rootDirs = [
    "/nix",
    "/var/log",
    "/var/lib/docker",
    "/var/lib/containerd",
    "/tmp",
    "/var/cache",
    "/usr",
    "/snap",
  ];

  const dirLines: string[] = [];
  for (const dir of userDirs) {
    try {
      const out = await runCmd("du", ["-sh", dir], 60_000);
      if (out.trim()) dirLines.push(out.trim());
    } catch { /* skip */ }
  }
  if (!isContainer()) {
    for (const dir of rootDirs) {
      try {
        const out = await runCmd("sudo", ["-n", "du", "-sh", dir], 60_000);
        if (out.trim()) dirLines.push(out.trim());
      } catch { /* skip */ }
    }
  }
  if (dirLines.length > 0) lines.push("Top directories:", ...dirLines);

  try {
    const out = await runCmd("bash", ["-c", "du -sh /tmp/* 2>/dev/null | sort -hr | head -10"], 120_000);
    if (out.trim()) lines.push("Top /tmp entries:", out.trim());
  } catch { /* skip */ }

  try {
    const out = await runCmd("bash", ["-c", "du -sh ~/.cache/* 2>/dev/null | sort -hr | head -10"], 120_000);
    if (out.trim()) lines.push("Top ~/.cache entries:", out.trim());
  } catch { /* skip */ }

  if (lines.length === 0) return "(breakdown unavailable)";
  return lines.join("\n").trim();
}

/**
 * Filesystem evidence that a container runtime has been installed on this
 * plan-only host. Deliberately does not probe network interfaces: `docker0`
 * and `br-*` bridges survive a full purge until reboot, so they false-positive
 * forever. Deliberately does not execute `docker`/`podman` either.
 */
export function containerRuntimeEvidence(): string[] {
  const evidence: string[] = [];

  const dirs = enrichedPath(process.env["PATH"]).split(path.delimiter).filter(Boolean);
  for (const bin of ["docker", "podman"]) {
    for (const dir of dirs) {
      const candidate = path.join(dir, bin);
      try {
        if (fs.existsSync(candidate)) evidence.push(candidate);
      } catch { /* ignore unreadable dirs */ }
    }
  }

  for (const dir of ["/var/lib/docker", "/var/lib/containerd"]) {
    try {
      if (fs.existsSync(dir)) evidence.push(dir);
    } catch { /* ignore */ }
  }

  return evidence;
}

async function checkDisk(): Promise<void> {
  const usage = usagePercent();
  if (usage === null) {
    log.warn(`[host-disk-monitor] Could not read disk usage for ${WORK_DIR}`);
    return;
  }

  if (usage <= WARN_PERCENT) {
    await closeAlertIssueIfResolved({
      repo: SELF_REPO,
      title: diskTitle(),
      logPrefix: "host-disk-monitor",
      reason: `disk back to ${usage}%`,
    });
    return;
  }

  log.warn(`[host-disk-monitor] Disk usage ${usage}% on ${os.hostname()} — running cleanup`);
  const freed: string[] = [];
  await tier1(freed);

  const afterTier1 = usagePercent() ?? usage;
  const tier2OffCooldown = Date.now() - lastTier2At >= TIER2_COOLDOWN_MS;
  // Tier 1's targets are worth ~230 MB on this host (0.4% of 60 G); the only
  // levers that can clear the warn band are tier 2's. Escalating here is what
  // stops an 82% plateau paging a human every 10 min with no automated remedy.
  const ranTier2 = usage > CRITICAL_PERCENT || (afterTier1 > WARN_PERCENT && tier2OffCooldown);
  if (ranTier2) {
    if (usage <= CRITICAL_PERCENT) {
      log.info(`[host-disk-monitor] Tier 1 left usage at ${afterTier1}% — escalating to tier 2 below the critical threshold`);
    }
    await tier2(freed);
    lastTier2At = Date.now();
  }

  const post = usagePercent();
  const cleanedStr = freed.join(" + ") || "none";

  if (post !== null && post <= WARN_PERCENT) {
    log.info(`[host-disk-monitor] Disk recovered ${usage}% → ${post}% (${cleanedStr})`);
    await closeAlertIssueIfResolved({
      repo: SELF_REPO,
      title: diskTitle(),
      logPrefix: "host-disk-monitor",
      reason: `disk back to ${post}%`,
    });
    return;
  }

  if (post !== null && post <= CRITICAL_PERCENT && post < usage) {
    // Cleanup worked, just not all the way back under the warn line — no issue.
    log.info(`[host-disk-monitor] Disk reduced ${usage}% → ${post}% (${cleanedStr}), still above ${WARN_PERCENT}%`);
    return;
  }

  if (!ranTier2 && post !== null && post <= CRITICAL_PERCENT) {
    // Warn band, tier 2 suppressed by its cooldown: no automated lever has been
    // exhausted yet, so there is nothing for a human to act on. Log and wait.
    log.info(`[host-disk-monitor] Disk at ${post}% (was ${usage}%), tier 2 on cooldown — not escalating`);
    return;
  }

  const postStr = post === null ? "unknown" : `${post}%`;
  log.warn(`[host-disk-monitor] Cleanup did not resolve disk pressure (${usage}% → ${postStr})`);

  const body = [
    `Disk usage on **${os.hostname()}** (the host Claws itself runs on) is **${postStr}** after automated cleanup (was ${usage}%).`,
    "",
    `**Cleanup performed:** ${cleanedStr}`,
    "",
    "**Disk breakdown:**",
    "```",
    await breakdown(),
    "```",
    "",
    "*— Automated by Claws · host-disk-monitor —*",
  ].join("\n");

  const result = await ensureAlertIssue({
    repo: SELF_REPO,
    title: diskTitle(),
    body,
    refreshBody: true,
    logPrefix: "host-disk-monitor",
  });

  if (result.outcome === "created") {
    notify(`host-disk-monitor: disk on ${os.hostname()} at ${postStr} after cleanup — filed issue #${result.issueNumber}`);
  } else {
    log.info(`[host-disk-monitor] Updated existing disk issue #${result.issueNumber}`);
  }
}

async function checkContainerRuntime(): Promise<void> {
  const evidence = containerRuntimeEvidence();

  if (evidence.length === 0) {
    await closeAlertIssueIfResolved({
      repo: SELF_REPO,
      title: runtimeTitle(),
      logPrefix: "host-disk-monitor",
      reason: "no container runtime present",
    });
    return;
  }

  log.warn(`[host-disk-monitor] Container runtime evidence on plan-only host: ${evidence.join(", ")}`);

  const sections = [
    `**${os.hostname()}** is a plan-only host — it is the machine Claws runs on, which plans work and delegates it; it is not meant to run container workloads. Evidence of a container runtime was found:`,
    "",
    "```",
    evidence.join("\n"),
    "```",
  ];

  try {
    const du = await runCmd("sudo", ["-n", "du", "-sh", "/var/lib/docker", "/var/lib/containerd"], 60_000);
    if (du.trim()) sections.push("", "**Disk used:**", "```", du.trim(), "```");
  } catch { /* probe is optional */ }

  sections.push(
    "",
    "**Remediation:**",
    "```",
    "sudo systemctl disable --now docker.service docker.socket containerd",
    "sudo apt-get purge -y docker.io docker-ce docker-ce-cli containerd containerd.io runc",
    "sudo apt-get autoremove -y --purge",
    "sudo rm -rf /var/lib/docker /var/lib/containerd",
    "```",
    "",
    "Note `docker.io` 29.x stores images under `/var/lib/containerd`, not only `/var/lib/docker` — removing the latter alone leaves gigabytes behind.",
    "",
    "This alert is a tripwire, not a control. Durable prevention is APT pinning of the container-runtime packages, which is host configuration and lives in `nixos-config`; it is tracked separately.",
    "",
    "*— Automated by Claws · host-disk-monitor —*",
  );

  const result = await ensureAlertIssue({
    repo: SELF_REPO,
    title: runtimeTitle(),
    body: sections.join("\n"),
    refreshBody: true,
    logPrefix: "host-disk-monitor",
  });

  if (result.outcome === "created") {
    notify(`host-disk-monitor: container runtime found on plan-only host ${os.hostname()} — filed issue #${result.issueNumber}`);
  } else {
    log.info(`[host-disk-monitor] Updated existing container-runtime issue #${result.issueNumber}`);
  }
}

export async function run(): Promise<void> {
  // The two checks are independent: a failure in either must not stop the other.
  try {
    await checkDisk();
  } catch (err) {
    log.warn(`[host-disk-monitor] Disk check failed: ${err}`);
  }

  if (isContainer()) {
    log.debug("[host-disk-monitor] containerised — skipping container-runtime tripwire");
  } else {
    try {
      await checkContainerRuntime();
    } catch (err) {
      log.warn(`[host-disk-monitor] Container-runtime check failed: ${err}`);
    }
  }
}
