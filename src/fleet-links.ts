/**
 * Verified cross-repo deployment links for the doc-maintainer (#clw_01M4JP50JPNHKGHZBWEW0VVW75).
 *
 * Claws computes which managed repo deploys, configures or provisions which,
 * from local clones of every managed repo, and renders one `## Related
 * repositories` section per repo. The doc-maintainer writes that section
 * deterministically into `docs/OVERVIEW.md`; the model never guesses a link.
 *
 * Only four evidence sources count, in this authority order:
 *   1. `declared` — `deploys` entries in the source repo's `claws.json`;
 *   2. `dispatch` — an app's workflow dispatching a workflow in another repo;
 *   3. `image`    — a YAML manifest referencing a managed repo's container image;
 *   4. `oidc`     — an AWS OIDC trust-policy subject (`repo:<owner>/<name>:…`) in a `.tf` file.
 *
 * A fleet-wide map (e.g. a dedicated docs repo) is deferred; a later renderer
 * can emit one from the same {@link FleetLink} list without new evidence rules.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { webUrlForRepo, webUrlForRepoFile, type Repo } from "./config.js";
import * as gh from "./github.js";
import * as claude from "./claude.js";
import * as log from "./log.js";
import { getRepoConfig } from "./repo-config.js";
import { walkRepoTree } from "./jobs/scanner-runner.js";
import { mapWithConcurrency } from "./util.js";

export type FleetRelation = "deploys" | "configures" | "provisions";
export type FleetEvidence = "declared" | "dispatch" | "image" | "oidc";

export interface FleetLink {
  /** The app being deployed, configured or provisioned. */
  target: string;
  /** The repo that deploys, configures or provisions it. */
  source: string;
  relation: FleetRelation;
  /** The file in `source` that carries the relationship. */
  sourcePath: string;
  /** The file in `target` that carries it, when there is one (the dispatching workflow). */
  targetPath?: string;
  evidence: FleetEvidence;
}

export const RELATED_REPOSITORIES_HEADING = "## Related repositories";

/** Lower index = higher authority; a duplicate link keeps its most authoritative evidence. */
const EVIDENCE_AUTHORITY: readonly FleetEvidence[] = ["declared", "dispatch", "image", "oidc"];

const WALK_MAX_DEPTH = 6;
/** Manifests and Terraform files are small; anything larger is generated or vendored. */
const MAX_SCANNED_FILE_BYTES = 1024 * 1024;
const WORKFLOW_DIRS = [".forgejo/workflows", ".github/workflows"];
/** Top-level directories the image rule ignores — prose and CI, not manifests. */
const IMAGE_SKIP_TOP_DIRS = new Set(["docs", ".forgejo", ".github"]);
const IMAGE_REF_RE = /^(?:registry\.home\.bstjohn\.net|registry\.bstjohn\.net|ghcr\.io)\/([\w.-]+)\/([\w.-]+)[:@]/i;
const IMAGE_LINE_RE = /^\s*(?:-\s*)?(?:image|newName)\s*:\s*["']?([^\s"'#]+)/;
const DISPATCH_API_RE = /repos\/([\w.-]+)\/([\w.-]+)\/actions\/workflows\/([\w.-]+)\/dispatches/g;
const GH_WORKFLOW_RUN_RE = /gh\s+workflow\s+run\b([^\n]*)/g;
/** `gh workflow run` flags that consume the next token. */
const GH_FLAGS_WITH_VALUE = new Set(["-f", "-F", "--field", "--raw-field", "-r", "--ref"]);
const OIDC_SUBJECT_RE = /"repo:([\w.-]+)\/([\w.-]+):[^"]*"/g;

function readSmallFile(absPath: string): string | null {
  try {
    if (fs.statSync(absPath).size > MAX_SCANNED_FILE_BYTES) return null;
    return fs.readFileSync(absPath, "utf8");
  } catch {
    return null;
  }
}

function isYaml(name: string): boolean {
  return /\.ya?ml$/i.test(name);
}

/** A repo-relative path that stays inside the clone. */
function isSafeRelPath(p: string): boolean {
  const normalized = path.posix.normalize(p);
  return !path.isAbsolute(p) && normalized !== ".." && !normalized.startsWith("../");
}

/** The workflow file named `file` in `dir`'s clone, or null when it is in neither workflow directory. */
function findWorkflow(dir: string, file: string): string | null {
  for (const wfDir of WORKFLOW_DIRS) {
    const rel = `${wfDir}/${file}`;
    if (fs.existsSync(path.join(dir, rel))) return rel;
  }
  return null;
}

