import type { Theme } from "./layout.js";
import { PAGE_CSS, TAILWIND_STYLESHEET, HEAD_META, escapeHtml, repoShortName, itemLogsUrl, formatRelativeTime, formatCountdown, htmlOpenTag, buildPageHeader, THEME_SCRIPT, ALPINE_SCRIPT, CATEGORY_DISPLAY } from "./layout.js";
import { QUEUE_SCRIPT } from "../resources/queue.generated.js";
import type { QueueItem, QueueCategory } from "../github.js";
import { MAX_WORK_WORKERS, LABELS } from "../config.js";
import type { Task } from "../db.js";

export interface QueueEntryMeta {
  repo: string;
  itemNumber: number;
  jobName: string;
}

export interface PipelineInfo {
  runningTasks: Task[];
  claudeEntries: Array<{ position: number; priority: boolean; meta?: QueueEntryMeta }>;
  jobNextRun: Record<string, number | null>;
  avgDurations: Record<string, number>;
}

/** Maps queue categories to the dispatcher job that picks them up. */
const CATEGORY_JOB_MAP: Record<QueueCategory, string[]> = {
  "needs-refinement": ["issue-dispatcher"],
  "refined": ["issue-dispatcher"],
  "needs-review-addressing": ["pr-dispatcher"],
  "auto-mergeable": ["pr-dispatcher"],
  "needs-triage": ["triage-claws-errors"],
  "needs-qa": ["qa-phase"],
  "ready": [],
  "problematic": [],
};

/** Format a duration for HTML output. Returns HTML entities (e.g. `&lt;1m`) — not safe for plain text contexts. */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms)) return "—";
  const mins = Math.round(ms / 60_000);
  if (mins < 1) return "&lt;1m";
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  return `${h}h ${mins % 60}m`;
}

export function getItemStatus(item: QueueItem, pipeline?: PipelineInfo): string {
  if (!pipeline) return "";

  // Check if this item is currently running in the DB
  const runningTask = pipeline.runningTasks.find(
    (t) => t.repo === item.repo && t.item_number === item.number,
  );

  if (runningTask) {
    // Check if it's in the Claude queue (waiting, not yet processing)
    const claudeEntry = pipeline.claudeEntries.find(
      (e) => e.meta?.repo === item.repo && e.meta?.itemNumber === item.number,
    );

    if (claudeEntry) {
      // Queued in Claude pipeline — compute ETA via greedy scheduling simulation.
      // This correctly models parallel workers without assuming tasks can be split.
      const itemsAhead = pipeline.claudeEntries
        .filter((e) => e.position < claudeEntry.position);
      const allItems = [...itemsAhead, claudeEntry];
      const workers = MAX_WORK_WORKERS > 0 ? MAX_WORK_WORKERS : 1;
      const workerFinish = new Array(workers).fill(0);

      // Initialize worker slots with remaining time of active (non-queued) workers.
      const now = Date.now();
      const activeWorkers = pipeline.runningTasks.filter((t) =>
        !pipeline.claudeEntries.some(
          (e) => e.meta?.repo === t.repo && e.meta?.itemNumber === t.item_number,
        ),
      );
      for (let i = 0; i < Math.min(activeWorkers.length, workers); i++) {
        const t = activeWorkers[i];
        const elapsed = now - new Date(t.started_at + "Z").getTime();
        const jobPrefix = t.job_name.includes(':') ? t.job_name.split(':')[0] : t.job_name;
        const avgForJob = pipeline.avgDurations[jobPrefix] ?? 0;
        workerFinish[i] = Math.max(0, avgForJob - elapsed);
      }

      // Assign each item to the worker that frees soonest; last iteration
      // captures the current item's completion time.
      let etaMs = 0;
      for (const e of allItems) {
        const idx = workerFinish.indexOf(Math.min(...workerFinish));
        workerFinish[idx] += pipeline.avgDurations[e.meta?.jobName ?? ""] ?? 0;
        etaMs = workerFinish[idx];
      }
      const etaPart = etaMs > 0
        ? ` &middot; ETA ~${formatDuration(etaMs)}`
        : "";
      return `<span class="queue-status status-queued">Queued (${ordinal(claudeEntry.position)})${etaPart}</span>`;
    }

    // Actively processing by Claude
    const elapsedMs = Date.now() - new Date(runningTask.started_at + "Z").getTime();
    return `<span class="queue-status status-processing">Processing (${formatDuration(elapsedMs)})</span>`;
  }

  // Not running — show next scan countdown for the dispatcher job
  const jobs = CATEGORY_JOB_MAP[item.category];
  if (!jobs || jobs.length === 0) return "";

  const nextMs = Math.min(
    ...jobs.map((j) => pipeline.jobNextRun[j] ?? Infinity),
  );
  if (!Number.isFinite(nextMs)) return "";

  return `<span class="queue-status status-waiting">Next scan ${formatCountdown(nextMs)}</span>`;
}

