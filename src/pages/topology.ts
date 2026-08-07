import type { Theme } from "./layout.js";
import {
  PAGE_CSS,
  TAILWIND_STYLESHEET,
  HEAD_META,
  escapeHtml,
  repoShortName,
  htmlOpenTag,
  buildPageHeader,
  THEME_SCRIPT,
  ALPINE_SCRIPT,
} from "./layout.js";

interface RunningTaskInfo {
  jobName: string;
  repo: string;
  itemNumber: number;
  startedAt: string;
}

interface LatestRunInfo {
  runId: string;
  status: string;
  startedAt: string;
  completedAt: string | null;
}

// ── Topology layout constants ──

// SVG viewBox width (height computed dynamically as totalH)
const VB_W = 1180;

// Node dimensions
const NODE_W = 135;
const NODE_H = 46;
const NODE_RX = 8;

// Spacing
const ROW_Y_START = 30;
const ROW_GAP = 70;
const COL_GAP = 165;

// ── Node definitions ──

interface TopoNode {
  id: string;
  label: string;
  x: number;
  y: number;
  /** Scheduler job name (for idle/paused/running state from scheduler) */
  schedulerJob?: string;
  /** Agent-level job names that indicate this node is actively processing */
  agentJobs?: string[];
  /** Queue category that feeds into this node */
  queueCategory?: string;
  /** Whether this is a virtual source/sink node (no state) */
  virtual?: boolean;
}

interface TopoEdge {
  from: string;
  to: string;
  label?: string;
  /** Render as a dashed feedback edge */
  dashed?: boolean;
  /** Vertical offset (px) applied to the source anchor. Positive = lower. */
  fromOffsetY?: number;
  /** Vertical offset (px) applied to the target anchor. Positive = lower. */
  toOffsetY?: number;
}

// ── Issue pipeline (row 0-1) ──

const ISSUE_ROW_Y = ROW_Y_START;                        // 30
const PR_MAIN_Y   = ROW_Y_START + ROW_GAP * 2;          // 170
const PR_TOP_Y    = PR_MAIN_Y - ROW_GAP + 15;           // 115
const PR_BOT_Y    = PR_MAIN_Y + ROW_GAP - 15;           // 225

function col(n: number): number {
  return 20 + n * COL_GAP;
}

const PIPELINE_NODES: TopoNode[] = [
  // Issue pipeline
  { id: "issues-arrive", label: "Issues Arrive", x: col(0), y: ISSUE_ROW_Y, virtual: true },
  { id: "issue-dispatcher", label: "Issue Dispatcher", x: col(1), y: ISSUE_ROW_Y, schedulerJob: "issue-dispatcher" },
  { id: "planner", label: "Planner", x: col(2), y: ISSUE_ROW_Y, agentJobs: ["issue-refiner"], queueCategory: "needs-refinement" },
  { id: "implementer", label: "Implementer", x: col(3), y: ISSUE_ROW_Y, agentJobs: ["issue-worker"], queueCategory: "refined" },
  { id: "pr-created", label: "PR Created", x: col(4), y: ISSUE_ROW_Y, virtual: true },

  // PR pipeline
  { id: "prs-arrive", label: "PRs Arrive", x: col(0), y: PR_MAIN_Y, virtual: true },
  { id: "pr-dispatcher", label: "PR Dispatcher", x: col(1), y: PR_MAIN_Y, schedulerJob: "pr-dispatcher" },
  { id: "ci-fixer", label: "CI Fixer", x: col(2), y: PR_TOP_Y, agentJobs: ["ci-fixer", "ci-fixer:merge-conflict", "ci-fixer:revert", "ci-fixer:merge-base"] },
  { id: "review-addresser", label: "Review Addresser", x: col(2), y: PR_MAIN_Y, agentJobs: ["review-addresser"], queueCategory: "needs-review-addressing" },
  { id: "reviewer", label: "Reviewer", x: col(2), y: PR_BOT_Y, agentJobs: ["pr-reviewer"] },

  // QA aligned with pr-created (col 4) so pr-created→qa-phase is a clean vertical arrow
  { id: "qa-phase", label: "QA Phase", x: col(4), y: PR_MAIN_Y, schedulerJob: "qa-phase", queueCategory: "needs-qa" },

  // Merger forward of QA so qa-phase→merger is a left-to-right arrow
  { id: "merger", label: "Merger", x: col(5), y: PR_MAIN_Y, agentJobs: ["auto-merger"], queueCategory: "auto-mergeable" },

  // Sink
  { id: "merged", label: "Merged", x: col(6), y: PR_MAIN_Y, virtual: true },
];

