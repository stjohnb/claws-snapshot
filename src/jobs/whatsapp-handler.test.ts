import { describe, it, expect, vi, beforeEach } from "vitest";
import { mockRepo } from "../test-helpers.js";

vi.mock("../config.js", () => ({}));

vi.mock("../log.js", () => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

const { mockReportError } = vi.hoisted(() => ({
  mockReportError: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../error-reporter.js", () => ({
  reportError: mockReportError,
}));

const { mockGh } = vi.hoisted(() => ({
  mockGh: {
    createIssue: vi.fn(),
    listRepos: vi.fn(),
  },
}));

vi.mock("../github.js", () => mockGh);

const { mockClaude } = vi.hoisted(() => ({
  mockClaude: {
    enqueue: vi.fn((fn: () => Promise<string>) => fn()),
    runClaude: vi.fn(),
  },
}));

vi.mock("../claude.js", () => mockClaude);

const { mockTranscribe } = vi.hoisted(() => ({
  mockTranscribe: {
    transcribe: vi.fn(),
    isAvailable: vi.fn(),
  },
}));

vi.mock("../transcribe.js", () => mockTranscribe);

const { mockWhatsapp } = vi.hoisted(() => ({
  mockWhatsapp: {
    sendMessage: vi.fn(),
  },
}));

vi.mock("../whatsapp.js", () => mockWhatsapp);

import { createHandler } from "./whatsapp-handler.js";

describe("whatsapp-handler", () => {
  const repo = mockRepo();
  const listRepos = vi.fn().mockResolvedValue([repo]);

  beforeEach(() => {
    vi.clearAllMocks();
    listRepos.mockResolvedValue([repo]);
    mockGh.createIssue.mockResolvedValue(42);
    mockClaude.runClaude.mockResolvedValue(
      JSON.stringify({
        repo: "test-org/test-repo",
        title: "Add dark mode",
      }),
    );
    mockTranscribe.isAvailable.mockReturnValue(true);
    mockTranscribe.transcribe.mockResolvedValue("Add dark mode to the app");
    mockWhatsapp.sendMessage.mockResolvedValue(undefined);
  });

  it("creates an issue from a text message", async () => {
    const handler = createHandler(listRepos);

    await handler({
      from: "447000000000@s.whatsapp.net",
      text: "Add dark mode to the app",
      messageId: "msg-1",
    });

    expect(mockClaude.runClaude).toHaveBeenCalledOnce();
    expect(mockGh.createIssue).toHaveBeenCalledWith(
      "test-org/test-repo",
      "Add dark mode",
      "Add dark mode to the app",
      [],
    );
    expect(mockWhatsapp.sendMessage).toHaveBeenCalledWith(
      "447000000000@s.whatsapp.net",
      expect.stringContaining("Created issue #42"),
    );
  });

  it("transcribes voice notes before creating an issue", async () => {
    const handler = createHandler(listRepos);
    const audioBuffer = Buffer.from("fake-audio");

    await handler({
      from: "447000000000@s.whatsapp.net",
      audioBuffer,
      messageId: "msg-2",
    });

    expect(mockTranscribe.transcribe).toHaveBeenCalledWith(audioBuffer, "voice-note.ogg", "Kwyjibo, Claws, GitHub");
    expect(mockClaude.runClaude).toHaveBeenCalledOnce();
    expect(mockGh.createIssue).toHaveBeenCalledWith(
      "test-org/test-repo",
      "Add dark mode",
      "*Transcribed from a voice note.*\n\nAdd dark mode to the app",
      [],
    );
  });

  it("replies with error when voice notes unsupported", async () => {
    mockTranscribe.isAvailable.mockReturnValue(false);
    const handler = createHandler(listRepos);

    await handler({
      from: "447000000000@s.whatsapp.net",
      audioBuffer: Buffer.from("fake-audio"),
      messageId: "msg-3",
    });

    expect(mockWhatsapp.sendMessage).toHaveBeenCalledWith(
      "447000000000@s.whatsapp.net",
      expect.stringContaining("Voice notes aren't supported"),
    );
    expect(mockClaude.runClaude).not.toHaveBeenCalled();
  });

  it("handles Claude returning null repo", async () => {
    mockClaude.runClaude.mockResolvedValue(
      JSON.stringify({ repo: null, title: "Unclear" }),
    );
    const handler = createHandler(listRepos);

    await handler({
      from: "447000000000@s.whatsapp.net",
      text: "something vague",
      messageId: "msg-4",
    });

    expect(mockGh.createIssue).not.toHaveBeenCalled();
    expect(mockWhatsapp.sendMessage).toHaveBeenCalledWith(
      "447000000000@s.whatsapp.net",
      expect.stringContaining("couldn't determine"),
    );
  });

  it("handles invalid repo from Claude", async () => {
    mockClaude.runClaude.mockResolvedValue(
      JSON.stringify({ repo: "unknown/repo", title: "Test" }),
    );
    const handler = createHandler(listRepos);

    await handler({
      from: "447000000000@s.whatsapp.net",
      text: "Add a feature",
      messageId: "msg-5",
    });

    expect(mockGh.createIssue).not.toHaveBeenCalled();
    expect(mockWhatsapp.sendMessage).toHaveBeenCalledWith(
      "447000000000@s.whatsapp.net",
      expect.stringContaining("don't have access"),
    );
  });

  it("handles issue creation failure", async () => {
    mockGh.createIssue.mockRejectedValue(new Error("API error"));
    const handler = createHandler(listRepos);

    await handler({
      from: "447000000000@s.whatsapp.net",
      text: "Add dark mode",
      messageId: "msg-6",
    });

    expect(mockWhatsapp.sendMessage).toHaveBeenLastCalledWith(
      "447000000000@s.whatsapp.net",
      expect.stringContaining("Something went wrong"),
    );
    expect(mockReportError).toHaveBeenCalledWith(
      "whatsapp-handler:process-message",
      "447000000000@s.whatsapp.net",
      expect.any(Error),
    );
  });

  it("handles unparseable Claude response", async () => {
    mockClaude.runClaude.mockResolvedValue("This is not JSON");
    const handler = createHandler(listRepos);

    await handler({
      from: "447000000000@s.whatsapp.net",
      text: "Add dark mode",
      messageId: "msg-7",
    });

    expect(mockGh.createIssue).not.toHaveBeenCalled();
    expect(mockWhatsapp.sendMessage).toHaveBeenCalledWith(
      "447000000000@s.whatsapp.net",
      expect.stringContaining("trouble understanding"),
    );
  });

  it("handles empty message text", async () => {
    const handler = createHandler(listRepos);

    await handler({
      from: "447000000000@s.whatsapp.net",
      text: "",
      messageId: "msg-8",
    });

    expect(mockClaude.runClaude).not.toHaveBeenCalled();
    expect(mockWhatsapp.sendMessage).toHaveBeenCalledWith(
      "447000000000@s.whatsapp.net",
      expect.stringContaining("couldn't understand"),
    );
  });
});
