import fs from "node:fs";
import path from "node:path";
import { type Repo } from "../config.js";
import * as gh from "../github.js";
import * as claude from "../claude.js";
import * as log from "../log.js";
import * as db from "../db.js";
import * as smartSchedule from "../smart-schedule.js";
import { buildSuccessOutcome } from "../outcome.js";
import { reportError } from "../error-reporter.js";
import { notify } from "../slack.js";
import { findPlanComment, type Provider } from "../plan-parser.js";
import { getModel } from "../model-selector.js";
import { CLAWS_AUTOMATION_DOC, CLAWS_AUTOMATION_DOC_PATH } from "../resources/claws-info.js";
import { guardContent } from "../prompt-guard.js";
import { mapSettledWithConcurrency } from "../util.js";

function isHumanLogin(login: string, selfLogin: string): boolean {
  if (!login) return false;
  if (selfLogin && login === selfLogin) return false;
  if (login.endsWith("[bot]")) return false;
  if (login.startsWith("app/")) return false;
  return true;
}

const CLAWS_BRANCH_PREFIXES = ["claws/", "claws-wt/", "dependabot/", "automation/", "codex/"];

/** Why a body was treated as machine-written, or null if it wasn't. */
type MachineBodyReason = "bracket-title" | "claws-marker" | "claws-branch";

/** Pre-App-migration Claws used the owner's PAT, so alert issues and generated PRs
 *  pass isHumanLogin(). Detect them structurally instead, otherwise a full-history
 *  backfill feeds hundreds of machine-written bodies to the agent as "owner intent".
 *  Returns the matching rule so the caller can log a per-rule count of dropped bodies. */
function machineAuthoredBodyReason(item: {
  kind: "Issue" | "PR";
  title: string;
  body: string;
  headRefName?: string;
}): MachineBodyReason | null {
  // Machine-filed alert issues are titled `[claws-error] ...`, `[ci] ...`, etc. This also
  // catches human conventions like `[Bug]`/`[RFC]`, hence the suppression count logged below.
  if (item.kind === "Issue" && item.title.trimStart().startsWith("[")) return "bracket-title";
  if (item.body.includes("**Auto-created by Claws") || item.body.includes("**Fingerprint:**")) return "claws-marker";
  if (gh.isClawsComment(item.body)) return "claws-marker";
  if (item.kind === "PR" && item.headRefName
    && CLAWS_BRANCH_PREFIXES.some((p) => item.headRefName!.startsWith(p))) return "claws-branch";
  return null;
}

