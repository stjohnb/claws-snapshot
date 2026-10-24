import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  AUTO_COMPACT_MIN_CONTEXT_TOKENS,
  assessTranscript,
  claudeProjectDir,
  findInteractiveTranscript,
  maybeAutoCompact,
  shouldAutoCompact,
  type TranscriptAssessment,
} from "./session-auto-compact.js";

const MIN = 60_000;
const NOW = Date.parse("2026-09-15T12:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();

function userLine(at: number, entrypoint = "cli"): string {
  return JSON.stringify({ type: "user", entrypoint, timestamp: iso(at), message: { role: "user", content: "hi" } });
}

function assistantLine(at: number, opts: { stop?: string | null; tokens?: [number, number, number]; entrypoint?: string } = {}): string {
  const [input, creation, read] = opts.tokens ?? [2, 20_000, 100_000];
  return JSON.stringify({
    type: "assistant",
    entrypoint: opts.entrypoint ?? "cli",
    timestamp: iso(at),
    message: {
      role: "assistant",
      stop_reason: opts.stop === undefined ? "end_turn" : opts.stop,
      usage: { input_tokens: input, cache_creation_input_tokens: creation, cache_read_input_tokens: read, output_tokens: 500 },
    },
  });
}

const trailingMeta = [
  JSON.stringify({ type: "attachment", timestamp: iso(NOW - MIN) }),
  JSON.stringify({ type: "cost-state", timestamp: iso(NOW - MIN) }),
  JSON.stringify({ type: "last-prompt", lastPrompt: "hi" }),
];

function transcript(lines: string[]): string {
  return `${lines.join("\n")}\n`;
}

describe("claudeProjectDir", () => {
  it("replaces every non-alphanumeric character in cwd with -", () => {
    expect(claudeProjectDir("/home/brendan", "/home/brendan/.claws/repos/St-John-Software/claws"))
      .toBe("/home/brendan/.claude/projects/-home-brendan--claws-repos-St-John-Software-claws");
  });
});

describe("assessTranscript", () => {
  it("sums the three input usage fields and ignores trailing metadata lines", () => {
    const turnAt = NOW - 45 * MIN;
    const a = assessTranscript(transcript([userLine(turnAt - MIN), assistantLine(turnAt, { tokens: [3, 40_000, 70_000] }), "{not json", ...trailingMeta]));
    expect(a).toEqual({ lastTurnAt: turnAt, lastIsEndedAssistantTurn: true, contextTokens: 110_003, compactedSinceLastTurn: false });
  });

  it("detects a compact_boundary after the last assistant entry", () => {
    const a = assessTranscript(transcript([
      assistantLine(NOW - 50 * MIN),
      JSON.stringify({ type: "system", subtype: "compact_boundary", timestamp: iso(NOW - 49 * MIN) }),
    ]));
    expect(a.compactedSinceLastTurn).toBe(true);
  });
});

describe("shouldAutoCompact", () => {
  const eligible: TranscriptAssessment = { lastTurnAt: NOW - 31 * MIN, lastIsEndedAssistantTurn: true, contextTokens: 150_000, compactedSinceLastTurn: false };
  const opts = { idleMs: 30 * MIN, minTokens: AUTO_COMPACT_MIN_CONTEXT_TOKENS, nowMs: NOW, lastAttemptTurnAt: null };

  it("is true for a large, finished, idle, uncompacted turn", () => {
    expect(shouldAutoCompact(eligible, opts)).toBe(true);
  });

  it("is false under 100k tokens", () => {
    expect(shouldAutoCompact({ ...eligible, contextTokens: 99_999 }, opts)).toBe(false);
  });

  it("is false before the idle threshold", () => {
    expect(shouldAutoCompact({ ...eligible, lastTurnAt: NOW - 29 * MIN }, opts)).toBe(false);
  });

  it("is false when the last stop reason is tool_use or the last entry is a user message", () => {
    expect(shouldAutoCompact(assessTranscript(transcript([assistantLine(NOW - 40 * MIN, { stop: "tool_use" })])), opts)).toBe(false);
    expect(shouldAutoCompact(assessTranscript(transcript([assistantLine(NOW - 41 * MIN), userLine(NOW - 40 * MIN)])), opts)).toBe(false);
  });

  it("is false after a compact_boundary", () => {
    expect(shouldAutoCompact({ ...eligible, compactedSinceLastTurn: true }, opts)).toBe(false);
  });

  it("is false when this turn was already attempted", () => {
    expect(shouldAutoCompact(eligible, { ...opts, lastAttemptTurnAt: eligible.lastTurnAt })).toBe(false);
  });

  it("is false when disabled", () => {
    expect(shouldAutoCompact(eligible, { ...opts, idleMs: 0 })).toBe(false);
  });
});

describe("with transcripts on disk", () => {
  let home: string;
  const cwd = "/home/claws/work/org/app";
  let projectDir: string;

  function writeTranscript(name: string, lines: string[], mtimeMs = NOW): string {
    const file = path.join(projectDir, name);
    fs.writeFileSync(file, transcript(lines));
    fs.utimesSync(file, mtimeMs / 1000, mtimeMs / 1000);
    return file;
  }

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "claws-auto-compact-"));
    projectDir = claudeProjectDir(home, cwd);
    fs.mkdirSync(projectDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  describe("findInteractiveTranscript", () => {
    it("ignores sdk-cli transcripts and files older than sinceMs", async () => {
      const interactive = writeTranscript("a.jsonl", [userLine(NOW - 50 * MIN), assistantLine(NOW - 40 * MIN)], NOW - 40 * MIN);
      writeTranscript("headless.jsonl", [userLine(NOW - MIN, "sdk-cli"), assistantLine(NOW - MIN, { entrypoint: "sdk-cli" })], NOW - MIN);
      writeTranscript("old.jsonl", [userLine(NOW - 300 * MIN), assistantLine(NOW - 300 * MIN)], NOW - 300 * MIN);
      expect(await findInteractiveTranscript(projectDir, NOW - 120 * MIN)).toBe(interactive);
      expect(await findInteractiveTranscript(projectDir, NOW - 30 * MIN)).toBeNull();
      expect(await findInteractiveTranscript(path.join(home, "missing"), 0)).toBeNull();
    });
  });

  describe("maybeAutoCompact", () => {
    function fakeTmux(pane = "claude 0") {
      const calls: string[][] = [];
      const run = vi.fn(async (args: string[]) => {
        calls.push(args);
        return args[0] === "display-message" ? { code: 0, stdout: `${pane}\n` } : { code: 0, stdout: "" };
      });
      return { calls, run };
    }

    function run(tmux: ReturnType<typeof fakeTmux>, state = { lastAttemptTurnAt: null as number | null }) {
      const log = { info: vi.fn(), warn: vi.fn() };
      return {
        log,
        state,
        result: maybeAutoCompact({
          tmux: tmux.run,
          tmuxName: "claws-abc",
          claudeHome: home,
          cwd,
          sinceMs: NOW - 120 * MIN,
          idleMs: 30 * MIN,
          state,
          log,
          now: () => NOW,
        }),
      };
    }

    beforeEach(() => {
      writeTranscript("t.jsonl", [userLine(NOW - 46 * MIN), assistantLine(NOW - 45 * MIN), ...trailingMeta], NOW - MIN);
    });

    it("types /compact then Enter when every gate passes, once per turn", async () => {
      const tmux = fakeTmux();
      const first = run(tmux);
      expect(await first.result).toBe("compacted");
      expect(tmux.calls).toEqual([
        ["display-message", "-p", "-t", "=claws-abc:", "#{pane_current_command} #{pane_in_mode}"],
        ["send-keys", "-t", "=claws-abc:", "-l", "/compact"],
        ["send-keys", "-t", "=claws-abc:", "Enter"],
      ]);
      expect(first.log.info).toHaveBeenCalledWith("Auto-compacted idle session abc (120002 tokens, idle 45m)");
      expect(first.state.lastAttemptTurnAt).toBe(NOW - 45 * MIN);

      const again = fakeTmux();
      expect(await run(again, first.state).result).toBe("skipped");
      expect(again.calls).toEqual([]);
    });

    it("sends nothing when the pane is not running Claude or is in copy mode", async () => {
      for (const pane of ["zsh 0", "claude 1"]) {
        const tmux = fakeTmux(pane);
        const attempt = run(tmux);
        expect(await attempt.result).toBe("skipped");
        expect(tmux.calls.filter((c) => c[0] === "send-keys")).toEqual([]);
        expect(attempt.state.lastAttemptTurnAt).toBeNull();
      }
    });

    it("sends nothing while a subagent transcript is fresh", async () => {
      const subagents = path.join(projectDir, "t", "subagents");
      fs.mkdirSync(subagents, { recursive: true });
      const file = path.join(subagents, "agent-1.jsonl");
      fs.writeFileSync(file, "{}\n");
      fs.utimesSync(file, (NOW - 5 * MIN) / 1000, (NOW - 5 * MIN) / 1000);
      const tmux = fakeTmux();
      expect(await run(tmux).result).toBe("skipped");
      expect(tmux.calls).toEqual([]);
    });
  });
});