/** Extract `{ file, repo }` from the arguments of one `gh workflow run` invocation. */
function parseGhWorkflowRun(args: string): { file: string; repo: string } | null {
  const tokens = args.trim().split(/\s+/).map((t) => t.replace(/^["']|["']$/g, ""));
  let file: string | null = null;
  let repo: string | null = null;
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (!tok || tok === "\\") continue;
    if (tok === "--repo" || tok === "-R") { repo = tokens[++i] ?? null; continue; }
    if (tok.startsWith("--repo=")) { repo = tok.slice("--repo=".length); continue; }
    if (GH_FLAGS_WITH_VALUE.has(tok)) { i++; continue; }
    if (tok.startsWith("-")) continue;
    if (file === null) file = tok;
  }
  if (!file || !repo || !/^[\w.-]+\/[\w.-]+$/.test(repo)) return null;
  return { file, repo };
}

interface ScannedRepo {
  repo: Repo;
  dir: string;
}

/**
 * Scan every cloned managed repo for cross-repo relationships. Self-references
 * and targets outside `repos` are dropped; an uncloned repo is skipped as an
 * evidence source.
 */
export async function scanFleetLinks(repos: readonly Repo[]): Promise<FleetLink[]> {
  const managed = new Map(repos.map((r) => [r.fullName.toLowerCase(), r]));
  const resolve = (owner: string, name: string): Repo | undefined => managed.get(`${owner}/${name}`.toLowerCase());

  const scanned = (await mapWithConcurrency([...repos], 4, async (repo): Promise<ScannedRepo | null> => {
    const dir = claude.repoDir(repo);
    if (!fs.existsSync(dir)) return null;
    try {
      await claude.ensureClone(repo, { skipFetchIfRecent: true });
    } catch (err) {
      // Scan the clone as it stands — a stale clone lags by one fetch, which the
      // digest-forced run corrects on a later tick.
      log.warn(`[fleet-links] Could not refresh ${repo.fullName}; scanning the existing clone: ${err instanceof Error ? err.message : String(err)}`);
    }
    return { repo, dir };
  })).filter((s): s is ScannedRepo => s !== null);
  const dirOf = new Map(scanned.map((s) => [s.repo.fullName.toLowerCase(), s.dir]));

  const links: FleetLink[] = [];
  const add = (link: FleetLink): void => {
    if (link.source.toLowerCase() === link.target.toLowerCase()) return;
    links.push(link);
  };

  for (const { repo, dir } of scanned) {
    // 1. Declared in claws.json.
    for (const entry of getRepoConfig(repo.fullName)?.deploys ?? []) {
      const target = managed.get(entry.repo.toLowerCase());
      if (!target) {
        log.warn(`[fleet-links] ${repo.fullName}: claws.json deploys entry names ${entry.repo}, which is not a managed repo; ignoring it`);
        continue;
      }
      if (!isSafeRelPath(entry.path) || !fs.existsSync(path.join(dir, entry.path))) {
        log.warn(`[fleet-links] ${repo.fullName}: claws.json deploys entry path ${entry.path} does not exist; ignoring it`);
        continue;
      }
      add({ target: target.fullName, source: repo.fullName, relation: entry.relation ?? "deploys", sourcePath: path.posix.normalize(entry.path), evidence: "declared" });
    }

    // 2. Workflow dispatches: this repo is the app; the dispatched repo deploys it.
    for (const wfDir of WORKFLOW_DIRS) {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(path.join(dir, wfDir), { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.isFile() || !isYaml(entry.name)) continue;
        const relPath = `${wfDir}/${entry.name}`;
        const content = readSmallFile(path.join(dir, relPath));
        if (content === null) continue;
        const dispatches: Array<{ owner: string; name: string; file: string }> = [];
        for (const m of content.matchAll(DISPATCH_API_RE)) dispatches.push({ owner: m[1], name: m[2], file: m[3] });
        for (const m of content.matchAll(GH_WORKFLOW_RUN_RE)) {
          const parsed = parseGhWorkflowRun(m[1]);
          if (!parsed) continue;
          const [owner, name] = parsed.repo.split("/");
          dispatches.push({ owner, name, file: parsed.file });
        }
        for (const d of dispatches) {
          const deployer = resolve(d.owner, d.name);
          const deployerDir = deployer && dirOf.get(deployer.fullName.toLowerCase());
          if (!deployer || !deployerDir) continue;
          const sourcePath = findWorkflow(deployerDir, d.file);
          if (!sourcePath) continue;
          add({ target: repo.fullName, source: deployer.fullName, relation: "deploys", sourcePath, targetPath: relPath, evidence: "dispatch" });
        }
      }
    }

    // 3 + 4. Manifest image references and OIDC trust-policy subjects.
    const imageRefs: Array<{ owner: string; image: string; relPath: string }> = [];
    walkRepoTree(dir, {
      maxDepth: WALK_MAX_DEPTH,
      onDirectory: ({ absPath, relPath: dirRel, entries }) => {
        const topDir = dirRel.split("/")[0];
        for (const entry of entries) {
          if (!entry.isFile()) continue;
          const relPath = dirRel === "" ? entry.name : `${dirRel}/${entry.name}`;
          if (isYaml(entry.name) && !IMAGE_SKIP_TOP_DIRS.has(topDir)) {
            const content = readSmallFile(path.join(absPath, entry.name));
            if (content === null) continue;
            for (const line of content.split("\n")) {
              const value = IMAGE_LINE_RE.exec(line)?.[1];
              const m = value ? IMAGE_REF_RE.exec(value) : null;
              if (m) imageRefs.push({ owner: m[1].toLowerCase(), image: m[2].toLowerCase(), relPath });
            }
          } else if (entry.name.endsWith(".tf")) {
            const content = readSmallFile(path.join(absPath, entry.name));
            if (content === null) continue;
            for (const line of content.split("\n")) {
              const trimmed = line.trimStart();
              if (trimmed.startsWith("#") || trimmed.startsWith("//")) continue;
              for (const m of line.matchAll(OIDC_SUBJECT_RE)) {
                const target = resolve(m[1], m[2]);
                if (target) add({ target: target.fullName, source: repo.fullName, relation: "provisions", sourcePath: relPath, evidence: "oidc" });
              }
            }
          }
        }
      },
    });

    // An image counts when it is exactly a managed repo's name, or `<name>-<suffix>`
    // (e.g. `bonkus-migrate`) when this repo also references the exact `<name>` image.
    const exactImages = new Set(imageRefs.filter((r) => resolve(r.owner, r.image)).map((r) => `${r.owner}/${r.image}`));
    for (const ref of imageRefs) {
      let target = resolve(ref.owner, ref.image);
      if (!target) {
        const parts = ref.image.split("-");
        for (let i = parts.length - 1; i > 0 && !target; i--) {
          const base = parts.slice(0, i).join("-");
          if (exactImages.has(`${ref.owner}/${base}`)) target = resolve(ref.owner, base);
        }
      }
      if (target) add({ target: target.fullName, source: repo.fullName, relation: "deploys", sourcePath: ref.relPath, evidence: "image" });
    }
  }

  return dedupeAndSort(links);
}

function linkKey(l: FleetLink): string {
  return [l.target.toLowerCase(), l.source.toLowerCase(), l.sourcePath, l.relation].join("\0");
}

function dedupeAndSort(links: readonly FleetLink[]): FleetLink[] {
  const byKey = new Map<string, FleetLink>();
  for (const link of links) {
    const key = linkKey(link);
    const existing = byKey.get(key);
    if (!existing || EVIDENCE_AUTHORITY.indexOf(link.evidence) < EVIDENCE_AUTHORITY.indexOf(existing.evidence)) {
      byKey.set(key, link);
    }
  }
  return [...byKey.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, l]) => l);
}

