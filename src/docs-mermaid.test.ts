// @vitest-environment jsdom
import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import mermaid from "mermaid";

const __dirname = dirname(fileURLToPath(import.meta.url));

function extractDiagrams(markdown: string): Array<{ num: number; code: string }> {
  return [...markdown.matchAll(/```mermaid\n([\s\S]*?)```/g)].map((m, i) => ({
    num: i + 1,
    code: m[1].trim(),
  }));
}

const archPath = join(__dirname, "../docs/ARCHITECTURE.md");
const content = readFileSync(archPath, "utf-8");
const diagrams = extractDiagrams(content);

describe("ARCHITECTURE.md Mermaid diagrams", () => {
  beforeAll(() => {
    mermaid.initialize({ startOnLoad: false });
  });

  it("has at least one Mermaid diagram", () => {
    expect(diagrams.length).toBeGreaterThan(0);
  });

  for (const { num, code } of diagrams) {
    it(`diagram ${num} is valid Mermaid`, async () => {
      const result = await mermaid.parse(code);
      expect(result).toBeTruthy();
    });
  }
});
