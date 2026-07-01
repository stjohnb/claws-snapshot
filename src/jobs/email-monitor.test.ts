import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockConfig } = vi.hoisted(() => ({
  mockConfig: {
    EMAIL_ENABLED: true,
    EMAIL_USER: "user@example.com",
    EMAIL_APP_PASSWORD: "test-password",
    EMAIL_RECIPIENT: "recipient@example.com",
  },
}));

vi.mock("../config.js", () => mockConfig);
vi.mock("../model-selector.js", () => ({ getModel: () => "sonnet" }));

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

const { mockClaude } = vi.hoisted(() => ({
  mockClaude: {
    enqueue: vi.fn((fn: () => Promise<string>) => fn()),
    runClaude: vi.fn(),
  },
}));

vi.mock("../claude.js", () => mockClaude);

const { mockMailboxOpen, mockSearch, mockFetchOne, mockMessageFlagsAdd, mockConnect, mockLogout, MockImapFlow } = vi.hoisted(() => {
  const mockMailboxOpen = vi.fn().mockResolvedValue(undefined);
  const mockSearch = vi.fn().mockResolvedValue([]);
  const mockFetchOne = vi.fn();
  const mockMessageFlagsAdd = vi.fn().mockResolvedValue(undefined);
  const mockConnect = vi.fn().mockResolvedValue(undefined);
  const mockLogout = vi.fn().mockResolvedValue(undefined);

  class MockImapFlow {
    config: unknown;
    connect = mockConnect;
    mailboxOpen = mockMailboxOpen;
    search = mockSearch;
    fetchOne = mockFetchOne;
    messageFlagsAdd = mockMessageFlagsAdd;
    logout = mockLogout;
    constructor(config: unknown) {
      this.config = config;
    }
  }

  return { mockMailboxOpen, mockSearch, mockFetchOne, mockMessageFlagsAdd, mockConnect, mockLogout, MockImapFlow };
});

vi.mock("imapflow", () => ({
  ImapFlow: MockImapFlow,
}));

const { mockSimpleParser } = vi.hoisted(() => ({
  mockSimpleParser: vi.fn(),
}));

vi.mock("mailparser", () => ({
  simpleParser: mockSimpleParser,
}));

