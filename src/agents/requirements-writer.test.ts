import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { mockRepo, mockIssue } from "../test-helpers.js";

vi.mock("../log.js", () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }));
vi.mock("../prompt-guard.js", () => ({
  guardContent: (text: string) => text,
  makeGuardCtx: () => (source: string) => ({ source }),
}));

import { buildRequirementsPrompt, readRequirementsOutFile, recordFromVersion } from "./requirements-writer.js";

const RECORD = {
  title: "Add a thing",
  kind: "feature" as const,
  context: "People want it.",
  requirement: "The thing exists.",
  acceptanceCriteria: ["The thing is visible"],
  outOfScope: [],
};

describe("readRequirementsOutFile", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "claws-req-writer-"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("returns the saved record", () => {
    const file = path.join(dir, "requirements.json");
    fs.writeFileSync(file, JSON.stringify(RECORD));
    expect(readRequirementsOutFile(file)).toEqual(RECORD);
  });

  it("fails clearly when the agent never called the tool", () => {
    expect(() => readRequirementsOutFile(path.join(dir, "missing.json"))).toThrow(/without calling claws_save_requirements/);
  });

  it("fails when the saved record does not validate", () => {
    const file = path.join(dir, "requirements.json");
    fs.writeFileSync(file, JSON.stringify({ ...RECORD, acceptanceCriteria: [] }));
    expect(() => readRequirementsOutFile(file)).toThrow(/acceptanceCriteria/);
  });
});

describe("buildRequirementsPrompt", () => {
  const repo = mockRepo();
  const issue = mockIssue({ number: 7, title: "Thing please", body: "I want the thing." });
  const RECORD_COMMENT = { id: 100, login: "claws-bot", body_html: "", body: "*— Automated by Claws · Requirements writer —*\n\n## Requirements" };
  const HUMAN = { id: 101, login: "stjohnb", body_html: "", body: "Also on phones" };

  it("asks a write run for the record only, through the tool, and lists attachments", () => {
    const prompt = buildRequirementsPrompt(repo, issue, [], "claws-bot", ["shot.png"], { kind: "write" });
    expect(prompt).toContain("Thing please");
    expect(prompt).toContain("I want the thing.");
    expect(prompt).toContain("- shot.png");
    expect(prompt).toContain("`claws_save_requirements` tool exactly once");
    expect(prompt).toMatch(/Do NOT make design decisions/);
    expect(prompt).not.toContain("current requirements record");
  });

  it("gives a refine run the current record and the comments to address, once each", () => {
    const latest = { ...RECORD, version: 2, commentId: "100", createdAt: "2026-09-21T09:00:00.000Z" };
    const prompt = buildRequirementsPrompt(repo, issue, [RECORD_COMMENT, HUMAN], "claws-bot", [], { kind: "refine", latest, unreacted: [HUMAN] });
    expect(prompt).toContain("current requirements record (version 2)");
    expect(prompt).toContain(JSON.stringify(recordFromVersion(latest), null, 2));
    expect(prompt.split("Also on phones")).toHaveLength(2);
    expect(prompt).not.toContain("Discussion on the issue");
  });
});
