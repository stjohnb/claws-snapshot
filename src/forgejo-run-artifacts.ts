/**
 * A Forgejo Actions run's artifacts for sessions and agents — the service side
 * of the `claws_forgejo_run_artifacts` and `claws_forgejo_download_artifact`
 * claws-state tools (#clw_01M8ET462MDX4K6FTQY252XHNG).
 *
 * Reads with the bot token through forgejo patch 0009 (a backport of upstream
 * v16+'s artifacts API), so no token reaches the caller. The list route takes
 * the run's global id, so the run is first looked up by its run number.
 */

import crypto from "node:crypto";
import { Transform, pipeline, type Readable } from "node:stream";
import {
  ForgejoArtifactEndpointUnavailableError,
  getActionRunByNumber,
  listActionRunArtifacts,
  openActionArtifactZip,
  type ForgejoActionArtifact,
} from "./forgejo.js";
import { ForgejoJobLogsError, resolveForgejoRepo } from "./forgejo-job-logs.js";
import { formatBytes } from "./format.js";

/** Largest artifact zip delivered into a session: 200 MB. */
export const FORGEJO_ARTIFACT_MAX_BYTES = 200 * 1024 * 1024;

export interface ForgejoRunArtifactsRequest {
  repo: string;
  /** The run number shown in the web URL (`/actions/runs/3`). */
  run: number;
}

export interface ForgejoRunArtifact {
  id: number;
  name: string;
  size_bytes: number;
  expired: boolean;
  created: string | null;
  expires: string | null;
}

export interface ForgejoRunArtifactsResult {
  repo: string;
  run: number;
  artifacts: ForgejoRunArtifact[];
}

/** A refusal of one artifact download, with the HTTP status the session route answers with. */
/** An unknown-name refusal's parts, so a caller can guard the run's artifact names before showing them to an agent. */
export interface UnknownArtifactRefusal {
  repo: string;
  run: number;
  requested: string;
  names: string[];
}

export class ForgejoArtifactError extends Error {
  constructor(readonly status: 404 | 409 | 413 | 502, message: string, readonly unknown?: UnknownArtifactRefusal) {
    super(message);
    this.name = "ForgejoArtifactError";
  }
}

/** The unknown-name refusal's message, listing the run's artifact names (raw CI output: guard them before an agent sees it). */
export function unknownArtifactMessage(r: UnknownArtifactRefusal): string {
  return `run ${r.run} of ${r.repo} has no artifact named "${r.requested}"; its artifacts are: ${r.names.length ? r.names.map((n) => `"${n}"`).join(", ") : "(none)"}`;
}

function toResult(a: ForgejoActionArtifact): ForgejoRunArtifact {
  return { id: a.id, name: a.name, size_bytes: a.sizeBytes, expired: a.expired, created: a.created, expires: a.expires };
}

/** The artifacts of a run, by repo and run number. Throws {@link ForgejoJobLogsError}. */
export async function fetchForgejoRunArtifacts(req: ForgejoRunArtifactsRequest): Promise<ForgejoRunArtifactsResult> {
  const repo = await resolveForgejoRepo(req.repo);
  let detail;
  try {
    detail = await getActionRunByNumber(repo, req.run);
  } catch (err) {
    throw new ForgejoJobLogsError(502, err instanceof Error ? err.message : String(err));
  }
  if (!detail) throw new ForgejoJobLogsError(404, `${repo} has no Actions run ${req.run}`);
  let artifacts;
  try {
    artifacts = await listActionRunArtifacts(repo, detail.id);
  } catch (err) {
    if (err instanceof ForgejoArtifactEndpointUnavailableError) {
      throw new ForgejoJobLogsError(502, "this Forgejo image lacks the artifacts API (forgejo patch 0009)");
    }
    throw new ForgejoJobLogsError(502, err instanceof Error ? err.message : String(err));
  }
  return { repo, run: req.run, artifacts: artifacts.map(toResult) };
}

