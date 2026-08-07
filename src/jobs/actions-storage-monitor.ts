import * as log from "../log.js";
import * as gh from "../github.js";
import { ensureAlertIssue } from "../occurrence-tracking.js";
import { reportError } from "../error-reporter.js";
import { SELF_REPO, LABELS, isJobDisabledForRepo } from "../config.js";
import { renderViolationTable } from "./scanner-runner.js";
import type { RepoStorageUsage } from "../github.js";
import { mapSettledWithConcurrency } from "../util.js";

const NAME = "actions-storage-monitor";
const QUOTA_BYTES = 2 * 1024 * 1024 * 1024;            // account quota: 2 GB
const ORG_ALERT_THRESHOLD_BYTES = Math.floor(QUOTA_BYTES * 0.8); // roll-up alert at 80%
const CACHE_ALERT_THRESHOLD_BYTES = 50 * 1024 * 1024;  // 50 MB of Actions cache → caching is happening
const ARTIFACT_RETENTION_ALERT_DAYS = 7;               // oldest live artifact older than this → retention too high
const DAY_MS = 24 * 60 * 60 * 1000;
const CONCURRENCY = 5;
const TOP_N = 15;
const PER_REPO_ISSUE_TITLE = "Alert: this repo is consuming GitHub Actions storage";
const ORG_ISSUE_TITLE = "Alert: GitHub Actions storage usage is high";

export { PER_REPO_ISSUE_TITLE, ORG_ISSUE_TITLE };

/** Human-readable byte size, e.g. `1.23 GB`. */
export function formatBytes(n: number): string {
  const GB = 1024 * 1024 * 1024;
  const MB = 1024 * 1024;
  const KB = 1024;
  if (n >= GB) return `${(n / GB).toFixed(2)} GB`;
  if (n >= MB) return `${(n / MB).toFixed(2)} MB`;
  if (n >= KB) return `${(n / KB).toFixed(2)} KB`;
  return `${n} B`;
}

function total(u: RepoStorageUsage): number {
  return u.cacheBytes + u.artifactBytes;
}

/** Reasons a repo violates storage policy (no cache, short artifact retention); [] means within policy. */
export function perRepoAlertReasons(u: RepoStorageUsage, nowMs: number): string[] {
  const reasons: string[] = [];
  if (u.cacheBytes >= CACHE_ALERT_THRESHOLD_BYTES) {
    reasons.push(
      `Using ${formatBytes(u.cacheBytes)} of Actions **cache** across ${u.cacheCount} caches. ` +
        `Self-hosted runners persist the workspace, so Actions caching is unnecessary and wastes the shared quota.`,
    );
  }
  if (u.oldestArtifactAt !== null) {
    const ageDays = (nowMs - Date.parse(u.oldestArtifactAt)) / DAY_MS;
    if (ageDays >= ARTIFACT_RETENTION_ALERT_DAYS) {
      reasons.push(
        `Oldest live artifact is ${Math.floor(ageDays)} days old ` +
          `(${formatBytes(u.artifactBytes)} across ${u.artifactCount} artifacts). ` +
          `Lower artifact retention (per-upload \`retention-days\`) so artifacts age out within a few days.`,
      );
    }
  }
  return reasons;
}

function buildPerRepoBody(u: RepoStorageUsage, reasons: string[]): string {
  return [
    `This repo is using ${formatBytes(total(u))} of GitHub Actions storage ` +
      `(${formatBytes(u.cacheBytes)} cache, ${formatBytes(u.artifactBytes)} artifacts across ` +
      `${u.artifactCount} artifacts; oldest ${u.oldestArtifactAt ?? "n/a"}).`,
    "",
    "The 2 GB Actions-storage quota is **shared across all `St-John-Software` repos**, so usage " +
      "here counts against every other repo's budget too.",
    "",
    "### Why this was flagged",
    "",
    ...reasons.map(r => `- ${r}`),
    "",
    "### Recommended actions",
    "",
    "- Lower artifact retention (Settings → Actions → Artifact and log retention, or per-upload `retention-days`).",
    `- Delete unused caches: \`gh cache delete --all --repo ${u.repo}\`.`,
    "- Remove `cache-to: type=gha` from workflows that don't need cross-run Docker caching.",
  ].join("\n");
}

function buildOrgBody(usages: RepoStorageUsage[], totalBytes: number): string {
  const top = [...usages].sort((a, b) => total(b) - total(a)).slice(0, TOP_N);
  const intro = [
    `${formatBytes(totalBytes)} of measured Actions storage (caches + artifacts) across ` +
      `${usages.length} repos, quota 2 GB.`,
    "",
    "The figure above is **measured Actions storage (caches + artifacts)** — close to, but not " +
      "identical to, GitHub's authoritative billing number (which requires `admin:org` scope to read).",
    "",
    "### Top consumers",
    "",
  ].join("\n");
  return renderViolationTable({
    intro,
    columns: ["Repo", "Cache", "Artifacts", "Artifact count", "Oldest artifact"],
    rows: top,
    cells: u => [
      u.repo,
      formatBytes(u.cacheBytes),
      formatBytes(u.artifactBytes),
      String(u.artifactCount),
      u.oldestArtifactAt ?? "n/a",
    ],
    footer: [],
  });
}

export async function run(): Promise<void> {
  try {
    const repos = (await gh.listRepos()).filter(r => !isJobDisabledForRepo(NAME, r.fullName));

    // Fetch storage usage in concurrency-capped batches; skip (don't abort) on failure.
    const usages: RepoStorageUsage[] = [];
    const settled = await mapSettledWithConcurrency(
      repos,
      CONCURRENCY,
      (r) => gh.fetchRepoStorageUsage(r.fullName),
    );
    for (let j = 0; j < settled.length; j++) {
      const res = settled[j];
      if (res.status === "fulfilled") {
        usages.push(res.value);
      } else {
        log.warn(`[${NAME}] Failed to fetch storage usage for ${repos[j]!.fullName}: ${res.reason}`);
      }
    }

    const totalBytes = usages.reduce((sum, u) => sum + total(u), 0);

    // Per-repo issues: flag repos using Actions cache or with high artifact retention.
    const nowMs = Date.now();
    for (const u of usages) {
      const reasons = perRepoAlertReasons(u, nowMs);
      if (reasons.length === 0) continue;
      try {
        await ensureAlertIssue({
          repo: u.repo,
          title: PER_REPO_ISSUE_TITLE,
          body: buildPerRepoBody(u, reasons),
          labels: [LABELS.priority],
          logPrefix: NAME,
        });
      } catch (err) {
        log.warn(`[${NAME}] Failed to file storage issue for ${u.repo}: ${err}`);
      }
    }

    // Org roll-up: only when total usage crosses 80% of the cap.
    if (totalBytes < ORG_ALERT_THRESHOLD_BYTES) {
      log.info(
        `[${NAME}] Total measured Actions storage ${formatBytes(totalBytes)} across ${usages.length} ` +
          `repos is under the ${formatBytes(ORG_ALERT_THRESHOLD_BYTES)} alert threshold — no roll-up issue`,
      );
      return;
    }

    await ensureAlertIssue({
      repo: SELF_REPO,
      title: ORG_ISSUE_TITLE,
      body: buildOrgBody(usages, totalBytes),
      labels: [LABELS.priority],
      logPrefix: NAME,
    });
    log.info(
      `[${NAME}] Total measured Actions storage ${formatBytes(totalBytes)} across ${usages.length} ` +
        `repos exceeds threshold — filed roll-up issue in ${SELF_REPO}`,
    );
  } catch (err) {
    reportError(NAME, SELF_REPO, err);
  }
}
