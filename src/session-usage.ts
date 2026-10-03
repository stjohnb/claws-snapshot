import fs from "node:fs";
import readline from "node:readline";
import { AUTO_COMPACT_MIN_CONTEXT_TOKENS, claudeProjectDir, findInteractiveTranscript } from "./session-auto-compact.js";

export type SessionUsageWarningLevel = "none" | "warn" | "critical";

export interface SessionUsageSnapshot {
  tokensUsed: number;
  costUsd: number | null;
  lastContextTokens: number;
  usageUpdatedAt: number | null;
  warningLevel: SessionUsageWarningLevel;
}

export interface ReadSessionUsageOptions {
  /** Directory holding `.claude` for this session. */
  claudeHome: string;
  cwd: string;
  sinceMs: number;
}

const CRITICAL_CONTEXT_TOKENS = 180_000;

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function record(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" ? v as Record<string, unknown> : {};
}

export function sessionUsageWarningLevel(lastContextTokens: number): SessionUsageWarningLevel {
  if (lastContextTokens >= CRITICAL_CONTEXT_TOKENS) return "critical";
  if (lastContextTokens >= AUTO_COMPACT_MIN_CONTEXT_TOKENS) return "warn";
  return "none";
}

function totalTokens(usage: Record<string, unknown>): number {
  const outputDetails = record(usage.output_tokens_details);
  const thinkingTokens = num(usage.thinking_tokens) || num(outputDetails.thinking_tokens);
  const reasoningTokens = num(usage.reasoning_tokens)
    || num(usage.reasoning_output_tokens)
    || num(outputDetails.reasoning_tokens)
    || num(outputDetails.reasoning_output_tokens);
  return num(usage.input_tokens)
    + num(usage.cache_creation_input_tokens)
    + num(usage.cache_read_input_tokens)
    + num(usage.output_tokens)
    + thinkingTokens
    + reasoningTokens;
}

function contextTokens(usage: Record<string, unknown>): number {
  return num(usage.input_tokens) + num(usage.cache_creation_input_tokens) + num(usage.cache_read_input_tokens);
}

function entryCost(entry: Record<string, unknown>, message: Record<string, unknown>, usage: Record<string, unknown>): number | null {
  for (const source of [usage, message, entry]) {
    for (const key of ["cost_usd", "total_cost_usd", "costUSD", "totalCostUsd"]) {
      const v = source[key];
      if (typeof v === "number" && Number.isFinite(v)) return v;
    }
  }
  return null;
}

function usageKey(entry: Record<string, unknown>, message: Record<string, unknown>): string {
  const requestId = typeof entry.requestId === "string" ? entry.requestId : typeof entry.request_id === "string" ? entry.request_id : "";
  const messageId = typeof message.id === "string" ? message.id : "";
  const block = typeof entry.apiBlockIndex === "number" || typeof entry.apiBlockIndex === "string" ? String(entry.apiBlockIndex) : "";
  if (requestId || messageId) return `message:${requestId}|${messageId}`;
  if (typeof entry.uuid === "string") return `uuid:${entry.uuid}`;
  if (block) return `block:${block}`;
  return "";
}

export async function parseSessionUsageTranscript(file: string): Promise<SessionUsageSnapshot> {
  const seen = new Set<string>();
  let tokensUsed = 0;
  let costUsd: number | null = null;
  let lastContextTokens = 0;
  let usageUpdatedAt: number | null = null;

  const input = fs.createReadStream(file, { encoding: "utf8" });
  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      if (!line.trim()) continue;
      let entry: Record<string, unknown>;
      try {
        const parsed = JSON.parse(line) as unknown;
        if (!parsed || typeof parsed !== "object") continue;
        entry = parsed as Record<string, unknown>;
      } catch {
        continue;
      }
      if (entry.type !== "assistant" || entry.isSidechain === true) continue;
      const message = entry.message;
      if (!message || typeof message !== "object") continue;
      const usage = (message as Record<string, unknown>).usage;
      if (!usage || typeof usage !== "object") continue;
      const key = usageKey(entry, message as Record<string, unknown>);
      if (key && seen.has(key)) continue;
      if (key) seen.add(key);

      const usageRecord = usage as Record<string, unknown>;
      tokensUsed += totalTokens(usageRecord);
      lastContextTokens = contextTokens(usageRecord);
      const cost = entryCost(entry, message as Record<string, unknown>, usageRecord);
      if (cost !== null) costUsd = (costUsd ?? 0) + cost;
      const at = typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : NaN;
      if (!Number.isNaN(at)) usageUpdatedAt = at;
    }
  } finally {
    rl.close();
  }

  return {
    tokensUsed,
    costUsd,
    lastContextTokens,
    usageUpdatedAt,
    warningLevel: sessionUsageWarningLevel(lastContextTokens),
  };
}

export async function readClaudeSessionUsage(opts: ReadSessionUsageOptions): Promise<SessionUsageSnapshot | null> {
  const transcript = await findInteractiveTranscript(claudeProjectDir(opts.claudeHome, opts.cwd), opts.sinceMs);
  return transcript ? parseSessionUsageTranscript(transcript) : null;
}