function fileLink(fullName: string, repos: readonly Repo[], filePath: string): string {
  const branch = repos.find((r) => r.fullName.toLowerCase() === fullName.toLowerCase())?.defaultBranch ?? "main";
  return `[\`${filePath}\`](${webUrlForRepoFile(fullName, branch, filePath)})`;
}

/**
 * Render `fullName`'s `## Related repositories` section from the fleet's links.
 * Deterministic for a given input, so its digest only moves when a
 * relationship does.
 */
export function renderRelatedRepositoriesSection(fullName: string, links: readonly FleetLink[], repos: readonly Repo[]): string {
  const self = fullName.toLowerCase();
  const sorted = dedupeAndSort(links);
  const inbound = sorted.filter((l) => l.target.toLowerCase() === self && l.source.toLowerCase() !== self);
  const outbound = sorted.filter((l) => l.source.toLowerCase() === self && l.target.toLowerCase() !== self);

  const lines = [
    RELATED_REPOSITORIES_HEADING,
    "",
    "Claws generates this section from verified evidence only — `deploys` entries in `claws.json`, workflow dispatches, container image references in YAML manifests, and OIDC trust-policy subjects in Terraform/OpenTofu files. To change it, edit that evidence, not this section.",
  ];

  const renderGroup = (title: string, group: readonly FleetLink[], other: (l: FleetLink) => string): void => {
    if (group.length === 0) return;
    const byRepo = new Map<string, { name: string; links: FleetLink[] }>();
    for (const l of group) {
      const name = other(l);
      const entry = byRepo.get(name.toLowerCase()) ?? { name, links: [] };
      entry.links.push(l);
      byRepo.set(name.toLowerCase(), entry);
    }
    lines.push("", `**${title}:**`, "");
    for (const key of [...byRepo.keys()].sort()) {
      const { name, links: repoLinks } = byRepo.get(key)!;
      const parts = repoLinks.map((l) => {
        const dispatchedFrom = l.targetPath ? ` from ${fileLink(l.target, repos, l.targetPath)}` : "";
        return `${fileLink(l.source, repos, l.sourcePath)} (${l.relation}, ${l.evidence}${dispatchedFrom})`;
      });
      lines.push(`- [${name}](${webUrlForRepo(name)}): ${parts.join("; ")}`);
    }
  };

  renderGroup("Deployed, configured or provisioned by", inbound, (l) => l.source);
  renderGroup("Deploys, configures or provisions", outbound, (l) => l.target);

  if (inbound.length === 0 && outbound.length === 0) {
    lines.push("", "No deployment, configuration or provisioning relationship with another managed repository was found in these evidence sources.");
  }
  return `${lines.join("\n")}\n`;
}

