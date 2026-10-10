import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseSessionUsageTranscript, sessionUsageWarningLevel } from "./session-usage.js";

const dirs: string[] = [];

async function transcript(lines: string[]): Promise<string> {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "claws-session-usage-"));
  dirs.push(dir);
  const file = path.join(dir, "session.jsonl");
  await fs.promises.writeFile(file, lines.join("\n") + "\n", "utf8");
  return file;
}

afterEach(async () => {
  for (const dir of dirs.splice(0)) await fs.promises.rm(dir, { recursive: true, force: true });
});

function assistant(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: "assistant",
    timestamp: "2026-09-17T12:00:00.000Z",
    requestId: "req-1",
    apiBlockIndex: 0,
    message: {
      id: "msg-1",
      usage: {
        input_tokens: 10,
        cache_creation_input_tokens: 20,
        cache_read_input_tokens: 30,
        output_tokens: 40,
        thinking_tokens: 5,
      },
      cost_usd: 0.12,
    },
    ...overrides,
  });
}

describe("session usage parser", () => {
  it("dedupes repeated assistant usage entries by stable request/message identity", async () => {
    const file = await transcript([assistant(), assistant()]);
    const snap = await parseSessionUsageTranscript(file);
    expect(snap.tokensUsed).toBe(105);
    expect(snap.costUsd).toBeCloseTo(0.12);
    expect(snap.lastContextTokens).toBe(60);
  });

  it("dedupes Claude content-block repeats with the same request and message", async () => {
    const file = await transcript([
      assistant({ apiBlockIndex: 0 }),
      assistant({ apiBlockIndex: 1 }),
      assistant({ apiBlockIndex: 2 }),
    ]);
    const snap = await parseSessionUsageTranscript(file);
    expect(snap.tokensUsed).toBe(105);
    expect(snap.costUsd).toBeCloseTo(0.12);
  });

  it("counts Claude nested output token details", async () => {
    const file = await transcript([
      assistant({
        message: {
          id: "msg-details",
          usage: {
            input_tokens: 10,
            cache_creation_input_tokens: 20,
            cache_read_input_tokens: 30,
            output_tokens: 40,
            output_tokens_details: { thinking_tokens: 5 },
          },
        },
      }),
    ]);
    const snap = await parseSessionUsageTranscript(file);
    expect(snap.tokensUsed).toBe(105);
    expect(snap.lastContextTokens).toBe(60);
  });

  it("counts provider reasoning token details", async () => {
    const file = await transcript([
      assistant({
        message: {
          id: "msg-reasoning-details",
          usage: {
            input_tokens: 10,
            output_tokens: 40,
            output_tokens_details: { reasoning_tokens: 7 },
          },
        },
      }),
    ]);
    const snap = await parseSessionUsageTranscript(file);
    expect(snap.tokensUsed).toBe(57);
  });

  it("keeps cost unknown when no transcript cost field exists", async () => {
    const file = await transcript([
      assistant({ requestId: "req-2", message: { id: "msg-2", usage: { input_tokens: 1, output_tokens: 2 } } }),
    ]);
    const snap = await parseSessionUsageTranscript(file);
    expect(snap.tokensUsed).toBe(3);
    expect(snap.costUsd).toBeNull();
  });

  it("skips malformed JSONL lines and sidechain entries", async () => {
    const file = await transcript([
      "{not-json",
      assistant({ isSidechain: true }),
      assistant({ requestId: "req-3", message: { id: "msg-3", usage: { input_tokens: 2, cache_read_input_tokens: 3 } } }),
    ]);
    const snap = await parseSessionUsageTranscript(file);
    expect(snap.tokensUsed).toBe(5);
    expect(snap.lastContextTokens).toBe(5);
  });

  it("classifies context warning thresholds", () => {
    expect(sessionUsageWarningLevel(99_999)).toBe("none");
    expect(sessionUsageWarningLevel(100_000)).toBe("warn");
    expect(sessionUsageWarningLevel(180_000)).toBe("critical");
  });
});
