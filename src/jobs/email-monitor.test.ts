import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockConfig } = vi.hoisted(() => ({
  mockConfig: {
    EMAIL_ENABLED: true,
    EMAIL_USER: "user@example.com",
    EMAIL_APP_PASSWORD: "test-password",
    EMAIL_RECIPIENT: "recipient@example.com",
    EMAIL_VEG_BOX_SENDER: "sender",
  },
}));

vi.mock("../config.js", () => mockConfig);

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

const SAMPLE_EMAIL_SOURCE = [
  'Content-Type: multipart/alternative; boundary="test-boundary"',
  "",
  "--test-boundary",
  "Content-Type: text/plain; charset=\"Windows-1252\"",
  "Content-Transfer-Encoding: quoted-printable",
  "",
  "This Week's Veg Content",
  "",
  "Regular Veg Size",
  "Large Veg Size",
  "",
  "  *   Carrots",
  "  *   Onions",
  "  *   Leek",
  "  *   Kale",
  "  *   Beetroots",
  "  *   Salad",
  "  *   Mushrooms",
  "",
  "  *   Carrots",
  "  *   Onions",
  "  *   Leek",
  "  *   Kale",
  "  *   Beetroots",
  "  *   Salad",
  "  *   Mushrooms",
  "  *   Celery",
  "",
  "--test-boundary",
  "Content-Type: text/html; charset=\"Windows-1252\"",
  "",
  "<html>...</html>",
  "",
  "--test-boundary--",
].join("\r\n");

describe("email-monitor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockConfig.EMAIL_ENABLED = true;
    mockConfig.EMAIL_USER = "user@example.com";
    mockConfig.EMAIL_APP_PASSWORD = "test-password";
    mockConfig.EMAIL_RECIPIENT = "recipient@example.com";
    mockConfig.EMAIL_VEG_BOX_SENDER = "sender";
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

  it("connects and searches for unseen veg box emails", async () => {
    mockSearch.mockResolvedValue([]);
    await run();
    expect(mockConnect).toHaveBeenCalledOnce();
    expect(mockMailboxOpen).toHaveBeenCalledWith("INBOX");
    expect(mockSearch).toHaveBeenCalledWith({
      seen: false,
      from: "sender",
      subject: "Veg Content",
    });
    expect(getEmailStatus().configured).toBe(true);
    expect(getEmailStatus().lastCheck).toBeTruthy();
  });

  it("uses configured sender filter in IMAP search", async () => {
    mockConfig.EMAIL_VEG_BOX_SENDER = "customsender";
    await run();
    expect(mockSearch).toHaveBeenCalledWith(
      expect.objectContaining({ from: "customsender" }),
    );
  });

  it("includes Veg Content subject filter in search", async () => {
    await run();
    expect(mockSearch).toHaveBeenCalledWith(
      expect.objectContaining({ subject: "Veg Content" }),
    );
  });

  it("extracts veg list and generates recipes for matching email", async () => {
    mockSearch.mockResolvedValue([101]);
    mockFetchOne.mockResolvedValue({
      source: Buffer.from(SAMPLE_EMAIL_SOURCE),
    });
    mockClaude.runClaude
      .mockResolvedValueOnce("Carrots\nOnions\nLeek\nKale\nBeetroots\nSalad\nMushrooms")
      .mockResolvedValueOnce("1. Carrot Soup\n2. Kale Salad\n3. Mushroom Risotto");

    await run();

    // First Claude call: extract veg list
    expect(mockClaude.runClaude).toHaveBeenCalledTimes(2);
    const extractPrompt = mockClaude.runClaude.mock.calls[0][0] as string;
    expect(extractPrompt).toContain("Regular Veg Size");

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
      source: Buffer.from(SAMPLE_EMAIL_SOURCE),
    });
    mockClaude.runClaude.mockResolvedValueOnce("NOT_FOUND");

    await run();

    expect(mockClaude.runClaude).toHaveBeenCalledOnce();
    expect(mockSendMail).not.toHaveBeenCalled();
    expect(mockMessageFlagsAdd).toHaveBeenCalledWith(200, ["\\Seen"]);
  });

  it("updates status on IMAP error", async () => {
    mockConnect.mockRejectedValueOnce(new Error("Connection refused"));
    await run();
    expect(getEmailStatus().lastError).toContain("Connection refused");
    expect(mockReportError).toHaveBeenCalledWith(
      "email-monitor:poll",
      expect.any(String),
      expect.any(Error),
    );
  });

  it("reports per-email errors without blocking other emails", async () => {
    mockSearch.mockResolvedValue([301, 302]);
    mockFetchOne
      .mockRejectedValueOnce(new Error("fetch failed"))
      .mockResolvedValueOnce({
        source: Buffer.from(SAMPLE_EMAIL_SOURCE),
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
