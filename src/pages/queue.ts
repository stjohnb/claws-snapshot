import type { Theme } from "./layout.js";
import { PAGE_CSS, escapeHtml, repoShortName, itemLogsUrl, formatRelativeTime, htmlOpenTag, buildNav, THEME_SCRIPT } from "./layout.js";
import type { QueueItem, QueueCategory } from "../github.js";

const CATEGORY_DISPLAY: Record<QueueCategory, { label: string; color: string }> = {
  "ready": { label: "Ready", color: "0e8a16" },
  "needs-refinement": { label: "Needs Refinement", color: "d876e3" },
  "refined": { label: "Refined", color: "0075ca" },
  "needs-review-addressing": { label: "Needs Review Addressing", color: "e4e669" },
  "auto-mergeable": { label: "Auto-Mergeable", color: "0e8a16" },
  "needs-triage": { label: "Needs Triage", color: "d73a49" },
};

const CATEGORY_PRIORITY: Record<QueueCategory, number> = {
  "needs-review-addressing": 0,
  "auto-mergeable": 1,
  "refined": 2,
  "needs-refinement": 3,
  "needs-triage": 4,
  "ready": 0,
};

function buildQueueSection(
  title: string,
  snapshot: { items: QueueItem[]; oldestFetchAt: number | null },
  showActions: boolean,
): string {
  if (snapshot.oldestFetchAt === null) {
    return `<div class="queue-section"><h2>${escapeHtml(title)}</h2><p class="queue-empty">Waiting for first scan...</p></div>`;
  }

  if (snapshot.items.length === 0) {
    return `<div class="queue-section"><h2>${escapeHtml(title)}</h2><p class="queue-empty">Nothing waiting</p></div>`;
  }

  // Group items by category
  const groups = new Map<QueueCategory, QueueItem[]>();
  for (const item of snapshot.items) {
    if (!groups.has(item.category)) groups.set(item.category, []);
    groups.get(item.category)!.push(item);
  }

  const sortedGroups = [...groups.entries()].sort(([a], [b]) => {
    const pa = CATEGORY_PRIORITY[a] ?? 99;
    const pb = CATEGORY_PRIORITY[b] ?? 99;
    return pa - pb;
  });

  let html = `<div class="queue-section"><h2>${escapeHtml(title)}</h2>`;
  for (const [category, items] of sortedGroups) {
    const display = CATEGORY_DISPLAY[category] ?? { label: category, color: "30363d" };
    const bgColor = `#${display.color}`;
    const textColor = parseInt(display.color, 16) > 0x7fffff ? "#000" : "#fff";
    html += `<div class="queue-group">`;
    html += `<div class="queue-group-header">`;
    html += `<span class="queue-label" style="background:${bgColor};color:${textColor}">${escapeHtml(display.label)}</span>`;
    html += `<span class="queue-count">${items.length}</span>`;
    html += `</div>`;
    for (const item of items) {
      const displayNumber = item.prNumber ?? item.number;
      const itemUrl = itemLogsUrl(item.repo, displayNumber);
      const escapedRepo = escapeHtml(item.repo);

      html += `<div class="queue-item" id="item-${escapedRepo}-${item.number}">`;

      // Priority indicator
      if (item.prioritized) html += `<span class="priority-star" title="Prioritised">&#x2605;</span>`;

      // Check status indicator
      if (item.checkStatus === "passing") html += `<span class="check check-pass">&#x2714;</span>`;
      else if (item.checkStatus === "failing") html += `<span class="check check-fail">&#x2718;</span>`;
      else if (item.checkStatus === "pending") html += `<span class="check check-pending">&#x25CB;</span>`;

      html += `<span class="repo">${escapeHtml(repoShortName(item.repo))}</span>`;
      html += `<a class="number" href="${itemUrl}">#${displayNumber}</a>`;
      html += `<span class="title">${escapeHtml(item.title)}</span>`;
      html += `<span class="time">${formatRelativeTime(item.updatedAt)}</span>`;

      // Squash & merge button for green PRs
      if (item.checkStatus === "passing" && item.prNumber != null) {
        html += `<button class="merge-btn" onclick="mergePR('${escapedRepo}',${item.prNumber},this)">Squash &amp; Merge</button>`;
      }

      // Skip & prioritize buttons (only for Claws Attention section)
      if (showActions) {
        if (item.prioritized) {
          html += `<button class="prio-btn deprio" onclick="deprioritizeItem('${escapedRepo}',${item.number},this)">Deprioritise</button>`;
        } else {
          html += `<button class="prio-btn" onclick="prioritizeItem('${escapedRepo}',${item.number},this)">Prioritise</button>`;
        }
        html += `<button class="skip-btn" onclick="skipItem('${escapedRepo}',${item.number},this)">Skip</button>`;
      }

      html += `</div>`;
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
    html += `<button class="restore-btn" onclick="unskipItem('${escapedRepo}',${item.number},this)">Restore</button>`;
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
  <meta http-equiv="refresh" content="60">
  <title>claws — Queue</title>
  <style>${PAGE_CSS}
  .priority-star { color: #f0ad4e; margin-right: 4px; font-size: 1.1em; }
  .prio-btn, .skip-btn, .restore-btn { padding: 2px 8px; margin-left: 4px; border: 1px solid var(--border); border-radius: 4px; cursor: pointer; font-size: 0.85em; background: var(--bg-secondary); color: var(--text); }
  .prio-btn:hover { background: #f0ad4e; color: #000; }
  .prio-btn.deprio:hover { background: var(--bg-secondary); }
  .skip-btn:hover { background: #d73a49; color: #fff; }
  .restore-btn:hover { background: #0e8a16; color: #fff; }
  .skipped-section { margin-top: 1em; }
  .skipped-section summary { cursor: pointer; }
  </style>
</head>
<body>
  ${buildNav(theme)}
  ${THEME_SCRIPT}
  <h1>Queue</h1>
  ${buildQueueSection("Needs My Attention", myAttention, false)}
  ${buildQueueSection("Needs Claws Attention", clawsAttention, true)}
  ${buildSkippedSection(skippedItems)}
  ${staleNote}
  <script>
    function mergePR(repo, prNumber, btn) {
      btn.disabled = true;
      btn.textContent = 'Merging...';
      fetch('/queue/merge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ repo: repo, prNumber: prNumber })
      }).then(function(r) { return r.json(); }).then(function(data) {
        if (data.error) {
          btn.textContent = 'Error';
          btn.title = data.error;
          setTimeout(function() { btn.textContent = 'Squash & Merge'; btn.disabled = false; }, 3000);
        } else {
          btn.textContent = 'Merged!';
        }
      }).catch(function() {
        btn.textContent = 'Error';
        setTimeout(function() { btn.textContent = 'Squash & Merge'; btn.disabled = false; }, 3000);
      });
    }

    function skipItem(repo, number, btn) {
      btn.disabled = true;
      btn.textContent = 'Skipping...';
      fetch('/queue/skip', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ repo: repo, number: number })
      }).then(function(r) { return r.json(); }).then(function(data) {
        if (data.error) {
          btn.textContent = 'Error';
          setTimeout(function() { btn.textContent = 'Skip'; btn.disabled = false; }, 3000);
        } else {
          var row = btn.closest('.queue-item');
          if (row) row.remove();
        }
      }).catch(function() {
        btn.textContent = 'Error';
        setTimeout(function() { btn.textContent = 'Skip'; btn.disabled = false; }, 3000);
      });
    }

    function unskipItem(repo, number, btn) {
      btn.disabled = true;
      btn.textContent = 'Restoring...';
      fetch('/queue/unskip', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ repo: repo, number: number })
      }).then(function(r) { return r.json(); }).then(function(data) {
        if (data.error) {
          btn.textContent = 'Error';
          setTimeout(function() { btn.textContent = 'Restore'; btn.disabled = false; }, 3000);
        } else {
          var row = btn.closest('.queue-item');
          if (row) row.remove();
        }
      }).catch(function() {
        btn.textContent = 'Error';
        setTimeout(function() { btn.textContent = 'Restore'; btn.disabled = false; }, 3000);
      });
    }

    function prioritizeItem(repo, number, btn) {
      btn.disabled = true;
      btn.textContent = 'Prioritising...';
      fetch('/queue/prioritize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ repo: repo, number: number })
      }).then(function(r) { return r.json(); }).then(function(data) {
        if (data.error) {
          btn.textContent = 'Error';
          setTimeout(function() { btn.textContent = 'Prioritise'; btn.disabled = false; }, 3000);
        } else {
          btn.textContent = 'Deprioritise';
          btn.className = 'prio-btn deprio';
          btn.disabled = false;
          btn.setAttribute('onclick', "deprioritizeItem('" + repo + "'," + number + ",this)");
        }
      }).catch(function() {
        btn.textContent = 'Error';
        setTimeout(function() { btn.textContent = 'Prioritise'; btn.disabled = false; }, 3000);
      });
    }

    function deprioritizeItem(repo, number, btn) {
      btn.disabled = true;
      btn.textContent = 'Deprioritising...';
      fetch('/queue/deprioritize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ repo: repo, number: number })
      }).then(function(r) { return r.json(); }).then(function(data) {
        if (data.error) {
          btn.textContent = 'Error';
          setTimeout(function() { btn.textContent = 'Deprioritise'; btn.disabled = false; }, 3000);
        } else {
          btn.textContent = 'Prioritise';
          btn.className = 'prio-btn';
          btn.disabled = false;
          btn.setAttribute('onclick', "prioritizeItem('" + repo + "'," + number + ",this)");
        }
      }).catch(function() {
        btn.textContent = 'Error';
        setTimeout(function() { btn.textContent = 'Deprioritise'; btn.disabled = false; }, 3000);
      });
    }
  </script>
</body>
</html>`;
}