function buildDocPrompt(fullName: string, planCount = 0, intentCount = 0): string {
  const lines = [
    `You are maintaining documentation for the repository ${fullName}.`,
    ``,
    `Your goal is to create or update documentation under \`docs/\` that is`,
    `optimized for providing context when planning and implementing new features`,
    `and bug fixes.`,
    ``,
    `Steps:`,
    `1. Run \`mkdir -p docs\` to ensure the directory exists.`,
    `2. Read the codebase to understand its current structure, purpose, and key`,
    `   patterns.`,
    `3. If \`docs/OVERVIEW.md\` exists, read it and all docs it links to, then`,
    `   update them to reflect the current state of the code. Preserve accurate`,
    `   content and update anything outdated. If it doesn't exist, create it`,
    `   from scratch.`,
    `4. \`docs/OVERVIEW.md\` is the main entry point and should include:`,
    `   - **Purpose**: What this repo does and its role (2-3 sentences)`,
    `   - **Architecture**: Key directories, modules, and how they fit together`,
    `   - **Key Patterns**: Important conventions, data flow, and design decisions`,
    `   - **Configuration**: Key config values and environment variables`,
    `5. For complex subsystems that need detailed coverage, create dedicated`,
    `   documents (e.g., \`docs/database-schema.md\`, \`docs/api-design.md\`) and`,
    `   link to them from OVERVIEW.md. Keep each focused on one subject.`,
    `6. Keep OVERVIEW.md concise (200-500 lines). Dedicated docs can be longer`,
    `   as needed for thorough coverage.`,
    `7. Commit with message: "docs: update documentation [doc-maintainer]"`,
    ``,
    ``,
    `A file \`${CLAWS_AUTOMATION_DOC_PATH}\` exists describing how the Claws`,
    `automation service manages this repo's issues, PRs, and labels. It is`,
    `maintained automatically — do NOT edit, rewrite, move, or delete it.`,
    `Ensure \`docs/OVERVIEW.md\` links to it (add a link if missing). Also ensure`,
    `the repo's root \`CLAUDE.md\` exists and points readers to the \`docs/\` folder`,
    `for context. If \`CLAUDE.md\` is absent, create it with: a 2-3 sentence`,
    `description of what the repo does, a "Where to read first" section pointing to`,
    `\`docs/OVERVIEW.md\`, and any key conventions or gotchas a developer needs to know.`,
    ``,
    `Do NOT make any code changes. Only update documentation.`,
  ];

  if (planCount > 0) {
    lines.push(
      ``,
      `A \`.plans/\` directory has been created in the repo root containing implementation`,
      `plans from ${planCount} recently-closed issues. Each file is named by issue number`,
      `(e.g., \`.plans/42.md\`).`,
      ``,
      `Read these plans and extract any valuable architectural context, design decisions,`,
      `conventions, or patterns into the existing documentation. Only add information that`,
      `is actually reflected in the current codebase. If a plan contains nothing new for`,
      `the docs, skip it. Do NOT commit the \`.plans/\` directory — it is temporary.`,
    );
  }

  if (intentCount > 0) {
    lines.push(
      ``,
      `An \`.intent/\` directory has been created containing human-authored issue/PR bodies`,
      `and comments (bot- and Claws-authored content excluded), one file per item. These`,
      `are the highest-signal statements of what the repo owner actually wants.`,
      ``,
      `Read every file in \`.intent/\` and ensure every requirement it states is REFLECTED in`,
      `the standard docs a future planning agent will read. This is a coverage check, not a`,
      `journal. For each requirement:`,
      `- Find the doc that owns the relevant subsystem (\`docs/OVERVIEW.md\`, \`docs/jobs/*.md\`,`,
      `  or another topic doc) and record the requirement there as a CONSTRAINT WITH ITS`,
      `  RATIONALE — e.g. "the owner explicitly does not want X automated because ..." —`,
      `  not merely as a description of current behaviour.`,
      `- If the requirement is cross-cutting or about process and belongs to no feature doc`,
      `  (e.g. "never un-archive public mirror repos automatically", "stop filing issues when`,
      `  nothing can be done about them"), record it in \`docs/requirements.md\` — create it if`,
      `  absent and link it from \`docs/OVERVIEW.md\`. A requirement that matches no feature doc`,
      `  MUST land there; never drop one silently.`,
      `- \`docs/requirements.md\` is NOT a catch-all. If a doc owns the subsystem the requirement`,
      `  is about, the requirement belongs in that doc, not there — a planner working on that`,
      `  subsystem opens the subsystem doc, which is the whole point of this exercise.`,
      `- If a requirement is already reflected accurately, change nothing.`,
      `- If a newer statement contradicts what a doc says today, update the doc to the newer`,
      `  position and note that it supersedes the older one. Record the CURRENT position, not`,
      `  a history of positions.`,
      `- \`.intent/\` may contain items from anywhere in the repo's history; older items whose`,
      `  requirement was later reversed should not resurrect the reversed behaviour.`,
      `- If \`docs/intent-log.md\` exists, fold any requirement it still holds into the docs`,
      `  above and then delete it with \`git rm docs/intent-log.md\`. Do not recreate it.`,
      `- Do NOT commit the \`.intent/\` directory — it is temporary.`,
    );
  }

  return lines.join("\n");
}

export interface ProcessResult {
  repo: string;
  status:
    | "pr-created"
    | "no-commits"
    | "skipped-no-clone"
    | "skipped-has-pr"
    | "skipped-no-changes"
    | "error";
  prNumber?: number;
  planTitles?: string[];
}

