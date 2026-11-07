/**
 * Deterministic security drift checks: each compares one kind of claim a
 * repo's security policy makes with its workflows and `.vex/` files. A check
 * fires only on a claim the policy makes, so a policy that says nothing about
 * SHA pinning is never checked for it. Every finding is keyed by its file, so
 * a Known gaps item, accepted or not, that names the file in backticks drops
 * it (`suppressListed`): the gap already tracks it. No rule reads anything
 * outside the repo, so none returns `unavailable`.
 */
import fs from "node:fs";
import path from "node:path";
import { runDriftRules, suppressListed, type DriftFinding, type DriftRule } from "./contract-drift.js";
import { parseKnownGaps } from "./observability-contract.js";
import { policyClaimsImagePublish, validateVexDocument } from "./security-contract.js";

/** One place the security policy and the repo disagree; `file` is repo-relative. */
export type DriftItem = DriftFinding & { file: string };

const WORKFLOW_DIR = ".forgejo/workflows";
const VEX_DIR = ".vex";

/** A line that pushes an image. A bare registry hostname is not a push: it may be a pull. */
const PUSH_VERB = /\b(docker|podman|buildah)\s+push\b|--push\b|\bpush:\s*true\b/;
/** A line that runs an image scanner. */
const SCAN_LINE = /\btrivy\b|\bgrype\b|scripts\/ci\/[\w.-]*scan[\w.-]*\.sh/;
const SHA_PIN_CLAIM = /pinn?ed (to )?(a |full |commit )?(sha|commit)|SHA-pinned/i;
const USES = /^\s*-?\s*uses:\s*["']?([^"'\s#]+)/;
const FULL_SHA = /@[0-9a-f]{40}$/;

/** A policy sentence denying an image push ("publishes no container image", "does not push an image"). */
const NO_IMAGE_CLAIM =
  /\b(publish(es)?|push(es)?|ships?) no (container |docker |oci )?images?\b|\b(does not|doesn't|never) (publish|push|ship)\b[^.\n]*\bimages?\b|\bno container image\b/i;

function readText(file: string): string | null {
  try {
    return fs.readFileSync(file, "utf-8");
  } catch {
    return null;
  }
}

function listDir(dir: string, match: RegExp): string[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && match.test(e.name))
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

interface WorkflowFile {
  /** Repo-relative path. */
  file: string;
  /** Lines with full-line comments blanked, so a comment never counts as a push or a scan. */
  lines: string[];
}

function workflows(repoDir: string): WorkflowFile[] {
  const out: WorkflowFile[] = [];
  for (const name of listDir(path.join(repoDir, WORKFLOW_DIR), /\.ya?ml$/)) {
    const text = readText(path.join(repoDir, WORKFLOW_DIR, name));
    if (text === null) continue;
    out.push({
      file: `${WORKFLOW_DIR}/${name}`,
      lines: text.split("\n").map((l) => (/^\s*#/.test(l) ? "" : l)),
    });
  }
  return out;
}

/** Index of the first push line, or -1. */
function firstPush(wf: WorkflowFile): number {
  return wf.lines.findIndex((l) => PUSH_VERB.test(l));
}

/** The policy's Supply chain subsection (heading to next heading of the same or higher level), or "". */
function supplyChainSection(policy: string): string {
  const lines = policy.split("\n");
  const start = lines.findIndex((l) => /^#{2,6}\s+.*\bsupply[- ]chain\b/i.test(l));
  if (start < 0) return "";
  const level = lines[start]!.match(/^#+/)![0].length;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    const m = lines[i]!.match(/^(#{1,6})\s/);
    if (m && m[1]!.length <= level) {
      end = i;
      break;
    }
  }
  return lines.slice(start + 1, end).join("\n");
}

function imageGateDrift(policy: string, wfs: readonly WorkflowFile[]): DriftItem[] {
  if (!policyClaimsImagePublish(policy)) return [];
  const out: DriftItem[] = [];
  for (const wf of wfs) {
    for (let i = 0; i < wf.lines.length; i++) {
      if (!PUSH_VERB.test(wf.lines[i]!)) continue;
      if (wf.lines.slice(0, i).some((l) => SCAN_LINE.test(l))) continue;
      out.push({
        rule: "image-gate",
        key: wf.file,
        file: wf.file,
        line: i + 1,
        message: "the policy says the repo publishes a container image behind a scan gate, but this workflow pushes an image with no trivy, grype or `scripts/ci/*scan*.sh` step earlier in the file.",
      });
      break;
    }
  }
  return out;
}

function undeclaredImageDrift(policy: string, wfs: readonly WorkflowFile[]): DriftItem[] {
  if (policyClaimsImagePublish(policy) || !NO_IMAGE_CLAIM.test(policy)) return [];
  const out: DriftItem[] = [];
  for (const wf of wfs) {
    const i = firstPush(wf);
    if (i < 0) continue;
    out.push({
      rule: "undeclared-image",
      key: wf.file,
      file: wf.file,
      line: i + 1,
      message: "the policy says the repo publishes no container image, but this workflow pushes one.",
    });
  }
  return out;
}

function pinningDrift(policy: string, wfs: readonly WorkflowFile[]): DriftItem[] {
  if (!SHA_PIN_CLAIM.test(supplyChainSection(policy))) return [];
  const out: DriftItem[] = [];
  for (const wf of wfs) {
    for (let i = 0; i < wf.lines.length; i++) {
      const m = wf.lines[i]!.match(USES);
      if (!m) continue;
      const ref = m[1]!;
      if (ref.startsWith("./") || ref.startsWith("docker://") || FULL_SHA.test(ref)) continue;
      out.push({
        rule: "sha-pinning",
        key: wf.file,
        file: wf.file,
        line: i + 1,
        message: `the policy says CI actions are pinned to a full commit SHA, but \`${ref}\` is not.`,
      });
    }
  }
  return out;
}

function vexDrift(repoDir: string): DriftItem[] {
  const out: DriftItem[] = [];
  for (const name of listDir(path.join(repoDir, VEX_DIR), /\.json$/)) {
    const file = `${VEX_DIR}/${name}`;
    const text = readText(path.join(repoDir, file));
    let errors: string[];
    if (text === null) {
      errors = ["file is unreadable"];
    } else {
      try {
        errors = validateVexDocument(JSON.parse(text));
      } catch {
        errors = ["file is not valid JSON"];
      }
    }
    if (errors.length === 0) continue;
    out.push({
      rule: "vex",
      key: file,
      file,
      message: `the policy's accepted findings must be valid OpenVEX \`not_affected\` statements, but ${errors.join("; ")}.`,
    });
  }
  return out;
}

interface SecurityDriftContext {
  repoDir: string;
  policy: string;
  workflows: readonly WorkflowFile[];
}

/** The deterministic security drift rules, run in order. */
export const SECURITY_DRIFT_RULES: readonly DriftRule<SecurityDriftContext>[] = [
  { id: "image-gate", check: (c) => imageGateDrift(c.policy, c.workflows) },
  { id: "undeclared-image", check: (c) => undeclaredImageDrift(c.policy, c.workflows) },
  { id: "sha-pinning", check: (c) => pinningDrift(c.policy, c.workflows) },
  { id: "vex", check: (c) => vexDrift(c.repoDir) },
];

/**
 * The places `policyText` (the repo's security policy) disagrees with the
 * repo at `repoDir`: an image push with no earlier scan when the policy
 * claims an image; any image push when it says there is none; an unpinned
 * `uses:` when its Supply chain subsection claims SHA pinning; and every
 * invalid `.vex/*.json`. Items whose file a Known gaps item names in
 * backticks are dropped.
 */
export function detectSecurityDrift(repoDir: string, policyText: string): DriftItem[] {
  const ctx: SecurityDriftContext = { repoDir, policy: policyText, workflows: workflows(repoDir) };
  const { findings } = runDriftRules(SECURITY_DRIFT_RULES, ctx);
  return suppressListed(findings, parseKnownGaps(policyText) ?? []) as DriftItem[];
}
