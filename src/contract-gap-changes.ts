/**
 * The Known gaps items a branch accepts or defers: what the issue worker
 * names in a PR's description and the PR reviewer calls out in its review,
 * so accepting a gap is visible at approval time.
 */
import fs from "node:fs";
import path from "node:path";
import * as claude from "./claude.js";
import { contractRequirementsWaived } from "./contract-status.js";
import { parseKnownGaps } from "./observability-contract.js";

export interface GapAcceptanceChange {
  /** Repo-relative path of the Markdown file listing the gap. */
  path: string;
  /** The item's text as the head lists it. */
  text: string;
  state: "accepted" | "deferred";
  /** Contract-level requirements the item waives under either contract, if any. */
  waives: string[];
}

const normalise = (text: string): string => text.replace(/\s+/g, " ").trim();

/**
 * Known gaps items in the changed `.md` files of `wtPath`'s HEAD, against the
 * merge base with `baseRef`, that are accepted or carry a deferral and whose
 * text the base does not list: an added item, or a reworded one. A file new
 * on the branch counts every such item. Each comes with the requirements it
 * waives under the observability or security contract.
 */
export async function gapAcceptanceChanges(wtPath: string, baseRef: string): Promise<GapAcceptanceChange[]> {
  const base = (await claude.git(["merge-base", baseRef, "HEAD"], wtPath, { maxRetries: 0 })).trim();
  const names = (await claude.git(["diff", "--name-only", `${base}...HEAD`], wtPath, { maxRetries: 0 }))
    .split("\n")
    .map((n) => n.trim())
    .filter((n) => n.toLowerCase().endsWith(".md"));
  const out: GapAcceptanceChange[] = [];
  for (const file of names) {
    let head: string;
    try {
      head = fs.readFileSync(path.join(wtPath, file), "utf8");
    } catch {
      continue; // deleted on the branch
    }
    const headGaps = (parseKnownGaps(head) ?? []).filter((g) => g.accepted || g.deferral);
    if (headGaps.length === 0) continue;
    let baseText = "";
    try {
      baseText = await claude.git(["show", `${base}:${file}`], wtPath, { maxRetries: 0 });
    } catch {
      baseText = ""; // new on the branch
    }
    const known = new Set((parseKnownGaps(baseText) ?? []).map((g) => normalise(g.text)));
    for (const g of headGaps) {
      if (known.has(normalise(g.text))) continue;
      const waives = [...new Set([...contractRequirementsWaived("observability", g.text), ...contractRequirementsWaived("security", g.text)])];
      out.push({ path: file, text: g.text, state: g.accepted ? "accepted" : "deferred", waives });
    }
  }
  return out;
}

/** One Markdown bullet per change: the item, its file, and a `Waives: …` suffix when it waives a requirement. */
export function formatGapChangeBullets(changes: readonly GapAcceptanceChange[]): string[] {
  return changes.map((c) => `- \`${c.path}\`: ${c.text}${c.waives.length > 0 ? ` — Waives: ${c.waives.join(", ")}` : ""}`);
}