const PIPELINE_EDGES: TopoEdge[] = [
  // Issue flow
  { from: "issues-arrive", to: "issue-dispatcher" },
  { from: "issue-dispatcher", to: "planner", label: "Needs refinement" },
  { from: "planner", to: "implementer", label: "Refined" },
  { from: "implementer", to: "pr-created", label: "PR opened" },

  // PR flow — fan-out from pr-dispatcher, offset to avoid source overlap
  { from: "prs-arrive", to: "pr-dispatcher" },
  { from: "pr-dispatcher", to: "ci-fixer",         label: "CI failing",     fromOffsetY: -12 },
  { from: "pr-dispatcher", to: "review-addresser",  label: "Review changes", fromOffsetY:  -4 },
  { from: "pr-dispatcher", to: "reviewer",          label: "Needs review",   fromOffsetY:   4 },
  { from: "pr-dispatcher", to: "merger",            label: "Auto-merge",     fromOffsetY:  12 },

  // Convergence into QA — offset targets so they don't stack on qa-phase's left edge
  { from: "pr-created",       to: "qa-phase" },
  { from: "ci-fixer",         to: "qa-phase", toOffsetY: -8 },
  { from: "review-addresser", to: "qa-phase", toOffsetY:  8 },

  // QA → Merger forward flow
  { from: "qa-phase", to: "merger", label: "QA passed" },

  // Feedback / terminal
  { from: "reviewer", to: "pr-dispatcher", label: "Re-dispatch", dashed: true },
  { from: "merger",   to: "merged" },
];

// ── Standalone / Maintenance nodes ──

const MAINT_X_START = 20;
const MAINT_Y = PR_BOT_Y + ROW_GAP + 30;
const MAINT_NODE_W = 110;
const MAINT_NODE_H = 32;
const MAINT_COL_GAP = 125;
const MAINT_ROW_GAP = 44;
const MAINT_PER_ROW = 8;

const MAINTENANCE_JOBS = [
  { id: "triage-claws-errors", label: "Claws Triage" },
  { id: "runner-monitor", label: "Runner Monitor" },
  { id: "email-monitor", label: "Email Monitor" },
  { id: "idea-collector", label: "Idea Collector" },
  { id: "idea-suggester", label: "Idea Suggester" },
  { id: "idea-reconciler", label: "Idea Reconciler" },
  { id: "doc-maintainer", label: "Doc Maintainer" },
  { id: "repo-standards", label: "Repo Standards" },
  { id: "improvement-identifier", label: "Code Reviewer" },
  { id: "issue-auditor", label: "Issue Auditor" },
  { id: "stale-branch-cleaner", label: "Branch Cleaner" },
  { id: "ubuntu-latest-scanner", label: "Ubuntu Scanner" },
  { id: "concurrency-scanner", label: "Concurrency Scan" },
  { id: "migration-scanner", label: "Migration Scan" },
];

// ── SVG rendering helpers ──

function arrowMarkerDef(): string {
  return `<defs>
    <marker id="arrow" markerWidth="10" markerHeight="7" refX="10" refY="3.5" orient="auto">
      <polygon points="0 0, 10 3.5, 0 7" fill="var(--text-subtle)" />
    </marker>
    <marker id="arrow-warn" markerWidth="10" markerHeight="7" refX="10" refY="3.5" orient="auto">
      <polygon points="0 0, 10 3.5, 0 7" fill="var(--warning)" />
    </marker>
  </defs>`;
}