/**
 * Replace the `## Related repositories` section in `markdown` (from its heading
 * to the next `## ` heading or EOF), or append it when absent.
 */
export function upsertRelatedRepositoriesSection(markdown: string, section: string): string {
  const lines = markdown.split("\n");
  const start = lines.findIndex((l) => l.trimEnd() === RELATED_REPOSITORIES_HEADING);
  const body = section.endsWith("\n") ? section : `${section}\n`;
  if (start === -1) {
    const trimmed = markdown.replace(/\n+$/, "");
    return trimmed === "" ? body : `${trimmed}\n\n${body}`;
  }
  let end = lines.findIndex((l, i) => i > start && l.startsWith("## "));
  if (end === -1) end = lines.length;
  const before = lines.slice(0, start).join("\n");
  const after = lines.slice(end).join("\n");
  return `${before}${start > 0 ? "\n" : ""}${body}${after ? `\n${after}` : ""}`;
}

export function sectionDigest(section: string): string {
  return crypto.createHash("sha256").update(section).digest("hex");
}

export interface FleetLinksSnapshot {
  repos: Repo[];
  links: FleetLink[];
}

/** The scan walks every clone; doc-maintainer runs for every repo in one tick share one scan. */
const FLEET_LINKS_TTL_MS = 30 * 60 * 1000;
let fleetCache: { fetchedAt: number; value: FleetLinksSnapshot } | null = null;
let fleetInflight: Promise<FleetLinksSnapshot> | null = null;

/**
 * Cached fleet scan over the managed repo list. Throws when the repo list is
 * degraded — a repo missing from it would silently drop real links.
 */
export async function getFleetLinks(): Promise<FleetLinksSnapshot> {
  if (fleetCache && Date.now() - fleetCache.fetchedAt < FLEET_LINKS_TTL_MS) return fleetCache.value;
  if (fleetInflight) return fleetInflight;
  fleetInflight = (async () => {
    const repos = await gh.listRepos();
    if (gh.isRepoListDegraded()) throw new Error("managed repo list is degraded; refusing to compute cross-repo links from a partial fleet");
    const links = await scanFleetLinks(repos);
    const value = { repos, links };
    fleetCache = { fetchedAt: Date.now(), value };
    return value;
  })().finally(() => {
    fleetInflight = null;
  });
  return fleetInflight;
}

/** Exposed for tests. */
export function _resetFleetLinksCacheForTests(): void {
  fleetCache = null;
  fleetInflight = null;
}
