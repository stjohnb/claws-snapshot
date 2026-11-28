import { describe, expect, it } from "vitest";
import { classifyClaudeScreen, parseClaudePrompt, parseClaudeSuggestion, samePrompt, screenTail, stripAnsi } from "./claude-screen-state.js";

const screen = (...lines: string[]): string => lines.join("\r\n") + "\r\n";

describe("classifyClaudeScreen", () => {
  it("reads a permission prompt's numbered menu as waiting, through SGR colours", () => {
    const text = screen(
      "\x1b[1mBash command\x1b[0m",
      "  npm test",
      "\x1b[38;5;214mDo you want to proceed?\x1b[39m",
      "\x1b[36m❯\x1b[39m 1. Yes",
      "  2. No, and tell Claude what to do differently (esc)",
    );
    expect(classifyClaudeScreen(text)).toBe("waiting");
  });

  it("reads the cursor on any numbered menu option inside the prompt box as waiting", () => {
    expect(classifyClaudeScreen(screen("╭────╮", "│ Do you want to make this edit?", "│   1. Yes", "│ ❯ 2. No", "╰────╯"))).toBe("waiting");
  });

  it("does not read Claude's own prose asking a question as waiting", () => {
    const text = screen(
      "● The migration is ready. Do you want to proceed?",
      "  Would you like to proceed with the merge?",
      "╭────╮",
      "│ >  │",
      "╰────╯",
      "  ? for shortcuts",
    );
    expect(classifyClaudeScreen(text)).toBe("idle");
  });

  it("reads \"esc to interrupt\" as busy, case-insensitively", () => {
    expect(classifyClaudeScreen(screen("✻ Thinking… (12s · Esc to interrupt)", "> "))).toBe("busy");
    expect(classifyClaudeScreen(screen("\x1b[2m· Running… (esc to interrupt)\x1b[0m"))).toBe("busy");
  });

  it("reads an input box with nothing pending as idle", () => {
    expect(classifyClaudeScreen(screen("● Done.", "╭────╮", "│ >  │", "╰────╯", "  ? for shortcuts"))).toBe("idle");
    expect(classifyClaudeScreen("")).toBe("idle");
  });

  it("only looks at the bottom 20 lines, ignoring trailing blank lines", () => {
    const old = ["Do you want to proceed?", "❯ 1. Yes"];
    const filler = Array.from({ length: 20 }, (_, i) => "line " + i);
    expect(classifyClaudeScreen(screen(...old, ...filler))).toBe("idle");
    expect(classifyClaudeScreen(screen(...old, ...filler.slice(0, 5), "", "", ""))).toBe("waiting");
    expect(screenTail(screen(...filler, "", "  "))).toHaveLength(20);
  });

  it("strips CSI and OSC sequences", () => {
    expect(stripAnsi("\x1b]0;title\x07\x1b[?25l\x1b[1;32mok\x1b[0m")).toBe("ok");
  });
});