type NodeState = "running" | "idle" | "paused" | "errored";

function nodeStateInfo(
  node: TopoNode,
  jobs: Record<string, boolean>,
  runningTasks: RunningTaskInfo[],
  latestRuns: Map<string, LatestRunInfo>,
  paused: Set<string>,
): { state: NodeState; detail: string } {
  if (node.virtual) return { state: "idle", detail: "" };

  // Check if any agent-level task is running for this node
  if (node.agentJobs) {
    const activeTask = runningTasks.find(t => node.agentJobs!.includes(t.jobName));
    if (activeTask) {
      const detail = activeTask.itemNumber > 0
        ? `${repoShortName(activeTask.repo)}#${activeTask.itemNumber}`
        : repoShortName(activeTask.repo);
      return { state: "running", detail };
    }
  }

  // Check scheduler job state
  if (node.schedulerJob) {
    if (paused.has(node.schedulerJob)) return { state: "paused", detail: "Paused" };
    if (jobs[node.schedulerJob]) {
      // Scheduler job is running — check for task details
      const task = runningTasks.find(t => t.jobName === node.schedulerJob);
      if (task) {
        const detail = task.itemNumber > 0
          ? `${repoShortName(task.repo)}#${task.itemNumber}`
          : repoShortName(task.repo);
        return { state: "running", detail };
      }
      return { state: "running", detail: "" };
    }

    // Check if last run failed
    const latest = latestRuns.get(node.schedulerJob);
    if (latest?.status === "failed") return { state: "errored", detail: "Last run failed" };
  }

  return { state: "idle", detail: "" };
}

function svgNodeRect(
  x: number,
  y: number,
  w: number,
  h: number,
  state: NodeState,
  virtual: boolean,
): string {
  const cls = virtual ? "topo-node topo-node-virtual" : `topo-node topo-node-${state}`;
  return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${NODE_RX}" class="${cls}" />`;
}

function svgEdge(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  label: string | undefined,
  bottleneckCount: number,
  toNodeId: string,
  dashed?: boolean,
): string {
  const warn = bottleneckCount > 0;
  let cls = warn ? "topo-edge topo-edge-bottleneck" : "topo-edge";
  if (dashed) cls += " topo-edge-dashed";
  const marker = warn ? "url(#arrow-warn)" : "url(#arrow)";

  // Calculate midpoint for label
  const mx = (x1 + x2) / 2;
  const my = (y1 + y2) / 2;

  let html = `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" class="${cls}" marker-end="${marker}" data-to="${escapeHtml(toNodeId)}" />`;

  if (label) {
    html += `<text x="${mx}" y="${my - 6}" class="topo-label">${escapeHtml(label)}</text>`;
  }
  return html;
}

// ── Main page builder ──

