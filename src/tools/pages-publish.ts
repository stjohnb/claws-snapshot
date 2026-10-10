#!/usr/bin/env node
/**
 * Publish a local directory to the fleet pages host
 * (#clw_01M3J52H0H9WSH3GTSY87ZY351). Run by a session granted the `pages`
 * capability, which sets `CLAWS_PAGES_PUBLISH` to this script's path:
 *
 *   node "$CLAWS_PAGES_PUBLISH" --repo NAME --kind pr|issue|docs --ref REF [--sha SHA] DIR
 *
 * Uploads DIR to `<repo>/<kind>/<ref>/<sha8>/` over the S3 API, then deletes
 * every other SHA under `<repo>/<kind>/<ref>/`, and prints the published URL
 * as its last stdout line. DIR must have an `index.html` at its root, because
 * the pages host does not list directories. Any upload failure aborts before
 * the delete, so a previous publish is never removed after a failed one.
 *
 * Uses console.*, not src/log.ts: this runs inside a session, not the service.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { PagesS3Client, contentTypeFor } from "../pages-s3.js";
import { mapWithConcurrency } from "../util.js";

export const PAGES_KINDS = ["pr", "issue", "docs"] as const;
export type PagesKind = (typeof PAGES_KINDS)[number];

const USAGE = "usage: node pages-publish.js --repo <name> --kind <pr|issue|docs> --ref <ref> [--sha <sha>] <dir>";
const UPLOAD_CONCURRENCY = 8;

/** A failure with the exit code the CLI reports it with: 2 for usage/env, 1 otherwise. */
export class PublishError extends Error {
  constructor(message: string, readonly exitCode: 1 | 2) {
    super(message);
  }
}

export interface PublishOptions {
  repo: string;
  kind: PagesKind;
  ref: string;
  /** 8 lowercase hex characters. */
  sha8: string;
  dir: string;
  /** Public web root, no trailing slash. */
  baseUrl: string;
}

/** The S3 operations a publish needs; `PagesS3Client` in production. */
export type PagesStore = Pick<PagesS3Client, "putObject" | "listKeys" | "deleteObject">;

/** Lowercase, owner stripped, `^[a-z0-9._-]+$`. */
export function normaliseRepo(repo: string): string {
  const name = (repo.includes("/") ? repo.slice(repo.lastIndexOf("/") + 1) : repo).toLowerCase();
  if (!/^[a-z0-9._-]+$/.test(name) || name === "." || name === "..") {
    throw new PublishError(`invalid --repo ${JSON.stringify(repo)}: expected a repository name`, 2);
  }
  return name;
}

/** `/` turned into `-`, then `^[A-Za-z0-9._-]+$`. */
export function normaliseRef(ref: string): string {
  const out = ref.replaceAll("/", "-");
  if (!/^[A-Za-z0-9._-]+$/.test(out) || out === "." || out === "..") {
    throw new PublishError(`invalid --ref ${JSON.stringify(ref)}: use pr-<N>, the issue id, or a branch name`, 2);
  }
  return out;
}

export function parseKind(kind: string): PagesKind {
  if (!(PAGES_KINDS as readonly string[]).includes(kind)) {
    throw new PublishError(`invalid --kind ${JSON.stringify(kind)}: expected one of ${PAGES_KINDS.join(", ")}`, 2);
  }
  return kind as PagesKind;
}

/** First 8 characters of a full 40-hex SHA, lowercased. */
export function sha8Of(sha: string): string {
  const s = sha.trim();
  if (!/^[0-9a-fA-F]{40}$/.test(s)) throw new PublishError(`invalid SHA ${JSON.stringify(s)}: expected 40 hex characters`, 2);
  return s.slice(0, 8).toLowerCase();
}

/** Regular files under `dir`, as `/`-separated paths relative to it. Symlinks and `.git` are skipped. */
export function listFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (rel: string): void => {
    for (const entry of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      const child = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (entry.name !== ".git") walk(child);
      } else if (entry.isFile()) {
        out.push(child);
      }
    }
  };
  walk("");
  return out.sort();
}

/**
 * Upload `opts.dir` to `<repo>/<kind>/<ref>/<sha8>/`, then delete every other
 * key under `<repo>/<kind>/<ref>/`. Returns the published URL.
 */
