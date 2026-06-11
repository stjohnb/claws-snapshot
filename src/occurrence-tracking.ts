import * as gh from "./github.js";
import * as log from "./log.js";

export function appendOccurrenceTracking(body: string, timestamp: string, initialCount = 1): string {
  const parts = body ? [body, "", "---"] : ["---"];
  return [
    ...parts,
    `**First seen:** ${timestamp}`,
    `**Last seen:** ${timestamp}`,
    `**Occurrences:** ${initialCount}`,
  ].join("\n");
}

export function updateOccurrenceTracking(body: string, timestamp: string): string {
  return body.replace(
    /\*\*First seen:\*\* (.+)\n\*\*Last seen:\*\* .+\n\*\*Occurrences:\*\* (\d+)$/,
    (_, firstSeen, count) =>
      [
        `**First seen:** ${firstSeen}`,
        `**Last seen:** ${timestamp}`,
        `**Occurrences:** ${parseInt(count, 10) + 1}`,
      ].join("\n"),
  );
}

export function applyOccurrenceTracking(
  currentBody: string,
  timestamp: string,
): { updatedBody: string; matched: boolean } {
  if (currentBody.includes("**First seen:**")) {
    const updated = updateOccurrenceTracking(currentBody, timestamp);
    return { updatedBody: updated, matched: updated !== currentBody };
  }
  // Retroactive — assume at least the 2nd occurrence (caller has just observed a recurrence)
  return { updatedBody: appendOccurrenceTracking(currentBody, timestamp, 2), matched: true };
}

export interface EnsureAlertIssueOptions {
  repo: string;
  title: string;
  body: string;
  labels?: string[];
  timestamp?: string;
  logPrefix: string;
}

export type EnsureAlertIssueOutcome = "created" | "updated" | "tracking-not-updated";

export interface EnsureAlertIssueResult {
  outcome: EnsureAlertIssueOutcome;
  issueNumber: number;
}

export async function ensureAlertIssue(opts: EnsureAlertIssueOptions): Promise<EnsureAlertIssueResult> {
  const timestamp = opts.timestamp ?? new Date().toISOString();
  const results = await gh.searchIssues(opts.repo, opts.title);
  const existing = results.find((r) => r.title === opts.title);

  if (!existing) {
    const issueNumber = await gh.createIssue(
      opts.repo,
      opts.title,
      appendOccurrenceTracking(opts.body, timestamp),
      opts.labels ?? [],
    );
    return { outcome: "created", issueNumber };
  }

  const currentBody = (await gh.getIssueBody(opts.repo, existing.number)) ?? "";
  const { updatedBody, matched } = applyOccurrenceTracking(currentBody, timestamp);
  if (!matched) {
    log.warn(`[${opts.logPrefix}] Could not update occurrence tracking for "${opts.title}"`);
    return { outcome: "tracking-not-updated", issueNumber: existing.number };
  }
  await gh.editIssue(opts.repo, existing.number, updatedBody);
  return { outcome: "updated", issueNumber: existing.number };
}