export function buildTopologyPage(
  jobs: Record<string, boolean>,
  runningTasks: RunningTaskInfo[],
  latestRuns: Map<string, LatestRunInfo>,
  paused: Set<string>,
  claudeQueue: { pending: number; active: number },
  queueCategoryCounts: Record<string, number>,
  theme: Theme,
): string {
  // Compute total SVG height based on maintenance rows
  const maintRows = Math.ceil(MAINTENANCE_JOBS.length / MAINT_PER_ROW);
  const totalH = MAINT_Y + maintRows * MAINT_ROW_GAP + 40;

  // Build SVG content
  let svg = `<svg viewBox="0 0 ${VB_W} ${totalH}" xmlns="http://www.w3.org/2000/svg" class="topo-svg">`;
  svg += arrowMarkerDef();

  // ── Draw edges first (behind nodes) ──
  for (const edge of PIPELINE_EDGES) {
    const fromNode = PIPELINE_NODES.find(n => n.id === edge.from)!;
    const toNode = PIPELINE_NODES.find(n => n.id === edge.to)!;

    // Smart anchoring based on relative positions
    const fOff = edge.fromOffsetY ?? 0;
    const tOff = edge.toOffsetY ?? 0;
    let x1: number, y1: number, x2: number, y2: number;
    const dx = toNode.x - fromNode.x;
    if (Math.abs(dx) < NODE_W) {
      // Vertical: bottom/top anchoring (nodes overlap horizontally)
      const goDown = toNode.y > fromNode.y;
      x1 = fromNode.x + NODE_W / 2;
      y1 = (goDown ? fromNode.y + NODE_H : fromNode.y) + fOff;
      x2 = toNode.x + NODE_W / 2;
      y2 = (goDown ? toNode.y : toNode.y + NODE_H) + tOff;
    } else if (dx < 0) {
      // Right-to-left (feedback): left of source → right of target
      x1 = fromNode.x;
      y1 = fromNode.y + NODE_H / 2 + fOff;
      x2 = toNode.x + NODE_W;
      y2 = toNode.y + NODE_H / 2 + tOff;
    } else {
      // Left-to-right: right of source → left of target
      x1 = fromNode.x + NODE_W;
      y1 = fromNode.y + NODE_H / 2 + fOff;
      x2 = toNode.x;
      y2 = toNode.y + NODE_H / 2 + tOff;
    }

    // Check bottleneck: how many items are waiting at the target node's queue category
    const bottleneck = toNode.queueCategory ? (queueCategoryCounts[toNode.queueCategory] ?? 0) : 0;

    svg += svgEdge(x1, y1, x2, y2, edge.label, bottleneck, edge.to, edge.dashed);
  }

  // ── Draw pipeline nodes ──
  for (const node of PIPELINE_NODES) {
    const { state, detail } = nodeStateInfo(node, jobs, runningTasks, latestRuns, paused);

    svg += `<g class="topo-node-group" data-node="${escapeHtml(node.id)}">`;
    svg += svgNodeRect(node.x, node.y, NODE_W, NODE_H, state, !!node.virtual);

    // Node label
    const textY = detail ? node.y + NODE_H / 2 - 4 : node.y + NODE_H / 2 + 4;
    svg += `<text x="${node.x + NODE_W / 2}" y="${textY}" class="topo-node-label">${escapeHtml(node.label)}</text>`;

    // Detail line (item number or status)
    if (detail) {
      svg += `<text x="${node.x + NODE_W / 2}" y="${node.y + NODE_H / 2 + 12}" class="topo-node-detail topo-detail-${state}">${escapeHtml(detail)}</text>`;
    }

    // Queue count badge on the node itself
    if (node.queueCategory) {
      const count = queueCategoryCounts[node.queueCategory] ?? 0;
      if (count > 0) {
        const bw = count > 99 ? 36 : count > 9 ? 28 : 20;
        const bcx = bw / 2;
        svg += `<g>
          <rect x="${node.x + NODE_W - 16}" y="${node.y - 8}" width="${bw}" height="18" rx="9" class="topo-badge" />
          <text x="${node.x + NODE_W - 16 + bcx}" y="${node.y + 6}" class="topo-badge-text">${count}</text>
        </g>`;
      }
    }

    svg += `</g>`;
  }

  // ── Section label for maintenance ──
  svg += `<text x="${MAINT_X_START}" y="${MAINT_Y - 16}" class="topo-section-label">Scheduled &amp; Monitors</text>`;

  // ── Draw maintenance nodes ──
  for (let i = 0; i < MAINTENANCE_JOBS.length; i++) {
    const mj = MAINTENANCE_JOBS[i];
    const row = Math.floor(i / MAINT_PER_ROW);
    const colIdx = i % MAINT_PER_ROW;
    const mx = MAINT_X_START + colIdx * MAINT_COL_GAP;
    const my = MAINT_Y + row * MAINT_ROW_GAP;

    const isPaused = paused.has(mj.id);
    const isRunning = !!jobs[mj.id];
    const latest = latestRuns.get(mj.id);
    const isErrored = latest?.status === "failed";
    const state: NodeState = isRunning ? "running" : isPaused ? "paused" : isErrored ? "errored" : "idle";

    svg += `<g class="topo-node-group" data-node="${escapeHtml(mj.id)}">`;
    svg += `<rect x="${mx}" y="${my}" width="${MAINT_NODE_W}" height="${MAINT_NODE_H}" rx="6" class="topo-node topo-node-${state} topo-node-compact" />`;
    svg += `<text x="${mx + MAINT_NODE_W / 2}" y="${my + MAINT_NODE_H / 2 + 4}" class="topo-node-label topo-label-compact">${escapeHtml(mj.label)}</text>`;
    svg += `</g>`;
  }

  svg += `</svg>`;

  // Claude queue summary
  const cqTotal = claudeQueue.pending + claudeQueue.active;
  const cqHtml = cqTotal > 0
    ? `<span class="running">${claudeQueue.active} active</span>, ${claudeQueue.pending} pending`
    : `<span class="idle">Idle</span>`;

  return `<!DOCTYPE html>
${htmlOpenTag(theme)}
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  ${HEAD_META}
  <title>claws — Topology</title>
  ${TAILWIND_STYLESHEET}
  <style>${PAGE_CSS}
    ${TOPOLOGY_CSS}
  </style>
  ${ALPINE_SCRIPT}
</head>
<body x-data="topologyPage()" x-init="startPolling()">
  ${buildPageHeader("Pipeline Topology", theme)}
  ${THEME_SCRIPT}
  <dl class="meta">
    <dt>Claude Queue</dt>
    <dd id="topo-cq">${cqHtml}</dd>
  </dl>
  <div class="topo-container">
    ${svg}
  </div>
  <p class="refresh-note">Live-updating every 30s</p>
  <script>
    ${TOPOLOGY_SCRIPT}
  </script>
</body>
</html>`;
}