export async function processRepo(repo: Repo): Promise<ProcessResult> {
  return smartSchedule.withDailyRepoMarking(
    "doc-maintainer",
    repo.fullName,
    () => processRepoInner(repo),
    (err) => {
      reportError("doc-maintainer:process-repo", repo.fullName, err);
      return { repo: repo.fullName, status: "error" as const };
    },
  );
}

async function processRepoInner(repo: Repo): Promise<ProcessResult> {
  const fullName = repo.fullName;

  // Step 0: Skip repos claws isn't working with
  const repoDir = claude.repoDir(repo);
  if (!fs.existsSync(repoDir)) return { repo: fullName, status: "skipped-no-clone" };

  // Step 1: Check for existing open docs PR
  const prs = await gh.listPRs(fullName);
  const hasDocsPR = prs.some((pr) => pr.headRefName.startsWith("claws/docs-"));
  if (hasDocsPR) {
    log.info(`[doc-maintainer] Skipping ${fullName} — open docs PR exists`);
    return { repo: fullName, status: "skipped-has-pr" };
  }

  // Step 2: Check if maintenance is needed
  const branchName = `claws/docs-${claude.datestamp()}-${claude.randomSuffix()}`;

  return await db.withTaskRecording("doc-maintainer", fullName, 0, null, async (taskId) => {
    return await claude.withNewWorktree(repo, branchName, "doc-maintainer", async (wtPath): Promise<ProcessResult> => {
      db.updateTaskWorktree(taskId, wtPath, branchName);

      const headSha = await claude.getHeadSha(wtPath);
      const lastDocSha = await claude.getLastDocMaintainerSha(wtPath);

      const clawsDocFsPath = path.join(wtPath, CLAWS_AUTOMATION_DOC_PATH);
      const existingClawsDoc = fs.existsSync(clawsDocFsPath)
        ? fs.readFileSync(clawsDocFsPath, "utf8")
        : null;
      const clawsDocStale = existingClawsDoc !== CLAWS_AUTOMATION_DOC;

      // How far back the human-intent history walk has reached for this repo. An absent
      // row means it has never started; `complete` means all history has been scanned,
      // `windowExhausted` that it stopped short at the `gh list` fetch window.
      // lastDocSha can't signal this — it is non-null on every repo the job has touched.
      const backfill = db.getIntentBackfillState(fullName);
      const backfillComplete = backfill?.complete === true;
      // Both terminal states stop the backward walk: once the reachable window is
      // consumed, re-fetching the same fixed top-N can never surface anything older.
      const backfillStopped = backfillComplete || backfill?.windowExhausted === true;

      // Exempt the no-changes skip while the backfill is still walking, so the historical
      // walk still advances on dormant repos whose HEAD hasn't moved since the last
      // doc-maintainer commit.
      if (lastDocSha && lastDocSha === headSha && !clawsDocStale && backfillStopped) {
        log.info(`[doc-maintainer] Skipping ${fullName} — no changes since last doc update`);
        db.recordTaskComplete(taskId, { commits: 0 });
        return { repo: fullName, status: "skipped-no-changes" };
      }

      // Step 3: Fetch recently-closed issues with implementation plans
      const sinceDate = lastDocSha
        ? await claude.getCommitDate(wtPath, lastDocSha)
        : new Date(Date.now() - 7 * 24 * 60 * 60 * 1000); // fallback: 7 days

      const closedIssues = await gh.listRecentlyClosedIssues(fullName, sinceDate);

      const MAX_PLANS = 10;
      const MAX_PLAN_LENGTH = 5_000;
      const plans: { number: number; title: string; plan: string }[] = [];
      for (const issue of closedIssues) {
        if (plans.length >= MAX_PLANS) break;
        const comments = await gh.getIssueComments(fullName, issue.number);
        const plan = findPlanComment(comments);
        if (plan) {
          const truncated = plan.length > MAX_PLAN_LENGTH
            ? plan.slice(0, MAX_PLAN_LENGTH) + "\n\n[... truncated]"
            : plan;
          if (plan.length > MAX_PLAN_LENGTH) {
            log.warn(`[doc-maintainer] Truncated plan for issue #${issue.number} (${plan.length} chars)`);
          }
          plans.push({ number: issue.number, title: issue.title, plan: truncated });
        }
      }

      // Write plans to temporary .plans/ directory
      if (plans.length > 0) {
        const plansDir = path.join(wtPath, ".plans");
        fs.mkdirSync(plansDir, { recursive: true });
        for (const p of plans) {
          const guardedTitle = guardContent(p.title, { repo: fullName, source: "issue-title", itemNumber: p.number });
          const content = `# Issue #${p.number}: ${guardedTitle}\n\n${p.plan}`;
          fs.writeFileSync(path.join(plansDir, `${p.number}.md`), content);
        }
        log.info(`[doc-maintainer] Wrote ${plans.length} plan(s) to .plans/ for ${fullName}`);
      }

      // Step 3b: Gather human-authored intent from closed issues and merged PRs.
      // Two windows: a small forward window (new items since the last doc commit) plus,
      // until the backfill completes, one backwards chunk of history per run.
      const BACKFILL_FETCH_LIMIT = 3_000;  // gh list paginates; ~1.2 MB/category for claws, under gh()'s 10 MB maxBuffer
      const BACKFILL_CHUNK_ITEMS = 250;    // items handed to one agent pass
      const FORWARD_FETCH_LIMIT = 100;
      const MAX_FORWARD_ITEMS = 25;
      const MAX_INTENT_CHARS = 2_000;

      let selfLogin = "";
      try {
        selfLogin = await gh.getSelfLogin(repo.owner);
      } catch {
        // bot-suffix filtering only
      }

      type IntentItem = { kind: "Issue" | "PR"; number: number; title: string; body: string; author: string; date: string; headRefName?: string };
      const toIssueItems = (issues: { number: number; title: string; body: string; closedAt: string; author: string }[]): IntentItem[] =>
        issues.map((i) => ({ kind: "Issue" as const, number: i.number, title: i.title, body: i.body, author: i.author, date: i.closedAt.slice(0, 10) }));
      const toPrItems = (prs: { number: number; title: string; body: string; mergedAt: string; author: string; headRefName: string }[]): IntentItem[] =>
        prs.map((p) => ({ kind: "PR" as const, number: p.number, title: p.title, body: p.body, author: p.author, date: p.mergedAt.slice(0, 10), headRefName: p.headRefName }));
      // Sort newest-first before capping so a cap trims the oldest items rather than
      // always excluding a whole category (e.g. all merged PRs).
      const newestFirst = (items: IntentItem[]): IntentItem[] => [...items].sort((a, b) => b.date.localeCompare(a.date));

      // Forward window: closedIssues above already used sinceDate.
      const forwardPRs = await gh.listRecentlyMergedPRs(fullName, sinceDate, FORWARD_FETCH_LIMIT);
      const forwardItems = newestFirst([...toIssueItems(closedIssues), ...toPrItems(forwardPRs)])
        .slice(0, MAX_FORWARD_ITEMS);

      // Backward chunk: walk history in dated chunks, oldest boundary tracked in the DB.
      let backfillChunk: IntentItem[] = [];
      let newOldest: string | null = null;
      let backfillDone = false;
      let newWindowExhausted = false;
      let backfillAdvanced = false;
      if (!backfillStopped) {
        try {
          const [allIssues, allPRs] = await Promise.all([
            gh.listRecentlyClosedIssues(fullName, null, BACKFILL_FETCH_LIMIT),
            gh.listRecentlyMergedPRs(fullName, null, BACKFILL_FETCH_LIMIT),
          ]);
          const boundary = backfill?.oldestScanned ?? null;
          // Strictly `<`: the watermark is a whole date and the chunk below always
          // consumes every item sharing its oldest date, so nothing dated `boundary`
          // is still outstanding.
          const older = newestFirst([...toIssueItems(allIssues), ...toPrItems(allPRs)])
            .filter((i) => !boundary || i.date < boundary);
          // Never split a date across chunks. `date` is day-granular and the watermark
          // filter is strict, so items left over past a mid-date cut would be excluded
          // forever on the next run. Extend the cut to cover the whole cutoff date even
          // if that pushes the chunk past BACKFILL_CHUNK_ITEMS.
          let cut = Math.min(BACKFILL_CHUNK_ITEMS, older.length);
          if (cut > 0 && cut < older.length) {
            const cutoffDate = older[cut - 1].date;
            while (cut < older.length && older[cut].date === cutoffDate) cut++;
          }
          backfillChunk = older.slice(0, cut);
          newOldest = backfillChunk.reduce<string | null>(
            (min, i) => (min === null || i.date < min ? i.date : min),
            null,
          );
          // `gh list` returns a fixed top-N window, not all history. If either fetch came
          // back at the limit, running out of `older` items means the WINDOW is exhausted,
          // not the history — latching `complete` there would claim a full-history walk
          // that never happened. Record the distinct `windowExhausted` terminal state
          // instead: the walk stops (re-fetching can never reach further back) but the
          // DB and the log make clear it stopped short.
          const fetchTruncated = allIssues.length >= BACKFILL_FETCH_LIMIT || allPRs.length >= BACKFILL_FETCH_LIMIT;
          const consumedEverythingReachable = backfillChunk.length >= older.length;
          backfillDone = consumedEverythingReachable && !fetchTruncated;
          newWindowExhausted = consumedEverythingReachable && fetchTruncated;
          backfillAdvanced = true;
          if (newWindowExhausted) {
            log.warn(`[doc-maintainer] ${fullName}: intent backfill hit the ${BACKFILL_FETCH_LIMIT}-item fetch window (issues=${allIssues.length}, PRs=${allPRs.length}) — history older than the window is unreachable via \`gh list\`, so the walk stops here WITHOUT covering full history. Raise BACKFILL_FETCH_LIMIT (or paginate) and clear \`window_exhausted\` in doc_intent_backfill to resume.`);
          }
          const stopReason = backfillDone ? " (history exhausted)" : newWindowExhausted ? " (fetch window exhausted)" : "";
          log.info(`[doc-maintainer] ${fullName}: intent backfill chunk — ${backfillChunk.length} item(s) back to ${newOldest ?? "n/a"}${stopReason}`);
        } catch (err) {
          log.warn(`[doc-maintainer] ${fullName}: intent backfill chunk fetch failed, watermark unchanged: ${err}`);
        }
      }

      // A forward item can also appear in the backward set on the first chunk.
      const seenIntentKeys = new Set<string>();
      const intentItems: IntentItem[] = [];
      for (const item of [...forwardItems, ...backfillChunk]) {
        const key = `${item.kind}#${item.number}`;
        if (seenIntentKeys.has(key)) continue;
        seenIntentKeys.add(key);
        intentItems.push(item);
      }

      const intentDir = path.join(wtPath, ".intent");
      const truncateIntent = (s: string) => s.length > MAX_INTENT_CHARS ? s.slice(0, MAX_INTENT_CHARS) + "\n\n[... truncated]" : s;

      const INTENT_FETCH_CONCURRENCY = 6;
      // Count what each machine-body rule drops — a false positive is otherwise invisible,
      // and the bracket-title rule in particular can't tell `[claws-error] ...` from a
      // human `[Bug] ...`.
      const machineBodySuppressed: Record<MachineBodyReason, number> = {
        "bracket-title": 0,
        "claws-marker": 0,
        "claws-branch": 0,
      };
      const intentFileResults = await mapSettledWithConcurrency(intentItems, INTENT_FETCH_CONCURRENCY, async (item) => {
        const comments = await gh.getIssueComments(fullName, item.number);
        const sections: string[] = [];

        // The machine check applies to the BODY only — human comments on machine-filed
        // alert issues are often where real requirements live.
        const machineReason = isHumanLogin(item.author, selfLogin) && item.body.trim()
          ? machineAuthoredBodyReason(item)
          : null;
        if (machineReason) machineBodySuppressed[machineReason]++;
        if (isHumanLogin(item.author, selfLogin) && !machineReason && item.body.trim()) {
          const guarded = guardContent(truncateIntent(item.body), { repo: fullName, source: "intent-body", itemNumber: item.number });
          sections.push(`**Opened by @${item.author}:**\n${guarded}`);
        }

        const humanComments = comments.filter(
          (c) => isHumanLogin(c.login, selfLogin) && !gh.isClawsComment(c.body) && c.body.trim(),
        );
        if (humanComments.length > 0) {
          const bullets = humanComments.map((c) => {
            const g = guardContent(truncateIntent(c.body), { repo: fullName, source: "intent-comment", itemNumber: item.number });
            return `- @${c.login}: ${g}`;
          });
          sections.push(`**Human comments:**\n${bullets.join("\n")}`);
        }

        if (sections.length === 0) return null;

        const guardedTitle = guardContent(item.title, { repo: fullName, source: "intent-title", itemNumber: item.number });
        const verb = item.kind === "Issue" ? "closed" : "merged";
        const file = `${item.kind === "Issue" ? "issue" : "pr"}-${item.number}.md`;
        const content = `## ${item.kind} #${item.number}: ${guardedTitle} (${verb} ${item.date})\n\n${sections.join("\n\n")}\n`;
        return { file, content };
      });

      let intentCount = 0;
      for (const result of intentFileResults) {
        if (result.status === "rejected") {
          log.warn(`[doc-maintainer] Failed to fetch intent for an item in ${fullName}: ${result.reason}`);
          continue;
        }
        if (!result.value) continue;
        if (intentCount === 0) fs.mkdirSync(intentDir, { recursive: true });
        fs.writeFileSync(path.join(intentDir, result.value.file), result.value.content);
        intentCount++;
      }
      if (intentCount > 0) {
        log.info(`[doc-maintainer] Wrote human-intent for ${intentCount} item(s) to .intent/ for ${fullName}${backfillComplete ? "" : " (includes history backfill chunk)"}`);
      }
      const suppressedByRule = (Object.entries(machineBodySuppressed) as [MachineBodyReason, number][])
        .filter(([, count]) => count > 0)
        .map(([reason, count]) => `${reason}=${count}`);
      if (suppressedByRule.length > 0) {
        log.info(`[doc-maintainer] ${fullName}: suppressed ${suppressedByRule.join(", ")} body/bodies as machine-authored; human comments on them were still captured. The bracket-title rule can't tell \`[claws-error] ...\` from a human \`[Bug] ...\`, so its count may include false positives.`);
      }

      // Step 4: Generate/update documentation
      log.info(`[doc-maintainer] Generating docs for ${fullName}`);
      const prompt = buildDocPrompt(fullName, plans.length, intentCount);
      const model = getModel("sonnet", "tool-use", "claude");
      db.updateTaskModel(taskId, model);
      let actualProvider: Provider = "claude";
      await claude.runClaude(prompt, wtPath, { capability: "tool-use", tier: "sonnet", model, onProviderUsed: (p) => { actualProvider = p; }, onTokensUsed: db.trackTaskTokens(taskId) });

      // Advance the watermark only now that the agent pass has returned, so a crash or
      // timeout re-does this chunk rather than skipping it.
      if (backfillAdvanced) {
        db.recordIntentBackfillChunk(fullName, newOldest ?? backfill?.oldestScanned ?? null, backfillDone, newWindowExhausted);
      }

      // Clean up temporary plans directory (must not be committed)
      const plansDir = path.join(wtPath, ".plans");
      if (fs.existsSync(plansDir)) {
        fs.rmSync(plansDir, { recursive: true });
        try {
          await claude.git(["rm", "-rf", "--cached", ".plans"], wtPath);
        } catch {
          // Not staged, that's fine
        }
      }

      // Clean up temporary intent directory (must not be committed; the doc edits the
      // agent made from it are what persists)
      if (fs.existsSync(intentDir)) {
        fs.rmSync(intentDir, { recursive: true });
        try {
          await claude.git(["rm", "-rf", "--cached", ".intent"], wtPath);
        } catch {
          // Not staged, that's fine
        }
      }

      // Sync the canonical Claws automation doc deterministically (Claude must not own its content).
      fs.mkdirSync(path.dirname(clawsDocFsPath), { recursive: true });
      fs.writeFileSync(clawsDocFsPath, CLAWS_AUTOMATION_DOC);
      await claude.git(["add", CLAWS_AUTOMATION_DOC_PATH], wtPath);
      const stagedClawsDoc = await claude.git(["diff", "--cached", "--name-only", "--", CLAWS_AUTOMATION_DOC_PATH], wtPath);
      if (stagedClawsDoc.trim()) {
        await claude.git(["commit", "-m", "docs: sync Claws automation guide [doc-maintainer]"], wtPath);
      }

      // Step 5: Push and create PR
      if (await claude.hasNewCommits(wtPath, repo.defaultBranch)) {
        const attribution = `*— Docs generated with: ${model} (provider: ${actualProvider}) —*`;
        const description = await claude.generateDocsPRDescription(wtPath, repo.defaultBranch, attribution);
        await claude.pushBranch(wtPath, branchName, repo.owner);
        const prNumber = await gh.createPR(
          fullName,
          branchName,
          `docs: update documentation for ${repo.name}`,
          description,
        );
        log.info(`[doc-maintainer] Created docs PR #${prNumber} for ${fullName}`);
        db.recordTaskComplete(taskId, await buildSuccessOutcome(wtPath, repo.defaultBranch, prNumber, "created"));
        return { repo: fullName, status: "pr-created", prNumber, planTitles: plans.map((p) => p.title) };
      } else {
        log.warn(`[doc-maintainer] No commits produced for ${fullName}`);
        db.recordTaskComplete(taskId, { commits: 0 });
        return { repo: fullName, status: "no-commits", planTitles: plans.map((p) => p.title) };
      }
    });
  });
}