const { mockSendMail } = vi.hoisted(() => ({
  mockSendMail: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("nodemailer", () => ({
  default: {
    createTransport: vi.fn().mockReturnValue({
      sendMail: mockSendMail,
    }),
  },
}));

import { run, getEmailStatus } from "./email-monitor.js";

describe("email-monitor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockConfig.EMAIL_ENABLED = true;
    mockConfig.EMAIL_USER = "user@example.com";
    mockConfig.EMAIL_APP_PASSWORD = "test-password";
    mockConfig.EMAIL_RECIPIENT = "recipient@example.com";
    mockSearch.mockResolvedValue([]);
  });

  it("no-ops when EMAIL_ENABLED is false", async () => {
    mockConfig.EMAIL_ENABLED = false;
    await run();
    expect(mockConnect).not.toHaveBeenCalled();
    expect(getEmailStatus().configured).toBe(false);
  });

  it("no-ops when credentials are missing", async () => {
    mockConfig.EMAIL_APP_PASSWORD = "";
    await run();
    expect(mockConnect).not.toHaveBeenCalled();
    expect(getEmailStatus().configured).toBe(false);
  });

  it("no-ops when email user is empty", async () => {
    mockConfig.EMAIL_USER = "";
    await run();
    expect(mockConnect).not.toHaveBeenCalled();
  });

  it("connects and searches for unseen emails", async () => {
    mockSearch.mockResolvedValue([]);
    await run();
    expect(mockConnect).toHaveBeenCalledOnce();
    expect(mockMailboxOpen).toHaveBeenCalledWith("INBOX");
    expect(mockSearch).toHaveBeenCalledWith({ seen: false });
    expect(getEmailStatus().configured).toBe(true);
    expect(getEmailStatus().lastCheck).toBeTruthy();
  });

  it("searches with only seen:false — no from or subject filters", async () => {
    await run();
    const searchArg = mockSearch.mock.calls[0][0];
    expect(searchArg).toEqual({ seen: false });
    expect(searchArg).not.toHaveProperty("from");
    expect(searchArg).not.toHaveProperty("subject");
  });

  it("extracts veg list and generates recipes for matching email", async () => {
    mockSearch.mockResolvedValue([101]);
    mockFetchOne.mockResolvedValue({
      source: Buffer.from("raw email content"),
    });
    mockSimpleParser.mockResolvedValue({
      text: "This Week's Veg Content\n\nRegular Veg Size\n  * Carrots\n  * Onions\n  * Kale",
    });
    mockClaude.runClaude
      .mockResolvedValueOnce("Carrots\nOnions\nKale")
      .mockResolvedValueOnce("1. Carrot Soup\n2. Kale Salad");

    await run();

    // First Claude call: extract veg list
    expect(mockClaude.runClaude).toHaveBeenCalledTimes(2);
    expect(mockClaude.runClaude.mock.calls[0][2]).toMatchObject({ provider: "claude" });
    expect(mockClaude.runClaude.mock.calls[1][2]).toMatchObject({ provider: "claude" });
    const extractPrompt = mockClaude.runClaude.mock.calls[0][0] as string;
    expect(extractPrompt).toContain("vegetable");

    // Second Claude call: generate recipes
    const recipePrompt = mockClaude.runClaude.mock.calls[1][0] as string;
    expect(recipePrompt).toContain("Carrots");
    expect(recipePrompt).toContain("3-5 recipe");

    // Email sent
    expect(mockSendMail).toHaveBeenCalledOnce();
    expect(mockSendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "recipient@example.com",
        subject: expect.stringContaining("Veg Box Recipes"),
      }),
    );

    // Marked as seen
    expect(mockMessageFlagsAdd).toHaveBeenCalledWith(101, ["\\Seen"]);
  });

  it("marks email as seen and skips when Claude returns NOT_FOUND", async () => {
    mockSearch.mockResolvedValue([200]);
    mockFetchOne.mockResolvedValue({
      source: Buffer.from("some non-veg email"),
    });
    mockSimpleParser.mockResolvedValue({
      text: "Meeting notes for Tuesday",
    });
    mockClaude.runClaude.mockResolvedValueOnce("NOT_FOUND");

    await run();

    expect(mockClaude.runClaude).toHaveBeenCalledOnce();
    expect(mockSendMail).not.toHaveBeenCalled();
    expect(mockMessageFlagsAdd).toHaveBeenCalledWith(200, ["\\Seen"]);
  });

  it("marks email as seen when simpleParser returns no text body", async () => {
    mockSearch.mockResolvedValue([300]);
    mockFetchOne.mockResolvedValue({
      source: Buffer.from("html-only email"),
    });
    mockSimpleParser.mockResolvedValue({ text: undefined });

    await run();

    expect(mockClaude.runClaude).not.toHaveBeenCalled();
    expect(mockMessageFlagsAdd).toHaveBeenCalledWith(300, ["\\Seen"]);
  });

  it("updates status on IMAP error after retry exhausted", async () => {
    vi.useFakeTimers();
    mockConnect
      .mockRejectedValueOnce(new Error("Connection refused"))
      .mockRejectedValueOnce(new Error("Connection refused"));
    const p = run();
    await vi.advanceTimersByTimeAsync(5000);
    await p;
    expect(mockConnect).toHaveBeenCalledTimes(2);
    expect(getEmailStatus().lastError).toContain("Connection refused");
    expect(mockReportError).toHaveBeenCalledWith(
      "email-monitor:poll",
      expect.any(String),
      expect.any(Error),
    );
    vi.useRealTimers();
  });

  it("retries once on transient connect failure", async () => {
    vi.useFakeTimers();
    mockConnect
      .mockRejectedValueOnce(new Error("Connection timeout"))
      .mockResolvedValueOnce(undefined);
    mockSearch.mockResolvedValue([]);

    const p = run();
    await vi.advanceTimersByTimeAsync(5000);
    await p;

    expect(mockConnect).toHaveBeenCalledTimes(2);
    expect(mockMailboxOpen).toHaveBeenCalledWith("INBOX");
    expect(mockReportError).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("reports per-email errors without blocking other emails", async () => {
    mockSearch.mockResolvedValue([301, 302]);
    mockFetchOne
      .mockRejectedValueOnce(new Error("fetch failed"))
      .mockResolvedValueOnce({
        source: Buffer.from("raw email"),
      });
    mockSimpleParser.mockResolvedValue({
      text: "Carrots\nOnions",
    });
    mockClaude.runClaude
      .mockResolvedValueOnce("Carrots\nOnions")
      .mockResolvedValueOnce("1. Carrot Soup");

    await run();

    // First email errored, second processed successfully
    expect(mockReportError).toHaveBeenCalledWith(
      "email-monitor:process",
      expect.stringContaining("301"),
      expect.any(Error),
    );
    expect(mockSendMail).toHaveBeenCalledOnce();
  });

  it("connects to Gmail IMAP on run", async () => {
    await run();
    expect(mockConnect).toHaveBeenCalledOnce();
    expect(mockMailboxOpen).toHaveBeenCalledWith("INBOX");
    expect(mockLogout).toHaveBeenCalled();
  });
});