// ── Topology-specific CSS ──

const TOPOLOGY_CSS = `
    .topo-container {
      overflow-x: auto;
      margin: 1rem 0;
      -webkit-overflow-scrolling: touch;
    }
    .topo-svg {
      width: 100%;
      min-width: 900px;
      height: auto;
    }
    .topo-node {
      fill: var(--bg-secondary);
      stroke: var(--border);
      stroke-width: 2;
    }
    .topo-node-virtual {
      fill: none;
      stroke: var(--border);
      stroke-dasharray: 6 3;
      stroke-width: 1;
    }
    .topo-node-running {
      stroke: var(--success);
      stroke-width: 2.5;
      animation: topo-pulse 1.5s ease-in-out infinite;
    }
    .topo-node-paused {
      stroke: var(--warning);
      stroke-width: 2;
    }
    .topo-node-errored {
      stroke: var(--danger);
      stroke-width: 2;
    }
    .topo-node-idle {
      stroke: var(--border-hover);
    }
    @keyframes topo-pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.7; }
    }
    .topo-node-label {
      fill: var(--text);
      font-size: 10.5px;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      text-anchor: middle;
      dominant-baseline: middle;
      pointer-events: none;
    }
    .topo-label-compact {
      font-size: 9.5px;
    }
    .topo-node-detail {
      fill: var(--text-secondary);
      font-size: 9px;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      text-anchor: middle;
      pointer-events: none;
    }
    .topo-detail-running { fill: var(--success); }
    .topo-detail-paused { fill: var(--warning); }
    .topo-detail-errored { fill: var(--danger); }
    .topo-edge {
      stroke: var(--text-subtle);
      stroke-width: 1.5;
    }
    .topo-edge-bottleneck {
      stroke: var(--warning);
      stroke-width: 2;
    }
    .topo-edge-dashed {
      stroke-dasharray: 6 3;
    }
    .topo-label {
      fill: var(--text-subtle);
      font-size: 9px;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      text-anchor: middle;
      pointer-events: none;
    }
    .topo-badge {
      fill: var(--warning);
      opacity: 0.9;
    }
    .topo-badge-text {
      fill: #fff;
      font-size: 10px;
      font-weight: 700;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      text-anchor: middle;
      dominant-baseline: middle;
      pointer-events: none;
    }
    .topo-section-label {
      fill: var(--text-secondary);
      font-size: 13px;
      font-weight: 600;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    }
    body { max-width: 1180px; }
    @media (max-width: 600px) {
      .topo-svg { min-width: 600px; }
    }
`;

