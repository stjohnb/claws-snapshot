import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import * as gh from "../github.js";
import * as claude from "../claude.js";
import * as db from "../db.js";
import { PUBLIC_SNAPSHOTS, SELF_REPO, WORK_DIR } from "../config.js";
import { ensureAlertIssue } from "../occurrence-tracking.js";
import { buildEnvForGh, getInstallationTokenForOwner } from "../github-app.js";
import { retryWithBackoff } from "../retry.js";
import * as log from "../log.js";

/**
 * Daily public-snapshot sync (#1826, #2106). For each configured `source → target`
 * pair it rebuilds the PUBLIC target repo from the PRIVATE source: scrubs
 * development-process artefacts, rewrites the README for a public audience
 * (#1848), fail-closed secret-scans, disables Dependabot, and pushes exactly
 * one new commit whose subject and body describe the changes ported across. The
 * private source path is NEVER named in committed text (#2362) — not in the
 * subject, not in the LLM-written body. It NEVER un-archives a target — an
 * archived or missing target files a single updating alert issue on SELF_REPO
 * and skips that pair.
 *
 * Registered in main.ts, so the dashboard renders a Run button for it — that is
 * the manual "sync now" trigger. Idempotent via the stored source SHA, so a
 * manual run with no new source commits is a fast no-op.
 *
 * Source-accurate release anchoring (#1941). For `mirrorReleases` pairs, each new
 * stable source release tag gets its OWN snapshot commit whose tree is
 * `git archive <tag-sha>` (scrubbed), and the public release is anchored at that
 * commit instead of target HEAD — so the public tag's tree exactly matches the
 * private source at that tag. Its subject is `Release <tag>` (#2362). A single sync
 * can therefore produce several commits:
 * one per pending release tag (oldest first), then the regular HEAD snapshot commit.
 * All commits are built locally and pushed once, so a secret-scan hit on ANY tree
 * aborts the whole run with nothing on the remote (no partial history). Decisions:
 *   - Pre-existing public releases (e.g. `v1.3.1`, anchored at an old snapshot HEAD)
 *     are LEFT ALONE — recorded as `"preexisting"` in `publishedReleases` and never
 *     re-anchored. Only future releases get source-accurate anchoring.
 *   - Backfill of `v1.3.0` and earlier is explicitly NOT done.
 *   - Intermediate release commits keep the verbatim source README (no per-tag LLM
 *     call); README tailoring runs only on the HEAD commit (or on a release commit
 *     that happens to equal HEAD). If the source provides `README.public.md`,
 *     `rebuildTargetTree()` renames it over `README.md` on EVERY commit (release tags
 *     included) and LLM tailoring is skipped entirely for that commit (#1948).
 * Non-`mirrorReleases` pairs keep the single-commit behaviour unchanged and never
 * consult the release-tag machinery. `.claws-snapshot.json` records `sourceSha` and,
 * for release pairs, a `publishedReleases` map of tag → public commit SHA.
 *
 * Per-pair scrub paths (#1962). A pair may declare `scrubPaths` in config to remove
 * repo-specific sensitive paths in addition to the global `SCRUB_PATHS` below (e.g.
 * `fleet-infra` scrubs a configmap holding personal data). Scrubbing only HEAD is not
 * enough — the path can already exist in the target's published git history from an
 * earlier sync — so a `scrubPaths` pair publishes a squashed **single root commit**,
 * force-pushed, on every sync: nothing scrubbed can survive in an ancestor commit.
 * Mutually exclusive with `mirrorReleases` (enforced in `src/config.ts`), because
 * `mirrorReleases` anchors public releases at specific snapshot SHAs that a rewritten
 * history would orphan.
 *
 * One-shot history cleanup (#2362). Older syncs baked the private source path into every
 * committed subject, so every run checks whether the target's PUBLISHED messages still
 * mention the source; a hit bypasses the idempotency gate for that pair even when the
 * source hasn't advanced. `scrubPaths` pairs self-heal, because bypassing the gate already
 * republishes their whole history as one squashed root commit. Other pairs get a
 * `git filter-branch --msg-filter` pass over all branches and tags (trees, authors and
 * dates untouched), then a force-push of the branch AND the tags. The check is
 * self-clearing — once no message names the source it never fires again — and both
 * detection and rewriting are case-sensitive, so they converge on the same fixed point.
 *
 * S3 DMG fallback (#2115, narrowed #2813). The mirror uploads EVERY asset attached to
 * the source release (`gh release download --pattern '*'`), not just `.dmg` files.
 * TempoStatusBar's macOS release workflow stopped attaching the notarized DMG to the
 * source GitHub Release (org storage/bandwidth quota) and now uploads it to a
 * public-read S3 prefix instead; a pair's `releaseAssetUrl` config field carries an
 * HTTPS URL template that `downloadReleaseAssetsForTag` falls back to fetching when
 * the source release carries no `.dmg`. That fallback applies ONLY to tags on the
 * semver `v1.2.3` mac release line the template was written for — TempoStatusBar also
 * ships a separate `linux-v*` tag line whose Rust tray-app assets (a `.tar.gz` +
 * `.sha256`) live on the GitHub Release itself, and substituting a `linux-v*` tag into
 * the mac-shaped S3 template yields a bucket key that does not exist (#2813).
 *
 * Credential-bearing webhook URLs (#2445). A wake-page webhook URL committed in
 * fleet-infra's `apps/truenas-gate/configmap.yaml` reached the public `homelab` mirror
 * because no `SECRET_PATTERNS` entry matched a credential-bearing webhook URL — the
 * `ha-webhook-url` and `slack-webhook-url` patterns close that gap. Because that pair
 * declares `scrubPaths`, the squashed-root-commit force-push already removed the value
 * from published history automatically once the source was fixed; the patterns exist so
 * the next occurrence is caught before it ever reaches a public tree.
 *
 * Modern AI-provider key formats (#2550). `generic-sk` only matches a run of 20+
 * *alphanumeric* characters right after `sk-`, so it only ever covered the legacy
 * `sk-<48 alnum>` OpenAI shape — every current format (`sk-ant-api03-…`,
 * `sk-ant-oat01-…`, `sk-proj-…`, `sk-or-v1-…`) has a hyphenated vendor prefix within
 * the first few characters and slipped through. `sk-ant-oat01-…` is the OAuth token
 * format Claws itself mints and persists (`src/claude-auth.ts`), making it the most
 * likely of the four to land in a tracked config/env/doc file. The new patterns are
 * anchored on the vendor prefix rather than loosening `generic-sk`'s character class
 * to allow hyphens: a loosened class matches ordinary prose (`risk-management-
 * framework-…`), and because this scan is fail-closed, a false positive aborts the
 * sync just as hard as a real hit.
 */