describe("parseClaudePrompt", () => {
  it("parses a boxed permission prompt through SGR colours", () => {
    const text = screen(
      "╭──────────────────────────────╮",
      "│ \x1b[1mBash command\x1b[0m                 │",
      "│                              │",
      "│   npm test                   │",
      "│                              │",
      "│ Do you want to proceed?      │",
      "│ \x1b[36m❯\x1b[39m 1. Yes                     │",
      "│   2. Yes, and don't ask again for npm test commands │",
      "│   3. No, and tell Claude what to do differently (esc) │",
      "╰──────────────────────────────╯",
    );
    expect(parseClaudePrompt(text)).toEqual({
      context: ["Bash command", "npm test", "Do you want to proceed?"],
      question: "Do you want to proceed?",
      options: [
        { n: 1, label: "Yes" },
        { n: 2, label: "Yes, and don't ask again for npm test commands" },
        { n: 3, label: "No, and tell Claude what to do differently (esc)" },
      ],
    });
  });

  it("parses a multi-option question, skipping option descriptions, with the cursor on a later option", () => {
    const text = screen(
      "● Earlier output",
      "  1. not part of the menu",
      "────────────────────────────────",
      " ☐ Approach",
      "",
      "Which storage backend should we use?",
      "",
      "  1. Postgres",
      "     The production database",
      "❯ 2. SQLite",
      "     Simple, file-based",
      "  3. Type something.",
      "",
      "Enter to select · ↑/↓ to navigate · Esc to cancel",
    );
    expect(parseClaudePrompt(text)).toEqual({
      context: ["☐ Approach", "Which storage backend should we use?"],
      question: "Which storage backend should we use?",
      options: [{ n: 1, label: "Postgres" }, { n: 2, label: "SQLite" }, { n: 3, label: "Type something." }],
    });
  });

  it("returns null for a screen with no menu cursor", () => {
    expect(parseClaudePrompt(screen("● Steps:", "  1. Build", "  2. Test", "╭────╮", "│ >  │", "╰────╯"))).toBeNull();
    expect(parseClaudePrompt(screen("✻ Thinking… (esc to interrupt)"))).toBeNull();
    expect(parseClaudePrompt("")).toBeNull();
  });

  it("compares prompts by question and options", () => {
    const a = parseClaudePrompt(screen("Proceed?", "❯ 1. Yes", "  2. No"));
    expect(samePrompt(a, parseClaudePrompt(screen("Proceed?", "  1. Yes", "❯ 2. No")))).toBe(true);
    expect(samePrompt(a, parseClaudePrompt(screen("Proceed now?", "❯ 1. Yes", "  2. No")))).toBe(false);
    expect(samePrompt(a, null)).toBe(false);
  });

  it("tells apart two prompts with the same question and options for different commands", () => {
    const bash = (command: string) => parseClaudePrompt(screen(
      "● Running it now.",
      "",
      "────────────────────────────────",
      " Bash command",
      "",
      "   " + command,
      "   Remove build output",
      "",
      " Do you want to proceed?",
      " ❯ 1. Yes",
      "   2. Yes, and don't ask again for rm commands in /repo",
      "   3. No, and tell Claude what to do differently (esc)",
    ));
    const a = bash("npm test");
    const b = bash("rm -rf dist");
    expect(a!.context).toEqual(["Bash command", "npm test", "Remove build output", "Do you want to proceed?"]);
    expect(b!.context).toEqual(["Bash command", "rm -rf dist", "Remove build output", "Do you want to proceed?"]);
    expect(b!.question).toBe(a!.question);
    expect(b!.options).toEqual(a!.options);
    expect(samePrompt(a, b)).toBe(false);
    expect(samePrompt(a, bash("npm test"))).toBe(true);
  });

  it("stops a prompt drawn without a rule at the nearest transcript line or the top of the screen", () => {
    expect(parseClaudePrompt(screen("● Done.", "  ⎿  ok", "Bash command", "", "  ls", "", "Proceed?", "❯ 1. Yes", "  2. No"))!.context)
      .toEqual(["Bash command", "ls", "Proceed?"]);
    expect(parseClaudePrompt(screen("Edit file", "", "Proceed?", "❯ 1. Yes"))!.context).toEqual(["Edit file", "Proceed?"]);
  });

  it("keeps an edit prompt's file path when its diff runs above the bottom screen lines", () => {
    const edit = (path: string) => parseClaudePrompt(screen(
      "────────────────────────────────",
      " Edit file",
      " " + path,
      ...Array.from({ length: 25 }, (_, i) => `  ${i + 1} + line ${i}`),
      "  }",
      "",
      " Do you want to make this edit?",
      " ❯ 1. Yes",
      "   2. No",
    ));
    const a = edit("src/a.ts");
    expect(a!.context.slice(0, 2)).toEqual(["Edit file", "src/a.ts"]);
    expect(samePrompt(a, edit("src/b.ts"))).toBe(false);
  });
});