export function ordinal(n: number): string {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

function buildQueueSection(
  title: string,
  snapshot: { items: QueueItem[]; oldestFetchAt: number | null },
  showActions: boolean,
  pipeline?: PipelineInfo,
): string {
  if (snapshot.oldestFetchAt === null) {
    return `<div class="queue-section"><h2>${escapeHtml(title)}</h2><p class="queue-empty">Waiting for first scan...</p></div>`;
  }

  if (snapshot.items.length === 0) {
    return `<div class="queue-section"><h2>${escapeHtml(title)}</h2><p class="queue-empty">Nothing waiting</p></div>`;
  }

  const isPR = (i: QueueItem): boolean => i.prNumber != null || i.type === "pr";
  const sortedItems = [...snapshot.items].sort((a, b) => {
    const aPR = isPR(a), bPR = isPR(b);
    if (aPR !== bPR) return aPR ? -1 : 1;
    return (b.updatedAt || "").localeCompare(a.updatedAt || "");
  });

  let html = `<div class="queue-section"><h2>${escapeHtml(title)}</h2>`;
  for (const item of sortedItems) {
    const displayNumber = item.prNumber ?? item.number;
    const itemUrl = itemLogsUrl(item.repo, displayNumber);
    const escapedRepo = escapeHtml(item.repo);

    html += `<div class="queue-item" id="item-${escapedRepo}-${item.number}">`;

    // Priority indicator
    if (item.prioritized) html += `<span class="priority-star" title="Prioritised">&#x2605;</span>`;

    // Type badge
    const typeLabel = (item.prNumber != null || item.type === "pr") ? "PR" : "Issue";
    html += `<span class="type-badge" title="${typeLabel}">${typeLabel}</span>`;

    // Category badge
    const catDisplay = CATEGORY_DISPLAY[item.category] ?? { label: item.category, color: "30363d" };
    const catBg = `#${catDisplay.color}`;
    const catFg = parseInt(catDisplay.color, 16) > 0x7fffff ? "#000" : "#fff";
    html += `<span class="queue-label" style="background:${catBg};color:${catFg}">${escapeHtml(catDisplay.label)}</span>`;

    // CI check status indicator
    const checkCount = (item.checksPassed != null && item.checksTotal != null)
      ? ` <span class="check-count">${item.checksPassed}/${item.checksTotal}</span>`
      : "";
    if (item.checkStatus === "passing")      html += `<span class="check check-pass" title="CI passing">&#x2714;${checkCount}</span>`;
    else if (item.checkStatus === "failing") html += `<span class="check check-fail" title="CI failing">&#x2718;${checkCount}</span>`;
    else if (item.checkStatus === "pending") html += `<span class="check check-pending" title="CI pending">&#x25CB;${checkCount}</span>`;
    else html += `<span class="check check-none" title="No CI status"></span>`;

    const [repoOwner = "", repoName = ""] = item.repo.split("/");
    html += `<a class="repo" href="/repos/${encodeURIComponent(repoOwner)}/${encodeURIComponent(repoName)}" title="${escapedRepo}">${escapeHtml(repoShortName(item.repo))}</a>`;
    html += `<a class="number" href="${itemUrl}">#${displayNumber}</a>`;
    html += `<span class="title">${escapeHtml(item.title)}</span>`;
    html += `<span class="time">${formatRelativeTime(item.updatedAt)}</span>`;

    // Claws review status
    if (item.reviewStatus === "clean") {
      html += `<span class="review-status review-clean" title="Claws review">Reviewed — clean</span>`;
    } else if (item.reviewStatus === "issues") {
      const n = item.reviewIssueCount ?? 0;
      const label = n > 0 ? `${n} issue${n === 1 ? "" : "s"} found` : `issues found`;
      html += `<span class="review-status review-issues" title="Claws review">${label}</span>`;
    } else if (item.reviewStatus === "escalated") {
      html += `<span class="review-status review-escalated" title="Claws review">Escalated — needs human</span>`;
    }

    // Labels
    if (item.labels && item.labels.length > 0) {
      for (const label of item.labels) {
        html += `<span class="pr-label">${escapeHtml(label)}</span>`;
      }
    }

    // Merge conflict indicator
    if (item.mergeableState === "CONFLICTING") {
      html += `<span class="merge-conflict" title="Has merge conflicts">&#x26A0; Conflicts</span>`;
    }

    // Pipeline status
    const status = getItemStatus(item, pipeline);
    if (status) html += status;

    // Squash & merge button — show unless there are known conflicts
    if (item.prNumber != null && item.mergeableState !== "CONFLICTING") {
      html += `<button class="merge-btn" @click="mergePR('${escapedRepo}',${item.prNumber}, $event)">Squash &amp; Merge</button>`;
    }

    // Skip & prioritize buttons (only for Claws Attention section)
    if (showActions) {
      if (item.prioritized) {
        html += `<button class="prio-btn deprio" data-mode="deprio" @click="togglePriority('${escapedRepo}',${item.number}, $event)">Deprioritise</button>`;
      } else {
        html += `<button class="prio-btn" data-mode="prio" @click="togglePriority('${escapedRepo}',${item.number}, $event)">Prioritise</button>`;
      }
      html += `<button class="skip-btn" @click="skipItem('${escapedRepo}',${item.number}, $event)">Skip</button>`;
    }
    if (item.type === "issue") {
      const hasRefined = item.labels?.includes(LABELS.refined) ?? false;
      const hasAutomerge = item.labels?.includes(LABELS.automerge) ?? false;
      const inRefinableCategory = item.category === "ready" || item.category === "needs-refinement";
      if (inRefinableCategory && !hasRefined) {
        html += `<button class="refined-btn" @click="markRefined('${escapedRepo}',${item.number}, $event)">Refined</button>`;
        html += `<button class="refined-btn" @click="markAutomerge('${escapedRepo}',${item.number}, $event, true)">Refine &amp; Merge</button>`;
      } else if (!hasAutomerge && inRefinableCategory) {
        html += `<button class="refined-btn" @click="markAutomerge('${escapedRepo}',${item.number}, $event, false)">Automerge</button>`;
      }
    }

    html += `</div>`;
  }
  html += `</div>`;
  return html;
}

function buildSkippedSection(
  skippedItems: Array<{ repo: string; number: number }>,
): string {
  if (skippedItems.length === 0) return "";

  let html = `<details class="queue-section skipped-section"><summary><h2 style="display:inline">Skipped Items <span class="queue-count">${skippedItems.length}</span></h2></summary>`;
  for (const item of skippedItems) {
    const escapedRepo = escapeHtml(item.repo);
    html += `<div class="queue-item" id="skipped-${escapedRepo}-${item.number}">`;
    html += `<span class="repo">${escapeHtml(repoShortName(item.repo))}</span>`;
    html += `<span class="number">#${item.number}</span>`;
    html += `<button class="restore-btn" @click="unskipItem('${escapedRepo}',${item.number}, $event)">Restore</button>`;
    html += `</div>`;
  }
  html += `</details>`;
  return html;
}

function buildProblematicSection(
  problematicPRs: Array<{ repo: string; number: number; markedAt: string; reason: string; attemptCount: number }>,
): string {
  if (problematicPRs.length === 0) return "";

  let html = `<details class="queue-section"><summary><h2 style="display:inline">🚫 Problematic PRs <span class="queue-count">${problematicPRs.length}</span></h2></summary>`;
  html += `<p style="margin: 0.5em 0; font-size: 0.9em; color: var(--text-muted);">PRs that exceeded CI fix attempts and require manual intervention</p>`;
  for (const item of problematicPRs) {
    const escapedRepo = escapeHtml(item.repo);
    html += `<div class="queue-item" id="problematic-${escapedRepo}-${item.number}">`;
    html += `<span class="repo">${escapeHtml(repoShortName(item.repo))}</span>`;
    html += `<span class="number">#${item.number}</span>`;
    html += `<span class="reason" style="font-size: 0.85em; color: var(--text-muted); margin-left: 8px;">${escapeHtml(item.reason)}</span>`;
    html += `<button class="restore-btn" @click="unmarkProblematic('${escapedRepo}',${item.number}, $event)">Unmark</button>`;
    html += `</div>`;
  }
  html += `</details>`;
  return html;
}

export function buildQueuePage(
  myAttention: { items: QueueItem[]; oldestFetchAt: number | null },
  clawsAttention: { items: QueueItem[]; oldestFetchAt: number | null },
  theme: Theme,
  skippedItems: Array<{ repo: string; number: number }> = [],
  problematicPRs: Array<{ repo: string; number: number; markedAt: string; reason: string; attemptCount: number }> = [],
  pipeline?: PipelineInfo,
): string {
  const oldestFetch = [myAttention.oldestFetchAt, clawsAttention.oldestFetchAt]
    .filter((t): t is number => t !== null);
  const staleNote = oldestFetch.length > 0
    ? `<p class="queue-stale">Last scanned ${formatRelativeTime(new Date(Math.min(...oldestFetch)).toISOString())}</p>`
    : "";

  return `<!DOCTYPE html>
${htmlOpenTag(theme)}
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  ${HEAD_META}
  <meta http-equiv="refresh" content="60">
  <title>claws — Queue</title>
  ${TAILWIND_STYLESHEET}
  <style>${PAGE_CSS}
  .priority-star { color: #f0ad4e; margin-right: 4px; font-size: 1.1em; }
  .prio-btn, .skip-btn, .restore-btn { padding: 2px 8px; margin-left: 4px; border: 1px solid var(--border); border-radius: 4px; cursor: pointer; font-size: 0.85em; background: var(--bg-secondary); color: var(--text); }
  .refined-btn { padding: 2px 8px; margin-left: 4px; border: 1px solid var(--border); border-radius: 4px; cursor: pointer; font-size: 0.85em; background: var(--bg-secondary); color: var(--text); }
  .refined-btn:hover { background: #0e8a16; color: #fff; }
  .refined-btn.refined-done { background: #0e8a16; color: #fff; cursor: default; opacity: 0.85; }
  .refined-btn.refined-done:hover { background: #0e8a16; color: #fff; }
  .prio-btn:hover { background: #f0ad4e; color: #000; }
  .prio-btn.deprio:hover { background: var(--bg-secondary); }
  .skip-btn:hover { background: #d73a49; color: #fff; }
  .restore-btn:hover { background: #0e8a16; color: #fff; }
  .skipped-section, .problematic-section { margin-top: 1em; }
  .skipped-section summary, .problematic-section summary { cursor: pointer; }
  .queue-status { font-size: 0.8em; margin-left: 8px; padding: 1px 6px; border-radius: 3px; }
  .status-processing { color: var(--success, #3fb950); }
  .status-queued { color: var(--warning, #d29922); }
  .status-waiting { color: var(--text-muted, #8b949e); }
  .type-badge { font-size: 0.75rem; padding: 1px 5px; border-radius: 3px; margin-right: 4px; background: var(--bg-secondary); color: var(--text-muted); border: 1px solid var(--border); }
  .check-count { font-size: 0.75rem; color: var(--text-muted, #8b949e); }
  .queue-item .check-pass .check-count { color: var(--success); }
  .review-status { font-size: 0.75rem; padding: 1px 6px; border-radius: 3px; margin-left: 6px; }
  .review-clean { color: var(--success); }
  .review-issues { color: var(--warning, #d29922); }
  .review-escalated { color: var(--danger, #d73a49); }
  .queue-actions { display: flex; align-items: center; gap: 12px; margin: 8px 0 12px 0; }
  .refresh-btn { padding: 4px 12px; border: 1px solid var(--border); border-radius: 4px; cursor: pointer; background: var(--bg-secondary); color: var(--text); font-size: 0.9em; }
  .refresh-btn:hover:not(:disabled) { background: var(--accent, #1f6feb); color: #fff; }
  .refresh-btn:disabled { opacity: 0.6; cursor: not-allowed; }
  .refresh-note { font-size: 0.85em; color: var(--text-muted, #8b949e); }
  .merge-error { font-size: 0.8em; color: var(--danger, #d73a49); margin-left: 8px; word-break: break-word; }
  </style>
  ${ALPINE_SCRIPT}
</head>
<body x-data="queuePage()">
  ${buildPageHeader("Queue", theme)}
  ${THEME_SCRIPT}
  <div class="queue-actions">
    <button class="refresh-btn" @click="refreshQueue($event)" title="Trigger issue-dispatcher and pr-dispatcher to rescan GitHub">Refresh from GitHub</button>
    <span class="refresh-note" x-text="refreshStatus"></span>
  </div>
  ${buildQueueSection("Needs My Attention", myAttention, false, pipeline)}
  ${buildQueueSection("Needs Claws Attention", clawsAttention, true, pipeline)}
  ${buildSkippedSection(skippedItems)}
  ${buildProblematicSection(problematicPRs)}
  ${staleNote}
  ${QUEUE_SCRIPT}
</body>
</html>`;
}