/** Paths removed from the target tree before publishing (development-process artefacts). */
const SCRUB_PATHS = [
  ".claude",
  ".plans",
  "ideas",
  ".mcp-claws.json",
  "docs/claws-automation.md",
  ".github/dependabot.yml",
  ".github/dependabot.yaml",
  "BLOG_IDEAS.md",
  "HOMELAB_IDEAS.md",
];

/**
 * Chunk size for the secret scan. Files at or under this size are read whole;
 * larger files are read in successive chunks of this size reusing one buffer, so
 * peak memory is bounded by this constant regardless of file size (#2599). The
 * old behaviour — skipping oversized files outright — published any file over
 * 2 MB with zero scanning, and a checked-in dump, log/HAR capture or bundled
 * artifact can carry a real key. Source repos include large binary mesh/texture
 * assets (e.g. St-John-Software/3d-models); this scan is synchronous, so binary
 * files stop after the first chunk (see scanOversizedFileForSecrets).
 */
const MAX_SCAN_BYTES = 2 * 1024 * 1024;

/** Per-file ceiling on bytes read by the chunked scan — guards against a pathological multi-GB text file (#2599). */
const MAX_TOTAL_SCAN_BYTES = 64 * 1024 * 1024;

/** Bytes of the previous chunk re-prepended to the next, so a secret straddling a chunk boundary still matches (#2599). Comfortably longer than the longest SECRET_PATTERNS match. */
const SCAN_OVERLAP_BYTES = 256;

/** Local branch name used to build the squashed root commit for a `scrubPaths` pair (#1962). */
const REWRITE_BRANCH = "claws-snapshot-rewrite";

/** Timeout for the S3 DMG fallback fetch (#2115) — notarized DMGs are tens of MB over public S3. */
const DMG_FETCH_TIMEOUT_MS = 300_000;

/** Guardrail against an unexpectedly huge response on the S3 DMG fallback fetch (#2115). */
const MAX_DMG_BYTES = 500 * 1024 * 1024;

/** Fail-closed secret patterns. On any match the sync aborts and never pushes. */
const SECRET_PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: "private-key", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: "github-token", re: /gh[pousr]_[A-Za-z0-9]{36,}/ },
  { name: "github-fine-grained-token", re: /github_pat_[A-Za-z0-9_]{20,}/ },
  { name: "aws-access-key", re: /AKIA[0-9A-Z]{16}/ },
  { name: "slack-token", re: /xox[baprs]-[A-Za-z0-9-]{10,}/ },
  { name: "generic-sk", re: /sk-[A-Za-z0-9]{20,}/ },
  { name: "anthropic-key", re: /sk-ant-(api|oat)\d{2}-[A-Za-z0-9_-]{20,}/ },
  { name: "openai-project-key", re: /sk-proj-[A-Za-z0-9_-]{20,}/ },
  { name: "openrouter-key", re: /sk-or-v1-[A-Za-z0-9]{20,}/ },
  { name: "ha-webhook-url", re: /\/api\/webhook\/[A-Za-z0-9_-]{16,}/ },
  { name: "slack-webhook-url", re: /hooks\.slack\.com\/services\/T[A-Za-z0-9]{6,}\/B[A-Za-z0-9]{6,}\/[A-Za-z0-9]{20,}/ },
];

/**
 * Known-safe secret-scan matches: documentation placeholders, not real secrets.
 * `docs/home-assistant.md` shows a `-----BEGIN OPENSSH PRIVATE KEY-----` template
 * wrapping the placeholder `<contents of ~/.ssh/ha_git_pull>` (#1833). This module
 * and its test also quote that placeholder template — in a doc comment and in test
 * fixtures respectively — so they self-flag when the `claws` repo is snapshotted
 * (#1836). `docs/OVERVIEW.md` also self-flags because its module description quotes
 * the same `-----BEGIN OPENSSH PRIVATE KEY-----` template. The job's own doc
 * `docs/jobs/public-snapshot-sync.md` also self-flags because its 'Secret scan'
 * section quotes the same template. Matched by exact repo-relative path + pattern
 * name so a real key elsewhere is still caught. The test file also carries
 * synthetic webhook-URL fixtures for the `ha-webhook-url` and `slack-webhook-url`
 * patterns (#2445), allowlisted by the same exact path + pattern name scheme.
 */
const SCAN_ALLOWLIST: ReadonlyArray<{ path: string; name: string }> = [
  { path: "docs/OVERVIEW.md", name: "private-key" },
  { path: "docs/home-assistant.md", name: "private-key" },
  { path: "docs/jobs/public-snapshot-sync.md", name: "private-key" },
  { path: "src/jobs/public-snapshot-sync.ts", name: "private-key" },
  { path: "src/jobs/public-snapshot-sync.test.ts", name: "private-key" },
  { path: "src/jobs/public-snapshot-sync.test.ts", name: "ha-webhook-url" },
  { path: "src/jobs/public-snapshot-sync.test.ts", name: "slack-webhook-url" },
];

/** Instruction prefix for rewriting a source README into a public-audience one (#1848). */
const PUBLIC_README_PROMPT =
  "You are rewriting the README of a PUBLIC snapshot repository. This repo is an " +
  "automatically-published mirror of a PRIVATE source repo owned by an individual; " +
  "it is shared to show how the project works, not as a turnkey product.\n\n" +
  "Rewrite the README below for a public reader who has NO access to the private source:\n" +
  "- Add a short opening note (1–2 sentences) that this is a public snapshot of a personal, " +
  "self-hosted project and may reference the author's own infrastructure.\n" +
  "- Remove or fix any instruction that only works with private access — e.g. commands that " +
  "fetch files from the private source repo (a public reader gets a 404), or that assume the " +
  "author's own host. Prefer build-from-source steps that work from a clone of THIS repo.\n" +
  "- Keep all technically-accurate content (architecture, config tables, auth setup). Do NOT " +
  "invent features, files, or commands that are not in the original.\n" +
  "- Do NOT add links to files that a snapshot would omit (e.g. `.claude/`, `.plans/`, `ideas/`, " +
  "internal automation docs). Keep links only to files the reader can plausibly see.\n" +
  "- Do NOT include any credential, token, or private key, even as an example.\n" +
  "Output ONLY the rewritten Markdown — no preamble, no explanation, no surrounding code fence.\n\n" +
  "--- CURRENT README ---\n";

/** Commit subject when no usable LLM subject is available (#2362). */
const DEFAULT_SUBJECT = "Update snapshot";