export function postSummary(results: ProcessResult[]): void {
  const created = results.filter((r) => r.status === "pr-created");
  const noCommits = results.filter((r) => r.status === "no-commits");
  const noChanges = results.filter((r) => r.status === "skipped-no-changes");
  const hasPr = results.filter((r) => r.status === "skipped-has-pr");
  const errors = results.filter((r) => r.status === "error");

  if (created.length === 0 && errors.length === 0 && noCommits.length === 0) {
    return;
  }

  const s = (n: number) => (n === 1 ? "" : "s");
  const attempted = results.filter((r) => r.status !== "skipped-no-clone");
  const lines: string[] = [
    `📚 Doc maintainer: ${created.length} PR${s(created.length)} opened across ${attempted.length} repo${s(attempted.length)}`,
  ];

  for (const r of created) {
    const featurePart =
      r.planTitles && r.planTitles.length > 0
        ? ` — features: ${r.planTitles.join("; ")}`
        : " — no recent feature plans";
    lines.push(`• ${r.repo} #${r.prNumber}${featurePart}`);
  }

  if (noCommits.length > 0) {
    lines.push(`• No-op (Claude produced no commits): ${noCommits.map((r) => r.repo).join(", ")}`);
  }
  if (hasPr.length > 0) {
    lines.push(`• Skipped (open docs PR): ${hasPr.map((r) => r.repo).join(", ")}`);
  }
  if (noChanges.length > 0) {
    lines.push(`• Skipped (no code changes since last doc update): ${noChanges.map((r) => r.repo).join(", ")}`);
  }
  if (errors.length > 0) {
    lines.push(`• Errors: ${errors.map((r) => r.repo).join(", ")}`);
  }

  notify(lines.join("\n"));
}
