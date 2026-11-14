/** Hidden machine marker the auto-merger appends to an operator-step Blocked reason. */
export const AWAITING_OPERATOR_MARKER = "claws-awaiting-operator";

/** A Blocked reason as people should read it: the bookkeeping marker line dropped, then trimmed. */
export function displayBlockedReason(reason: string): string {
  return reason
    .split("\n")
    .filter((line) => line.trim() !== AWAITING_OPERATOR_MARKER)
    .join("\n")
    .trim();
}

/** {@link displayBlockedReason} flattened to one plain line, with simple markdown syntax removed. */
export function plainBlockedReasonText(reason: string): string {
  return displayBlockedReason(reason)
    .split("\n")
    .map((line) =>
      line
        .replace(/\*\*|__|`/g, "")
        .replace(/^\s*#+\s*/, "")
        .replace(/^\s*[-*]\s+/, "")
        .trim(),
    )
    .filter((line) => line !== "")
    .join(" ");
}

/** How a Blocked reason Claws writes for an issue-link dependency park starts; a step dependency first reads `Depends on step N of #`. */
export const DEPENDENCY_PARK_PREFIX = "Depends on #";

/**
 * The Blocked reason for an issue parked on `targets`, the open issues it
 * depends on: one reads `Depends on #X — T, which is still open.`, several
 * `Depends on #A — T1 and #B — T2, which are still open.`. A target with a
 * `target_step` reads `step N of #X — T`.
 */
export function dependencyParkReason(targets: readonly { id: string; title: string; target_step?: number | null }[]): string {
  const named = targets.map((target) =>
    `${target.target_step != null ? `step ${target.target_step} of ` : ""}#${target.id} — ${target.title}`);
  const list = named.length <= 1
    ? named.join("")
    : `${named.slice(0, -1).join(", ")} and ${named[named.length - 1]}`;
  return `Depends on ${list}, which ${named.length === 1 ? "is" : "are"} still open.`;
}

/** Whether `reason` is one {@link dependencyParkReason} wrote. */
export function isDependencyParkReason(reason: string): boolean {
  const text = reason.trimStart();
  return text.startsWith(DEPENDENCY_PARK_PREFIX) || /^Depends on step \d+ of #/.test(text);
}