/** Commit subject for a full resync — first sync, or source history rewritten (#2362). */
const RESYNC_SUBJECT = "Resync snapshot with the latest source state";

/** Neutral replacement for any private source-repo mention in commit text (#2362). */
const SOURCE_PLACEHOLDER = "the source repository";

/**
 * Instruction prefix for the commit message describing what was ported across (#2362).
 * Must NOT contain the phrases the tests use to route `runClaude` to the README prompt.
 */
const COMMIT_MESSAGE_PROMPT =
  "Write a git commit message describing the changes below.\n" +
  "Line 1: a concise imperative subject (max 70 chars) describing the changes overall.\n" +
  "Then a blank line, then 3-8 markdown bullets of user-facing features/changes.\n" +
  "Do NOT mention any repository name, owner, organisation, URL, issue or PR number, " +
  "or the fact that this is a mirror. Output only the commit message, no preamble.\n\n";

function execFileAsync(
  cmd: string, args: string[], opts: { env?: NodeJS.ProcessEnv; cwd?: string } = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 32 * 1024 * 1024, ...opts }, (err, stdout, stderr) => {
      if (err) reject(new Error(`${cmd} ${args.join(" ")} failed: ${stderr || err.message}`));
      else resolve(stdout);
    });
  });
}

/** Recursively list every regular file under `dir`, skipping `.git`. */
function walkFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === ".git") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkFiles(full));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

/**
 * Publish workflows (#1835) but disabled: replace each workflow's top-level `on:`
 * trigger block with a `workflow_dispatch:`-only placeholder so nothing fires on
 * the public snapshot. Pure text edit — never round-trips through a YAML parser
 * (that would reflow the file and, under YAML 1.1, coerce the `on` key to `true`).
 */