describe("parseClaudeSuggestion", () => {
  const RULE = "\x1b[38;5;244m────────────────────────────────\x1b[39m";
  const input = (...lines: string[]): string => screen("● Done.", "", RULE, ...lines, RULE, "  \x1b[2m? for shortcuts\x1b[22m");

  it("returns null when the closing rule is not visible", () => {
    expect(parseClaudeSuggestion(screen("● Done.", "", RULE, "❯ \x1b[2mrun tests\x1b[22m", "  \x1b[2m? for shortcuts\x1b[22m"))).toBeNull();
  });

  it("reads a dim suggestion with an inverse cursor cell", () => {
    expect(parseClaudeSuggestion(input("❯ \x1b[7mR\x1b[27m\x1b[2mun the tests again\x1b[22m"))).toBe("Run the tests again");
  });

  it("reads grey 256-colour and equal-channel truecolour text as a suggestion", () => {
    expect(parseClaudeSuggestion(input("> \x1b[90mcommit this\x1b[39m"))).toBe("commit this");
    expect(parseClaudeSuggestion(input("❯ \x1b[38;5;245mship it\x1b[0m"))).toBe("ship it");
    expect(parseClaudeSuggestion(input("❯ \x1b[38;2;128;128;128mopen a PR\x1b[0m"))).toBe("open a PR");
  });

  it("joins a wrapped suggestion's lines with a space", () => {
    expect(parseClaudeSuggestion(input("❯ \x1b[2mfix the failing test in\x1b[22m", "  \x1b[2msrc/a.ts\x1b[22m"))).toBe("fix the failing test in src/a.ts");
  });

  it("is null for typed text, an empty box and the start-up hint", () => {
    expect(parseClaudeSuggestion(input("❯ hello\x1b[7m \x1b[27m"))).toBeNull();
    expect(parseClaudeSuggestion(input("❯ \x1b[2mhalf\x1b[22m typed"))).toBeNull();
    expect(parseClaudeSuggestion(input("❯ \x1b[7m \x1b[27m"))).toBeNull();
    expect(parseClaudeSuggestion(input("❯"))).toBeNull();
    expect(parseClaudeSuggestion(input("❯ \x1b[2mTry \"fix lint errors\"\x1b[22m"))).toBeNull();
  });

  it("is null while Claude is busy or a menu prompt is up", () => {
    expect(parseClaudeSuggestion(screen("✻ Thinking… (esc to interrupt)", RULE, "❯ \x1b[2mrun tests\x1b[22m", RULE))).toBeNull();
    expect(parseClaudeSuggestion(screen("Do you want to proceed?", RULE, "❯ 1. Yes", "  2. No", RULE))).toBeNull();
  });

  it("is null when the prompt line is not under a rule", () => {
    expect(parseClaudeSuggestion(screen("● Done.", "❯ \x1b[2mrun tests\x1b[22m"))).toBeNull();
  });

  it("reads a dim suggestion wrapped onto a second line, style carried across lines by tmux", () => {
    const R = "────────────────────────────────";
    expect(parseClaudeSuggestion(screen("● Done.", R, "\x1b[39m❯ \x1b[7mf\x1b[0;2m\x1b[39m\x1b[49mix the failing", "  test in src/a.ts", R, "  ? for shortcuts")))
      .toBe("fix the failing test in src/a.ts");
  });

  it("does not read typed text on a wrapped line as part of a suggestion", () => {
    expect(parseClaudeSuggestion(input("❯ \x1b[2mhalf\x1b[0m", "  typed"))).toBeNull();
  });

  it("does not let a dim rule above the input box make typed text read as a suggestion", () => {
    const dimRule = "\x1b[2m────────────────────────────────";
    expect(parseClaudeSuggestion(screen("● Done.", dimRule, "\x1b[0m❯ hello", "────────────────────────────────", "  ? for shortcuts"))).toBeNull();
  });
});