export async function publishDirectory(
  store: PagesStore,
  opts: PublishOptions,
): Promise<{ url: string; uploaded: number; deleted: number }> {
  const index = path.join(opts.dir, "index.html");
  const stat = fs.lstatSync(index, { throwIfNoEntry: false });
  if (!stat?.isFile()) {
    throw new PublishError(`no index.html at the root of ${opts.dir}; the pages host cannot list directories`, 1);
  }

  const refPrefix = `${opts.repo}/${opts.kind}/${opts.ref}/`;
  const shaPrefix = `${refPrefix}${opts.sha8}/`;
  const files = listFiles(opts.dir);
  await mapWithConcurrency(files, UPLOAD_CONCURRENCY, async (rel) => {
    const body = fs.readFileSync(path.join(opts.dir, rel));
    await store.putObject(`${shaPrefix}${rel}`, body, contentTypeFor(rel));
  });

  const stale = (await store.listKeys(refPrefix)).filter((k) => k.startsWith(refPrefix) && !k.startsWith(shaPrefix));
  await mapWithConcurrency(stale, UPLOAD_CONCURRENCY, (k) => store.deleteObject(k));

  return { url: `${opts.baseUrl}/${shaPrefix}`, uploaded: files.length, deleted: stale.length };
}

const ENV_KEYS = [
  "CLAWS_PAGES_S3_ENDPOINT",
  "CLAWS_PAGES_S3_REGION",
  "CLAWS_PAGES_S3_BUCKET",
  "CLAWS_PAGES_S3_ACCESS_KEY_ID",
  "CLAWS_PAGES_S3_SECRET_ACCESS_KEY",
  "CLAWS_PAGES_BASE_URL",
] as const;

async function main(argv: string[]): Promise<void> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      options: {
        repo: { type: "string" },
        kind: { type: "string" },
        ref: { type: "string" },
        sha: { type: "string" },
      },
      allowPositionals: true,
    });
  } catch (err) {
    throw new PublishError(`${err instanceof Error ? err.message : String(err)}\n${USAGE}`, 2);
  }
  const { values, positionals } = parsed;
  if (!values.repo || !values.kind || !values.ref || positionals.length !== 1) throw new PublishError(USAGE, 2);

  const env = Object.fromEntries(ENV_KEYS.map((k) => [k, (process.env[k] ?? "").trim()])) as Record<(typeof ENV_KEYS)[number], string>;
  const missing = ENV_KEYS.filter((k) => !env[k]);
  if (missing.length > 0) {
    throw new PublishError(`missing ${missing.join(", ")}; this session needs the pages capability`, 2);
  }

  const dir = path.resolve(positionals[0]!);
  const repo = normaliseRepo(values.repo);
  const kind = parseKind(values.kind);
  const ref = normaliseRef(values.ref);
  let sha = values.sha;
  if (!sha) {
    try {
      sha = execFileSync("git", ["-C", dir, "rev-parse", "HEAD"], { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      throw new PublishError(`${dir} is not in a git checkout; pass --sha`, 2);
    }
  }
  const sha8 = sha8Of(sha);

  const client = new PagesS3Client({
    endpoint: env.CLAWS_PAGES_S3_ENDPOINT,
    region: env.CLAWS_PAGES_S3_REGION,
    bucket: env.CLAWS_PAGES_S3_BUCKET,
    accessKeyId: env.CLAWS_PAGES_S3_ACCESS_KEY_ID,
    secretAccessKey: env.CLAWS_PAGES_S3_SECRET_ACCESS_KEY,
  });
  const result = await publishDirectory(client, {
    repo, kind, ref, sha8, dir, baseUrl: env.CLAWS_PAGES_BASE_URL.replace(/\/+$/, ""),
  });
  console.error(`uploaded ${result.uploaded} files, removed ${result.deleted} stale objects`);
  console.log(result.url);
}

function isEntryPoint(): boolean {
  const script = process.argv[1];
  if (!script) return false;
  try {
    return import.meta.url === pathToFileURL(fs.realpathSync(script)).href;
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  main(process.argv.slice(2)).catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(err instanceof PublishError ? err.exitCode : 1);
  });
}