function disableWorkflowTriggers(tgtDir: string): void {
  const wfDir = path.join(tgtDir, ".github", "workflows");
  if (!fs.existsSync(wfDir)) return;
  for (const entry of fs.readdirSync(wfDir, { withFileTypes: true })) {
    if (!entry.isFile() || !/\.ya?ml$/.test(entry.name)) continue;
    const full = path.join(wfDir, entry.name);
    const lines = fs.readFileSync(full, "utf-8").split("\n");
    // Top-level `on` key only (column 0); accepts `on:`, `"on":`, `'on':`.
    const onIdx = lines.findIndex((l) => /^(on|["']on["'])\s*:/.test(l));
    if (onIdx === -1) continue; // no explicit trigger block — leave file as-is
    // Block ends at the next column-0, non-blank line (the next top-level key).
    let endIdx = lines.length;
    for (let i = onIdx + 1; i < lines.length; i++) {
      if (lines[i].trim() === "") continue; // blank lines belong to the block
      if (/^\s/.test(lines[i])) continue;   // indented → still inside `on:`
      endIdx = i;
      break;
    }
    const replacement = [
      "# Triggers removed for the public snapshot — this workflow is intentionally disabled.",
      "# See the private source repository for the active version.",
      "on:",
      "  workflow_dispatch:",
    ];
    fs.writeFileSync(
      full,
      [...lines.slice(0, onIdx), ...replacement, ...lines.slice(endIdx)].join("\n"),
    );
  }
}

/**
 * Tailor the published README for a public audience (#1848). The private source
 * README is written for the author's own ops; a public reader has no access to
 * the private repo, so instructions that fetch from it 404. Rewrite it with a
 * text-only Claude call. Best-effort: on any failure, leave the verbatim source
 * README in place (already extracted by `git archive`) rather than abort the sync.
 * The rewritten file is scanned by the fail-closed secret scan that runs after
 * this step, so a token-shaped LLM output still aborts the push.
 */
async function tailorPublicReadme(
  tgtDir: string,
  srcDir: string,
  source: string,
  onTokensUsed: (tokensUsed: number, costUsd: number, provider?: string) => void,
): Promise<void> {
  const readmePath = path.join(tgtDir, "README.md");
  if (!fs.existsSync(readmePath)) return;
  let original: string;
  try {
    original = fs.readFileSync(readmePath, "utf-8");
  } catch {
    return;
  }
  if (!original.trim()) return;
  let rewritten: string;
  try {
    rewritten = (
      await claude.runClaude(PUBLIC_README_PROMPT + original, srcDir, {
        tier: "sonnet",
        provider: "claude",
        onTokensUsed,
      })
    ).trim();
  } catch (err) {
    log.warn(
      `[public-snapshot-sync] README tailoring failed for ${source}; publishing source README verbatim: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return;
  }
  if (!rewritten) {
    log.warn(`[public-snapshot-sync] README tailoring returned empty for ${source}; publishing source README verbatim`);
    return;
  }
  // Defensively strip a whole-document ```markdown fence if the model wraps its output.
  const fence = rewritten.match(/^```[a-zA-Z]*\n([\s\S]*?)\n```$/);
  if (fence) rewritten = fence[1].trim();
  try {
    fs.writeFileSync(readmePath, rewritten.endsWith("\n") ? rewritten : rewritten + "\n");
  } catch (err) {
    log.warn(
      `[public-snapshot-sync] writing tailored README failed for ${source}; publishing source README verbatim: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

/**
 * True when `tag` belongs to the macOS `v1.2.3` release line the `releaseAssetUrl` S3
 * template was written for (#2813). TempoStatusBar also ships a separate Linux line
 * tagged `linux-v0.3.0`, whose assets live on the GitHub Release itself; substituting
 * that tag into the template yields a bucket key that does not exist, and S3 answers
 * 403 (not 404) for a missing object in a bucket without public ListBucket.
 */
function tagUsesAssetUrlTemplate(tag: string): boolean {
  return /^v?\d+\.\d+\.\d+/.test(tag);
}

/**
 * Fetch a release DMG over plain HTTPS into `dlDir` (#2115). TempoStatusBar's release
 * workflow stopped attaching the DMG to the GitHub Release (org storage/bandwidth quota)
 * and now uploads it to a public-read S3 prefix, so the mirror fetches it directly.
 * `template` is the pair's `releaseAssetUrl` with `{version}` = tag minus a leading `v`
 * (and `{tag}` = the raw tag). Returns the written file path.
 */
async function downloadDmgFromUrl(template: string, tag: string, dlDir: string): Promise<string> {
  const url = template
    .replaceAll("{version}", tag.replace(/^v/, ""))
    .replaceAll("{tag}", tag);
  const name = path.basename(new URL(url).pathname);
  if (!name.toLowerCase().endsWith(".dmg")) {
    throw new Error(`releaseAssetUrl does not resolve to a .dmg: ${url}`);
  }
  const buf = await retryWithBackoff(
    async () => {
      const res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(DMG_FETCH_TIMEOUT_MS) });
      if (!res.ok) throw new Error(`GET ${url} → HTTP ${res.status}`);
      const b = Buffer.from(await res.arrayBuffer());
      if (b.length === 0) throw new Error(`GET ${url} → empty body`);
      if (b.length > MAX_DMG_BYTES) throw new Error(`GET ${url} → ${b.length} bytes exceeds ${MAX_DMG_BYTES}`);
      return b;
    },
    3,
    (err) => !/HTTP 4\d\d/.test(err.message), // 404 = asset genuinely absent, don't burn retries
    "[public-snapshot-sync] dmg fetch",
  );
  const dest = path.join(dlDir, name);
  fs.writeFileSync(dest, buf);
  return dest;
}

/**
 * Clear/recreate the per-owner download dir, fetch every release asset for `tag` from
 * `source`, and return the absolute paths of the downloaded files. Falls back to
 * fetching `releaseAssetUrl` over HTTPS (#2115) when the source release carries no
 * `.dmg` asset AND `tag` is on the semver mac release line the template was written
 * for (#2813) — TempoStatusBar's separate `linux-v*` line ships its assets directly on
 * the GitHub Release, never via the S3 template. Throws if there is no asset and no
 * `releaseAssetUrl` fallback. Shared by mirrorLatestRelease (#1851) and
 * publishReleaseForTag (#1941).
 */
async function downloadReleaseAssetsForTag(
  source: string, tag: string, targetOwner: string, releaseAssetUrl?: string,
): Promise<string[]> {
  const dlDir = path.join(WORK_DIR, "snapshots", "release-assets", targetOwner);
  await execFileAsync("rm", ["-rf", dlDir]);
  fs.mkdirSync(dlDir, { recursive: true });
  try {
    await gh.downloadReleaseAssets(source, tag, "*", dlDir);
  } catch (err) {
    log.warn(
      `[public-snapshot-sync] no downloadable asset on ${source} ${tag} (${
        err instanceof Error ? err.message : String(err)
      }) — will try releaseAssetUrl`,
    );
  }
  const assets = fs.readdirSync(dlDir).map((n) => path.join(dlDir, n)).sort();
  if (
    releaseAssetUrl &&
    tagUsesAssetUrlTemplate(tag) &&
    !assets.some((a) => a.toLowerCase().endsWith(".dmg"))
  ) {
    assets.push(await downloadDmgFromUrl(releaseAssetUrl, tag, dlDir));
  }
  if (assets.length === 0) {
    throw new Error(`no release asset found on ${source} release ${tag}`);
  }
  return assets;
}

/**
 * Mirror the latest STABLE release DMG from `source` to `target` (#1851). Most-recent
 * only, idempotent: if the target already has that tag with a `.dmg` asset, no-op.
 * Anchors the target tag at the current target HEAD (the repos share no git history,
 * so the private SHA does not exist publicly). Must be called AFTER the source sync has
 * pushed, so target HEAD is the freshly-published snapshot. Files a single alert on any
 * failure instead of throwing.
 */
async function mirrorLatestRelease(
  source: string, target: string, tgtDir: string, targetOwner: string, releaseAssetUrl?: string,
): Promise<void> {
  try {
    const tag = await gh.getLatestStableReleaseTag(source);
    if (!tag) return; // no stable release yet

    const existing = await gh.getReleaseAssetNames(target, tag);
    // Any asset on the public release means this tag is already mirrored — a Linux-line
    // release (#2813) carries a .tar.gz, never a .dmg.
    if (existing !== null && existing.length > 0) return;

    const assets = await downloadReleaseAssetsForTag(source, tag, targetOwner, releaseAssetUrl);

    const headSha = (await claude.git(["rev-parse", "HEAD"], tgtDir, { owner: targetOwner })).trim();
    if (existing === null) {
      await gh.createRelease(target, tag, assets, headSha, tag);
    } else {
      await gh.uploadReleaseAssets(target, tag, assets); // release exists but lacked any asset
    }
    log.info(`[public-snapshot-sync] mirrored release ${tag} → ${target}`);
  } catch (err) {
    await ensureAlertIssue({
      repo: SELF_REPO,
      title: `[snapshot] Release mirror failed for ${target}`,
      body:
        `Mirroring the latest stable release from \`${source}\` to \`${target}\` failed:\n\n` +
        `\`\`\`\n${err instanceof Error ? err.message : String(err)}\n\`\`\`\n\n` +
        "The source sync itself succeeded; only the release-asset mirror step failed. It will retry next run.",
      logPrefix: "public-snapshot-sync",
    });
  }
}

/**
 * Rebuild the target working tree from the SOURCE at `archiveRef` (a commit SHA or
 * tag SHA). Clears the tree (except `.git`), extracts `git archive <archiveRef>`
 * (tracked files only, so untracked build artefacts — node_modules, dist, .env,
 * coverage — can never leak into the PUBLIC snapshot, #1833), scrubs
 * development-process artefacts, and disables workflow triggers (#1835). If the
 * source ships `README.public.md`, renames it over `README.md` and returns `true`
 * so the caller skips `tailorPublicReadme()` for this commit (#1948). Otherwise
 * does NOT tailor the README and does NOT secret-scan — callers decide both. (#1941)
 */
async function rebuildTargetTree(
  tgtDir: string, srcDir: string, archiveRef: string, srcOwner: string, extraScrubPaths: readonly string[] = [],
): Promise<boolean> {
  await execFileAsync("find", [tgtDir, "-mindepth", "1", "-maxdepth", "1", "!", "-name", ".git", "-exec", "rm", "-rf", "{}", "+"]);
  const archivePath = path.join(
    WORK_DIR, "snapshots", `${path.basename(path.dirname(tgtDir))}-${path.basename(tgtDir)}.tar`,
  );
  await claude.git(["archive", "--format=tar", "--output", archivePath, archiveRef], srcDir, { owner: srcOwner });
  await execFileAsync("tar", ["-xf", archivePath, "-C", tgtDir]);
  await execFileAsync("rm", ["-f", archivePath]);

  // Scrub development-process artefacts, plus any pair-specific paths from config.
  for (const p of [...SCRUB_PATHS, ...extraScrubPaths]) {
    const full = path.resolve(tgtDir, p);
    if (!full.startsWith(path.resolve(tgtDir) + path.sep)) {
      log.warn(`[public-snapshot-sync] skipping unsafe scrub path ${p}`);
      continue;
    }
    if (fs.existsSync(full)) await execFileAsync("rm", ["-rf", full]);
  }

  // Publish workflows but disabled — strip every trigger (#1835).
  disableWorkflowTriggers(tgtDir);

  // Author-controlled public README (#1948): if the source ships a
  // README.public.md, RENAME it over README.md so the variant file never
  // appears in the published tree (nothing to add to SCRUB_PATHS). Signal the
  // swap so the caller skips the LLM README tailoring for this commit.
  const variantReadme = path.join(tgtDir, "README.public.md");
  let swappedReadme = false;
  if (fs.existsSync(variantReadme)) {
    fs.renameSync(variantReadme, path.join(tgtDir, "README.md"));
    swappedReadme = true;
  }

  return swappedReadme;
}

/**
 * Chunked secret scan of a file larger than MAX_SCAN_BYTES (#2599). Reads at most
 * MAX_TOTAL_SCAN_BYTES in MAX_SCAN_BYTES chunks into the caller-supplied buffer and
 * returns the set of SECRET_PATTERNS names that matched. Stops after the first chunk
 * when that chunk contains a NUL byte (binary asset — scanning a 500 MB mesh
 * synchronously would stall the loop). Returns an empty set on any I/O error: the
 * caller cannot scan what it cannot read, and the file was unscanned before this
 * change too.
 */
function scanOversizedFileForSecrets(file: string, buf: Buffer): Set<string> {
  const matched = new Set<string>();
  let fd: number;
  try {
    fd = fs.openSync(file, "r");
  } catch {
    return matched;
  }
  try {
    let pos = 0;
    let carry = "";
    while (pos < MAX_TOTAL_SCAN_BYTES) {
      const want = Math.min(MAX_SCAN_BYTES, MAX_TOTAL_SCAN_BYTES - pos);
      let read = 0;
      try {
        read = fs.readSync(fd, buf, 0, want, pos);
      } catch {
        break;
      }
      if (read <= 0) break;
      const chunk = buf.subarray(0, read);
      const binary = pos === 0 && chunk.includes(0);
      const text = carry + chunk.toString("utf-8");
      for (const { name, re } of SECRET_PATTERNS) if (re.test(text)) matched.add(name);
      pos += read;
      if (binary) break;
      carry = text.slice(-SCAN_OVERLAP_BYTES);
    }
    if (pos >= MAX_TOTAL_SCAN_BYTES) {
      log.warn(`[public-snapshot-sync] secret scan truncated at ${MAX_TOTAL_SCAN_BYTES} bytes: ${file}`);
    }
  } finally {
    fs.closeSync(fd);
  }
  return matched;
}

/**
 * Fail-closed secret scan of the target working tree. Returns a list of
 * `relpath (pattern)` hits (empty when clean). Scans files over MAX_SCAN_BYTES
 * in bounded chunks (#2599), honours SCAN_ALLOWLIST by exact repo-relative path +
 * pattern name, and never logs the matched value. Does NOT scan the commit
 * summary/subjects — those live only in the HEAD commit and are scanned inline
 * by that caller. (#1941)
 */
function scanTreeForSecrets(tgtDir: string): string[] {
  const hits: string[] = [];
  const buf = Buffer.allocUnsafe(MAX_SCAN_BYTES); // one reusable buffer for the whole walk
  for (const file of walkFiles(tgtDir)) {
    let size: number;
    try {
      size = fs.statSync(file).size;
    } catch {
      continue; // unstat-able — skip
    }
    let matched: Set<string>;
    if (size > MAX_SCAN_BYTES) {
      matched = scanOversizedFileForSecrets(file, buf);
    } else {
      let text: string;
      try {
        text = fs.readFileSync(file, "utf-8");
      } catch {
        continue; // unreadable — skip
      }
      matched = new Set<string>();
      for (const { name, re } of SECRET_PATTERNS) if (re.test(text)) matched.add(name);
    }
    if (matched.size === 0) continue;
    const rel = path.relative(tgtDir, file);
    for (const name of matched) {
      if (SCAN_ALLOWLIST.some((a) => a.path === rel && a.name === name)) continue;
      hits.push(`${rel} (${name})`);
    }
  }
  return hits;
}

/**
 * Fail-closed secret-scan over LLM-generated commit text. Pushes a `label (name)`
 * entry to `hits` for every SECRET_PATTERNS match, mirroring scanTreeForSecrets'
 * hit format. Mutates `hits` in place (does not return).
 */
function scanTextsForSecrets(hits: string[], texts: Record<string, string>): void {
  for (const [label, text] of Object.entries(texts)) {
    for (const { name, re } of SECRET_PATTERNS) {
      if (re.test(text)) hits.push(`${label} (${name})`);
    }
  }
}

/**
 * Literal strings that must never appear in this pair's committed text (#2362):
 * `owner/name`, bare `owner`, and — only when the target was RENAMED — the bare
 * source repo name. `claws` → `claws-snapshot` keeps "claws" (it is the public
 * identity); `fleet-infra` → `homelab` scrubs "fleet-infra". Longest first, so a
 * `owner/name` match is replaced before the bare `owner` inside it.
 */
function sourceMentionLiterals(source: string, target: string): string[] {
  const [owner, name = ""] = source.split("/");
  const tgtName = target.split("/")[1] ?? "";
  const out = [`${owner}/${name}`, owner!];
  if (name && !tgtName.includes(name)) out.push(name);
  return out;
}

/** Replace private source-repo mentions in LLM commit text with a neutral phrase (#2362). */
export function stripSourceMentions(text: string, source: string, target: string): string {
  let out = text;
  for (const lit of sourceMentionLiterals(source, target)) out = out.split(lit).join(SOURCE_PLACEHOLDER);
  return out;
}

/**
 * Split raw LLM commit-message output into a subject line and a body (#2362). The
 * subject is `null` — caller falls back to a fixed subject — when the first line
 * isn't usable as one: a bullet/heading/quote/fence (the model emitted only a body),
 * over 100 chars, or naming the private source (leaked → discard rather than patch,
 * since a subject built around the source name reads wrong once scrubbed). The body
 * always has source mentions scrubbed.
 */
export function parseCommitMessage(
  raw: string, source: string, target: string,
): { subject: string | null; body: string } {
  let text = raw.trim();
  const fence = text.match(/^```[a-zA-Z]*\n([\s\S]*?)\n```$/);
  if (fence) text = fence[1].trim();
  const lines = text.split("\n");
  const firstIdx = lines.findIndex((l) => l.trim() !== "");
  if (firstIdx === -1) return { subject: null, body: "" };
  const first = lines[firstIdx].trim();
  const unusable =
    /^([-*+>#]|\d+\.|```)/.test(first) ||
    first.length > 100 ||
    sourceMentionLiterals(source, target).some((lit) => first.includes(lit));
  if (unusable) return { subject: null, body: stripSourceMentions(text, source, target) };
  const subject = first
    .replace(/^(subject|title|commit message)\s*:\s*/i, "")
    .replace(/[.\s]+$/, "")
    .slice(0, 72);
  const body = stripSourceMentions(lines.slice(firstIdx + 1).join("\n").trim(), source, target);
  return { subject: subject || null, body };
}

/**
 * Does the target's published history still name the private source (#2362)? A hit
 * means this pair needs its one-shot history cleanup, so the caller bypasses the
 * idempotency gate. Self-clearing: once no message mentions the source, never fires
 * again. A zero-commit target makes `git log` throw → nothing published, no cleanup.
 */
async function historyMentionsSource(
  tgtDir: string, source: string, target: string, targetOwner: string,
): Promise<boolean> {
  let text: string;
  try {
    text = await claude.git(["log", "--format=%B", "--branches", "--tags"], tgtDir, {
      owner: targetOwner,
      maxBuffer: 32 * 1024 * 1024,
    });
  } catch {
    return false;
  }
  return sourceMentionLiterals(source, target).some((lit) => text.includes(lit));
}

/**
 * One-shot rewrite of every published commit message on branches AND tags (#2362).
 * Trees, authors and dates are untouched, so the public release tags keep their exact
 * source-accurate trees and only move to the rewritten SHAs. Returns false (and does
 * nothing) if a config literal isn't a plain repo path — the sed program is a shell
 * string, so that validation is load-bearing, not decorative. Matching is
 * CASE-SENSITIVE on both sides, matching `historyMentionsSource`: a mismatch would
 * make every run rewrite and force-push without ever converging.
 */
async function rewriteHistoryMessages(tgtDir: string, source: string, target: string): Promise<boolean> {
  const lits = sourceMentionLiterals(source, target);
  if (!lits.every((l) => /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)?$/.test(l))) {
    log.warn(`[public-snapshot-sync] skipping history cleanup for ${target}: unsafe source literal`);
    return false;
  }
  // The two legacy subject shapes are rewritten wholesale FIRST, so they become
  // `Update snapshot` / `Release v1.2.0` rather than "snapshot: update from the
  // source repository" once the literal-scrub rules below run.
  const exprs = [
    `s|^snapshot: update from .*$|${DEFAULT_SUBJECT}|`,
    "s|^snapshot: \\(.*\\) from .*$|Release \\1|",
    ...lits.map((l) => `s|${l.replace(/[.\\|&]/g, "\\$&")}|${SOURCE_PLACEHOLDER}|g`),
  ];
  const sed = exprs.map((e) => `-e "${e}"`).join(" ");
  // `--` separates filter-branch's own options from the rev-list args; `--branches
  // --tags` deliberately excludes refs/remotes/*.
  await execFileAsync(
    "git",
    ["filter-branch", "-f", "--msg-filter", `sed ${sed}`, "--tag-name-filter", "cat", "--", "--branches", "--tags"],
    { cwd: tgtDir, env: { ...process.env, FILTER_BRANCH_SQUELCH_WARNING: "1" } },
  );
  log.info(`[public-snapshot-sync] rewrote historical commit messages for ${target} (#2362)`);
  return true;
}

/** File the standard fail-closed secret-scan alert (never includes the matched value). */
async function fileSecretAlert(target: string, hits: string[]): Promise<void> {
  await ensureAlertIssue({
    repo: SELF_REPO,
    title: `[snapshot] Secret detected while syncing ${target}`,
    body:
      `Potential secrets were detected while preparing the snapshot for \`${target}\`. ` +
      "The sync was aborted and nothing was pushed. Remove these from the source (or add them to the scrub list) and re-run:\n\n" +
      hits.map((h) => `- \`${h}\``).join("\n"),
    logPrefix: "public-snapshot-sync",
  });
}

/**
 * Create/refresh the PUBLIC release for `tag` anchored at `commitSha` (a commit that
 * MUST already exist on the target remote — always push before calling this), attaching
 * the source's DMG assets. Modelled on `mirrorLatestRelease` but anchored at a
 * source-accurate snapshot commit rather than target HEAD (#1941). Best-effort: files a
 * single alert on failure instead of throwing, because the snapshot commits are already
 * pushed by the time this runs and must not be rolled back.
 */
async function publishReleaseForTag(
  source: string, target: string, tag: string, commitSha: string, targetOwner: string, releaseAssetUrl?: string,
): Promise<void> {
  try {
    const existing = await gh.getReleaseAssetNames(target, tag);
    const assets = await downloadReleaseAssetsForTag(source, tag, targetOwner, releaseAssetUrl);
    if (existing === null) {
      await gh.createRelease(target, tag, assets, commitSha, tag);
    } else {
      await gh.uploadReleaseAssets(target, tag, assets); // release exists but lacked any asset
    }
    log.info(`[public-snapshot-sync] published release ${tag} → ${target} at ${commitSha}`);
  } catch (err) {
    await ensureAlertIssue({
      repo: SELF_REPO,
      title: `[snapshot] Release mirror failed for ${target}`,
      body:
        `Mirroring the release \`${tag}\` from \`${source}\` to \`${target}\` failed:\n\n` +
        `\`\`\`\n${err instanceof Error ? err.message : String(err)}\n\`\`\`\n\n` +
        "The source sync itself succeeded; only the release-asset mirror step failed. It will retry next run.",
      logPrefix: "public-snapshot-sync",
    });
  }
}

export async function run(): Promise<void> {
  for (const { source, target, mirrorReleases, scrubPaths, releaseAssetUrl } of PUBLIC_SNAPSHOTS) {
    const rewriteHistory = (scrubPaths?.length ?? 0) > 0;
    let taskId: number | null = null;
    try {
      // 1. Resolve the private source repo among installation repos.
      const src = (await gh.listRepos()).find((r) => r.fullName === source);
      if (!src) {
        log.warn(`[public-snapshot-sync] source repo ${source} not found among installation repos — skipping`);
        continue;
      }

      // 2. Target readiness — purely read-only, NEVER un-archive.
      const tgtState = await gh.ensureSnapshotTarget(target);
      if (!tgtState.exists) {
        await ensureAlertIssue({
          repo: SELF_REPO,
          title: `[snapshot] Target repo ${target} does not exist`,
          body: "Create it as a PUBLIC repo, then the weekly sync will populate it.",
          logPrefix: "public-snapshot-sync",
        });
        continue;
      }
      if (tgtState.archived) {
        await ensureAlertIssue({
          repo: SELF_REPO,
          title: `[snapshot] Target repo ${target} is archived`,
          body: "Un-archive it manually in GitHub settings; the weekly sync skips archived targets and resumes automatically once active.",
          logPrefix: "public-snapshot-sync",
        });
        continue;
      }
      const tgtBranch = tgtState.defaultBranch;
      const [targetOwner, targetName] = target.split("/");

      // 3. Record task start.
      taskId = db.recordTaskStart("public-snapshot-sync", target, 0, null);

      // 4. Clone/refresh source and resolve its head SHA.
      const srcDir = await claude.ensureClone(src);
      const srcSha = (await claude.git(["rev-parse", `origin/${src.defaultBranch}`], srcDir, { owner: src.owner })).trim();

      // 5. Prepare the target clone.
      const tgtDir = path.join(WORK_DIR, "snapshots", targetOwner, targetName);
      if (fs.existsSync(path.join(tgtDir, ".git"))) {
        await claude.git(["fetch", "--all", "--prune"], tgtDir, { owner: targetOwner });
      } else {
        fs.mkdirSync(tgtDir, { recursive: true });
        await execFileAsync("gh", ["repo", "clone", target, tgtDir], {
          env: buildEnvForGh(await getInstallationTokenForOwner(targetOwner)),
        });
      }
      try {
        await claude.git(["checkout", "-B", tgtBranch, `origin/${tgtBranch}`, "--force"], tgtDir, { owner: targetOwner });
      } catch {
        // Freshly-created target with zero commits: origin/<branch> doesn't exist.
        await claude.git(["checkout", "-b", tgtBranch], tgtDir, { owner: targetOwner });
      }

      // 6. Read stored metadata: the last synced source SHA plus, for release pairs,
      // the tag → public-commit map of releases already published source-accurately.
      const metaPath = path.join(tgtDir, ".claws-snapshot.json");
      let lastSha: string | null = null;
      let published: Record<string, string> = {};
      if (fs.existsSync(metaPath)) {
        try {
          const meta = JSON.parse(fs.readFileSync(metaPath, "utf-8")) as {
            sourceSha?: string;
            publishedReleases?: Record<string, string>;
          };
          lastSha = meta.sourceSha ?? null;
          if (meta.publishedReleases && typeof meta.publishedReleases === "object") {
            published = { ...meta.publishedReleases };
          }
        } catch {
          lastSha = null;
        }
      }

      // 6b. For `mirrorReleases` pairs, compute the stable release tags that still need a
      // source-accurate snapshot commit + anchored public release (#1941). Non-release
      // pairs never touch this machinery.
      type PendingTag = { tag: string; tagSha: string; commitDate: number };
      const pending: PendingTag[] = [];
      if (mirrorReleases) {
        await claude.git(["fetch", "--tags", "--force"], srcDir, { owner: src.owner });
        for (const tag of await gh.listStableReleaseTags(source)) {
          if (published[tag]) continue; // already mirrored source-accurately (or preexisting)
          let tagSha: string;
          try {
            tagSha = (await claude.git(["rev-list", "-n", "1", tag], srcDir, { owner: src.owner })).trim();
          } catch {
            continue; // tag not fetched / unknown — skip
          }
          if (!tagSha) continue;
          // Only tags reachable from the SHA we're syncing to. `merge-base --is-ancestor`
          // exits 0 when it IS an ancestor and non-zero otherwise; claude.git surfaces the
          // non-zero exit as a thrown error, so a throw means "not reachable → skip".
          try {
            await claude.git(["merge-base", "--is-ancestor", tagSha, srcSha], srcDir, { owner: src.owner });
          } catch {
            continue; // not an ancestor of srcSha → skip
          }
          // Leave already-existing public releases (e.g. v1.3.1 anchored at an old HEAD)
          // alone — record them as preexisting so they are never re-anchored.
          const pub = await gh.getReleaseAssetNames(target, tag);
          if (pub !== null) {
            published[tag] = "preexisting";
            continue;
          }
          const commitDate = Number(
            (await claude.git(["log", "-1", "--format=%ct", tagSha], srcDir, { owner: src.owner })).trim(),
          );
          pending.push({ tag, tagSha, commitDate });
        }
        pending.sort((a, b) => a.commitDate - b.commitDate); // oldest release first
      }

      // 6d. One-shot history cleanup (#2362). If the target's published messages still
      // name the private source, this pair must resync even when the source hasn't moved.
      const needsHistoryCleanup = await historyMentionsSource(tgtDir, source, target, targetOwner);

      // 6c. Idempotency gate — skip only when the source hasn't advanced AND no release is
      // pending (a release can be cut on an already-synced commit).
      if (lastSha === srcSha && pending.length === 0 && !needsHistoryCleanup) {
        if (mirrorReleases) await mirrorLatestRelease(source, target, tgtDir, targetOwner, releaseAssetUrl);
        db.recordTaskComplete(taskId, { commits: 0 });
        continue;
      }

      let historyRewritten = false;
      // `scrubPaths` pairs republish a squashed root commit every sync, so bypassing the
      // gate above is already a full resync for them — filter-branch would be redundant.
      if (needsHistoryCleanup && !rewriteHistory) {
        historyRewritten = await rewriteHistoryMessages(tgtDir, source, target);
      }

      // 7. Summarise the features/changes since the last sync, and derive the commit
      // subject from that summary — the private source path is never named (#2362).
      const trackTokens = db.trackTaskTokens(taskId);
      let range = lastSha ? `${lastSha}..${srcSha}` : srcSha;
      let fullResync = lastSha === null;
      let logOut: string;
      try {
        logOut = await claude.git(["log", "--no-merges", "--pretty=format:%s", range], srcDir, { owner: src.owner });
      } catch {
        // Rewritten history — lastSha no longer reachable. Fall back to full history.
        range = srcSha;
        fullResync = true;
        logOut = await claude.git(["log", "--no-merges", "--pretty=format:%s", range], srcDir, { owner: src.owner });
      }
      const subjects = logOut.split("\n").map((s) => s.trim()).filter(Boolean).slice(0, 200);
      // A full resync spans up to 200 subjects, which don't distil into one honest
      // subject line — use the fixed "rewrote history"-style subject instead (#2362).
      let subject = fullResync ? RESYNC_SUBJECT : DEFAULT_SUBJECT;
      let summary: string;
      if (subjects.length === 0) {
        summary = "Routine snapshot update.";
      } else {
        const raw = (
          await claude.runClaude(COMMIT_MESSAGE_PROMPT + subjects.join("\n"), srcDir, {
            tier: "sonnet",
            provider: "claude",
            onTokensUsed: trackTokens,
          })
        ).trim();
        const parsed = parseCommitMessage(raw, source, target);
        summary = parsed.body || "Routine snapshot update.";
        if (!fullResync && parsed.subject) subject = parsed.subject;
      }

      // 8. Build a source-accurate snapshot commit for each pending release tag, in
      // release order. Every tree is rebuilt from `git archive <tag-sha>`, scrubbed, and
      // secret-scanned before any push; because all commits are made locally and pushed
      // once at the end, a scan hit on ANY tree aborts the whole run with nothing on the
      // remote (no partial history). A release cut exactly at HEAD folds into this loop —
      // it also carries the tailored README and HEAD-commit body.
      const headIsRelease = pending.some((p) => p.tagSha === srcSha);
      let commitCount = 0;
      let secretAbort = false;
      for (const p of pending) {
        const isHead = p.tagSha === srcSha;
        const swapped = await rebuildTargetTree(tgtDir, srcDir, p.tagSha, src.owner, scrubPaths ?? []);
        if (isHead && !swapped) await tailorPublicReadme(tgtDir, srcDir, source, trackTokens);
        const hits = scanTreeForSecrets(tgtDir);
        if (isHead) {
          // Summary + subjects only land in the HEAD commit's body/history.
          scanTextsForSecrets(hits, {
            "commit-summary": summary,
            "commit-subject-line": subject,
            "commit-subjects": subjects.join("\n"),
          });
        }
        if (hits.length > 0) {
          await fileSecretAlert(target, hits);
          db.recordTaskFailed(taskId, "secret detected", { commits: 0 });
          secretAbort = true;
          break;
        }
        // The metadata committed here cannot yet contain this tag's own commit SHA
        // (chicken-and-egg); it is recorded in `published` after the commit and lands in
        // a later commit's metadata (or is covered by the pre-existing-release check).
        fs.writeFileSync(
          metaPath,
          JSON.stringify({ sourceSha: isHead ? srcSha : p.tagSha, publishedReleases: published }, null, 2) + "\n",
        );
        await claude.git(["add", "-A"], tgtDir, { owner: targetOwner });
        const relSubject = `Release ${p.tag}`;
        const msgArgs = isHead
          ? ["commit", "-m", relSubject, "-m", summary]
          : ["commit", "-m", relSubject];
        await claude.git(msgArgs, tgtDir, { owner: targetOwner });
        published[p.tag] = (await claude.git(["rev-parse", "HEAD"], tgtDir, { owner: targetOwner })).trim();
        commitCount++;
      }
      if (secretAbort) continue; // nothing pushed — a tree failed the scan

      // 9. Final HEAD snapshot commit — unless HEAD is itself a release commit already made
      // above. Rebuilds from srcSha, tailors the README, scans the tree AND the LLM summary
      // + raw subjects (which only ever land in this commit's history).
      if (!headIsRelease) {
        const swapped = await rebuildTargetTree(tgtDir, srcDir, srcSha, src.owner, scrubPaths ?? []);
        if (!swapped) await tailorPublicReadme(tgtDir, srcDir, source, trackTokens);
        const hits = scanTreeForSecrets(tgtDir);
        scanTextsForSecrets(hits, {
          "commit-summary": summary,
          "commit-subject-line": subject,
          "commit-subjects": subjects.join("\n"),
        });
        if (hits.length > 0) {
          await fileSecretAlert(target, hits);
          db.recordTaskFailed(taskId, "secret detected", { commits: 0 });
          continue;
        }
        fs.writeFileSync(metaPath, JSON.stringify({ sourceSha: srcSha, publishedReleases: published }, null, 2) + "\n");
        if (rewriteHistory) {
          // Squash: publish a single root commit so scrubbed paths cannot survive in an ancestor.
          try { await claude.git(["branch", "-D", REWRITE_BRANCH], tgtDir, { owner: targetOwner }); } catch { /* absent */ }
          await claude.git(["checkout", "--orphan", REWRITE_BRANCH], tgtDir, { owner: targetOwner });
        }
        await claude.git(["add", "-A"], tgtDir, { owner: targetOwner });
        let hasStaged = true;
        if (!rewriteHistory) {
          try {
            await claude.git(["diff", "--cached", "--quiet"], tgtDir, { owner: targetOwner });
            hasStaged = false; // exit 0 → nothing staged
          } catch {
            hasStaged = true; // exit 1 → staged changes present
          }
        }
        if (hasStaged) {
          await claude.git(["commit", "-m", subject, "-m", summary], tgtDir, { owner: targetOwner });
          commitCount++;
        }
      }

      // 10. Nothing to publish (source advanced but tree identical, or only pre-existing
      // releases). Preserve the legacy no-op behaviour: no push, no Dependabot mutation.
      // A history rewrite (#2362) has nothing staged to commit, so it must not stop here
      // or the rewritten messages would never reach the remote.
      if (commitCount === 0 && !historyRewritten) {
        if (mirrorReleases) await mirrorLatestRelease(source, target, tgtDir, targetOwner, releaseAssetUrl);
        db.recordTaskComplete(taskId, { commits: 0 });
        continue;
      }

      // 11. Push once, THEN anchor each public release at its snapshot commit. The push
      // must precede createRelease because `--target <commitSha>` requires the commit to
      // already exist on the remote. No release is created before this push.
      const pushArgs = rewriteHistory || historyRewritten
        ? ["push", "--force", "origin", `HEAD:${tgtBranch}`]
        : ["push", "origin", `HEAD:${tgtBranch}`];
      await claude.git(pushArgs, tgtDir, { owner: targetOwner });
      if (historyRewritten) {
        // Release tags were moved onto the rewritten commits — republish them too (#2362).
        await claude.git(["push", "--force", "--tags", "origin"], tgtDir, { owner: targetOwner });
      }
      await gh.disableDependabot(target);
      if (mirrorReleases) {
        for (const p of pending) {
          await publishReleaseForTag(source, target, p.tag, published[p.tag], targetOwner, releaseAssetUrl);
        }
      }
      db.recordTaskComplete(taskId, { commits: commitCount });
    } catch (err) {
      log.error(`[public-snapshot-sync] ${target}: ${err instanceof Error ? err.message : String(err)}`);
      if (taskId !== null) db.recordTaskFailed(taskId, String(err), { commits: 0 });
    }
  }
}