// ── Client-side update script ──

const TOPOLOGY_SCRIPT = `
    function topologyPage() {
      const pipelineNodes = ${JSON.stringify(PIPELINE_NODES.map(n => ({ id: n.id, schedulerJob: n.schedulerJob, agentJobs: n.agentJobs, queueCategory: n.queueCategory, virtual: n.virtual }))).replace(/</g, "\\u003c")};
      const maintJobs = ${JSON.stringify(MAINTENANCE_JOBS.map(m => ({ id: m.id }))).replace(/</g, "\\u003c")};

      return {
        repoShortName(fullName) {
          const i = fullName.indexOf('/');
          return i >= 0 ? fullName.slice(i + 1) : fullName;
        },
        updateTopology(data) {
          const pausedSet = {};
          if (data.pausedJobs) data.pausedJobs.forEach(n => { pausedSet[n] = true; });

          const taskByAgent = {};
          if (data.runningTasks) {
            data.runningTasks.forEach(t => { taskByAgent[t.jobName] = t; });
          }

          const catCounts = data.queueCategoryCounts || {};

          pipelineNodes.forEach(node => {
            if (node.virtual) return;
            const group = document.querySelector('[data-node="' + node.id + '"]');
            if (!group) return;
            const rect = group.querySelector('rect');
            if (!rect) return;

            let state = 'idle';
            let detail = '';

            if (node.agentJobs) {
              for (let i = 0; i < node.agentJobs.length; i++) {
                const t = taskByAgent[node.agentJobs[i]];
                if (t) {
                  state = 'running';
                  detail = t.itemNumber > 0
                    ? this.repoShortName(t.repo) + '#' + t.itemNumber
                    : this.repoShortName(t.repo);
                  break;
                }
              }
            }

            if (state === 'idle' && node.schedulerJob) {
              if (pausedSet[node.schedulerJob]) {
                state = 'paused';
                detail = 'Paused';
              } else if (data.jobs[node.schedulerJob]) {
                state = 'running';
                const st = taskByAgent[node.schedulerJob];
                if (st) {
                  detail = st.itemNumber > 0
                    ? this.repoShortName(st.repo) + '#' + st.itemNumber
                    : this.repoShortName(st.repo);
                }
              } else if (data.latestRunStatuses && data.latestRunStatuses[node.schedulerJob] === 'failed') {
                state = 'errored';
                detail = 'Last run failed';
              }
            }

            rect.setAttribute('class', 'topo-node topo-node-' + state);

            const existingDetail = group.querySelector('.topo-node-detail');
            if (existingDetail) existingDetail.remove();

            if (detail) {
              const ns = 'http://www.w3.org/2000/svg';
              const dt = document.createElementNS(ns, 'text');
              const rx = parseFloat(rect.getAttribute('x'));
              const ry = parseFloat(rect.getAttribute('y'));
              const rw = parseFloat(rect.getAttribute('width'));
              const rh = parseFloat(rect.getAttribute('height'));
              dt.setAttribute('x', String(rx + rw / 2));
              dt.setAttribute('y', String(ry + rh / 2 + 12));
              dt.setAttribute('class', 'topo-node-detail topo-detail-' + state);
              dt.textContent = detail;
              group.appendChild(dt);

              const label = group.querySelector('.topo-node-label');
              if (label) label.setAttribute('y', String(ry + rh / 2 - 4));
            } else {
              const label = group.querySelector('.topo-node-label');
              if (label) {
                const rx2 = parseFloat(rect.getAttribute('x'));
                const ry2 = parseFloat(rect.getAttribute('y'));
                const rh2 = parseFloat(rect.getAttribute('height'));
                label.setAttribute('y', String(ry2 + rh2 / 2 + 4));
              }
            }

            if (node.queueCategory) {
              const count = catCounts[node.queueCategory] || 0;
              const existingBadge = group.querySelector('.topo-badge');
              if (existingBadge) {
                const badgeG = existingBadge.parentNode;
                if (count > 0) {
                  const ubw = count > 99 ? 36 : count > 9 ? 28 : 20;
                  existingBadge.setAttribute('width', String(ubw));
                  const badgeText = badgeG.querySelector('.topo-badge-text');
                  if (badgeText) {
                    badgeText.setAttribute('x', String(parseFloat(existingBadge.getAttribute('x')) + ubw / 2));
                    badgeText.textContent = String(count);
                  }
                } else {
                  badgeG.remove();
                }
              } else if (count > 0) {
                const ns2 = 'http://www.w3.org/2000/svg';
                const bx = parseFloat(rect.getAttribute('x'));
                const by = parseFloat(rect.getAttribute('y'));
                const bw = parseFloat(rect.getAttribute('width'));
                const bg = document.createElementNS(ns2, 'g');
                const br = document.createElementNS(ns2, 'rect');
                const nbw = count > 99 ? 36 : count > 9 ? 28 : 20;
                br.setAttribute('x', String(bx + bw - 16));
                br.setAttribute('y', String(by - 8));
                br.setAttribute('width', String(nbw));
                br.setAttribute('height', '18');
                br.setAttribute('rx', '9');
                br.setAttribute('class', 'topo-badge');
                bg.appendChild(br);
                const bt = document.createElementNS(ns2, 'text');
                bt.setAttribute('x', String(bx + bw - 16 + nbw / 2));
                bt.setAttribute('y', String(by + 6));
                bt.setAttribute('class', 'topo-badge-text');
                bt.textContent = String(count);
                bg.appendChild(bt);
                group.appendChild(bg);
              }
            }
          });

          maintJobs.forEach(mj => {
            const group = document.querySelector('[data-node="' + mj.id + '"]');
            if (!group) return;
            const rect = group.querySelector('rect');
            if (!rect) return;

            let state = 'idle';
            if (data.jobs[mj.id]) state = 'running';
            else if (pausedSet[mj.id]) state = 'paused';
            else if (data.latestRunStatuses && data.latestRunStatuses[mj.id] === 'failed') state = 'errored';

            rect.setAttribute('class', 'topo-node topo-node-' + state + ' topo-node-compact');
          });

          const nodeQueueMap = {};
          pipelineNodes.forEach(n => {
            if (n.queueCategory) nodeQueueMap[n.id] = n.queueCategory;
          });
          const edgeLines = document.querySelectorAll('line[data-to]');
          for (let ei = 0; ei < edgeLines.length; ei++) {
            const line = edgeLines[ei];
            const toId = line.getAttribute('data-to');
            const cat = toId ? nodeQueueMap[toId] : null;
            const hasBottleneck = cat && (catCounts[cat] || 0) > 0;
            const wasDashed = line.getAttribute('class').indexOf('topo-edge-dashed') >= 0;
            let cls = hasBottleneck ? 'topo-edge topo-edge-bottleneck' : 'topo-edge';
            if (wasDashed) cls += ' topo-edge-dashed';
            line.setAttribute('class', cls);
            line.setAttribute('marker-end', hasBottleneck ? 'url(#arrow-warn)' : 'url(#arrow)');
          }

          const cqEl = document.getElementById('topo-cq');
          if (cqEl) {
            const total = (data.claudeQueue.active || 0) + (data.claudeQueue.pending || 0);
            cqEl.textContent = '';
            const span = document.createElement('span');
            if (total > 0) {
              span.className = 'running';
              span.textContent = data.claudeQueue.active + ' active';
              cqEl.appendChild(span);
              cqEl.appendChild(document.createTextNode(', ' + data.claudeQueue.pending + ' pending'));
            } else {
              span.className = 'idle';
              span.textContent = 'Idle';
              cqEl.appendChild(span);
            }
          }
        },
        refresh() {
          fetch('/status?topology=1')
            .then(r => r.json())
            .then(data => this.updateTopology(data))
            .catch(() => {});
        },
        startPolling() {
          setInterval(() => this.refresh(), 30000);
        },
      };
    }
`;