export interface ForgejoRunArtifactDownloadRequest extends ForgejoRunArtifactsRequest {
  /** The artifact's exact name, as `fetchForgejoRunArtifacts` lists it. */
  name: string;
}

export interface ForgejoRunArtifactDownload {
  repo: string;
  run: number;
  artifact: ForgejoRunArtifact;
  /** The zip's bytes, erroring with a 413 {@link ForgejoArtifactError} past {@link FORGEJO_ARTIFACT_MAX_BYTES}. Consume or destroy it. */
  stream: Readable;
  /** True once the stream errored because the zip passed the cap. */
  readonly overCap: boolean;
  /** Byte count and sha256 of the zip, once the stream has ended; null before. */
  digest(): { size: number; sha256: string } | null;
}

function overCapMessage(name: string, size: number, more: boolean): string {
  return `artifact ${name} is ${more ? "over " : ""}${formatBytes(size)} (${size} bytes); the download cap is ${formatBytes(FORGEJO_ARTIFACT_MAX_BYTES)} (${FORGEJO_ARTIFACT_MAX_BYTES} bytes)`;
}

/**
 * Open one artifact's zip by exact name. Refuses an unknown name (listing the
 * run's raw names, also on the error's `unknown`), an expired artifact and one whose listed size is over the cap;
 * the returned stream also errors past the cap, since a v1–v3 artifact's zip can
 * exceed its listed size. Throws {@link ForgejoJobLogsError} for the run lookup
 * and {@link ForgejoArtifactError} for the artifact's refusals.
 */
export async function openForgejoRunArtifact(req: ForgejoRunArtifactDownloadRequest): Promise<ForgejoRunArtifactDownload> {
  const listed = await fetchForgejoRunArtifacts(req);
  const artifact = listed.artifacts.find((a) => a.name === req.name);
  if (!artifact) {
    const unknown = { repo: listed.repo, run: listed.run, requested: req.name, names: listed.artifacts.map((a) => a.name) };
    throw new ForgejoArtifactError(404, unknownArtifactMessage(unknown), unknown);
  }
  if (artifact.expired) throw new ForgejoArtifactError(409, `artifact ${artifact.name} of run ${listed.run} has expired${artifact.expires ? ` (${artifact.expires})` : ""} and can no longer be downloaded`);
  if (artifact.size_bytes > FORGEJO_ARTIFACT_MAX_BYTES) throw new ForgejoArtifactError(413, overCapMessage(artifact.name, artifact.size_bytes, false));

  let zip;
  try {
    zip = await openActionArtifactZip(listed.repo, artifact.id);
  } catch (err) {
    const status = (err as { status?: unknown }).status;
    if (status === 404) throw new ForgejoArtifactError(404, `artifact ${artifact.name} of run ${listed.run} is not downloadable (not upload-confirmed, or expired)`);
    throw new ForgejoArtifactError(502, err instanceof Error ? err.message : String(err));
  }
  if (zip.declaredLength !== null && zip.declaredLength > FORGEJO_ARTIFACT_MAX_BYTES) {
    zip.stream.destroy();
    throw new ForgejoArtifactError(413, overCapMessage(artifact.name, zip.declaredLength, false));
  }

  const hash = crypto.createHash("sha256");
  let total = 0;
  let overCap = false;
  let digest: { size: number; sha256: string } | null = null;
  const counter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      total += chunk.length;
      if (total > FORGEJO_ARTIFACT_MAX_BYTES) {
        overCap = true;
        cb(new ForgejoArtifactError(413, overCapMessage(artifact.name, FORGEJO_ARTIFACT_MAX_BYTES, true)));
        return;
      }
      hash.update(chunk);
      cb(null, chunk);
    },
    flush(cb) {
      digest = { size: total, sha256: hash.digest("hex") };
      cb();
    },
  });
  // pipeline destroys the Forgejo response when the counter fails or is destroyed, and vice versa.
  pipeline(zip.stream, counter, () => {});
  return {
    repo: listed.repo,
    run: listed.run,
    artifact,
    stream: counter,
    get overCap() { return overCap; },
    digest: () => digest,
  };
}
