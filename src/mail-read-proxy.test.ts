import fs from "node:fs";
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockConfig, imap } = vi.hoisted(() => {
  const imap = {
    options: [] as unknown[],
    instances: 0,
    list: vi.fn(),
    mailboxOpen: vi.fn(),
    search: vi.fn(),
    fetchAll: vi.fn(),
    fetchOne: vi.fn(),
    connect: vi.fn(),
    logout: vi.fn(),
    close: vi.fn(),
  };
  return {
    imap,
    mockConfig: { MAIL_READ: { host: "100.118.174.95", port: 143, tlsName: "mail.bonkus.io", user: "inbox@bonkus.io*claws-reader", password: "pw" } },
  };
});
vi.mock("./config.js", async (importOriginal) => (await import("./test-helpers.js")).completeConfigMock(await importOriginal<typeof import("./config.js")>(), mockConfig));
vi.mock("imapflow", () => ({
  ImapFlow: class {
    constructor(opts: unknown) {
      imap.options.push(opts);
      imap.instances++;
    }
    on() {}
    list = imap.list;
    mailboxOpen = imap.mailboxOpen;
    search = imap.search;
    fetchAll = imap.fetchAll;
    fetchOne = imap.fetchOne;
    connect = imap.connect;
    logout = imap.logout;
    close = imap.close;
  },
}));

import {
  MAX_MESSAGE_BYTES,
  getAttachment,
  getMessage,
  isMailReadConfigured,
  isValidMailFolder,
  listFolders,
  listMessages,
  parseMailIndex,
  parseMailUid,
} from "./mail-read-proxy.js";

const RAW = [
  "From: Reporter <noreply@example.test>",
  "To: inbox@bonkus.io",
  "Subject: Report domain bonkus.io",
  "Date: Tue, 24 Nov 2026 10:00:00 +0000",
  "MIME-Version: 1.0",
  'Content-Type: multipart/mixed; boundary="b1"',
  "",
  "--b1",
  "Content-Type: text/plain; charset=utf-8",
  "",
  "See attached.",
  "--b1",
  'Content-Type: application/gzip; name="report.xml.gz"',
  'Content-Disposition: attachment; filename="report.xml.gz"',
  "Content-Transfer-Encoding: base64",
  "",
  Buffer.from([0x1f, 0x8b, 1, 2, 3]).toString("base64"),
  "--b1--",
  "",
].join("\r\n");

describe("prod mailbox read proxy (#clw_01M8BM2RWC1T085EEEVZ6X21EH)", () => {
  beforeEach(() => {
    for (const fn of [imap.list, imap.mailboxOpen, imap.search, imap.fetchAll, imap.fetchOne, imap.connect, imap.logout, imap.close]) fn.mockReset();
    imap.options = [];
    imap.instances = 0;
    imap.connect.mockResolvedValue(undefined);
    imap.logout.mockResolvedValue(undefined);
    imap.mailboxOpen.mockResolvedValue({});
    mockConfig.MAIL_READ = { host: "100.118.174.95", port: 143, tlsName: "mail.bonkus.io", user: "inbox@bonkus.io*claws-reader", password: "pw" };
  });

  it("connects with STARTTLS required, the TLS name and no logger, and logs out", async () => {
    imap.list.mockResolvedValue([{ path: "INBOX", status: { messages: 3 } }, { path: "dmarc" }]);
    expect(await listFolders()).toEqual({ kind: "ok", value: [{ path: "INBOX", messages: 3 }, { path: "dmarc", messages: null }] });
    expect(imap.options[0]).toMatchObject({
      host: "100.118.174.95",
      port: 143,
      secure: false,
      doSTARTTLS: true,
      tls: { servername: "mail.bonkus.io" },
      auth: { user: "inbox@bonkus.io*claws-reader", pass: "pw" },
      logger: false,
    });
    expect(imap.list).toHaveBeenCalledWith({ statusQuery: { messages: true } });
    expect(imap.logout).toHaveBeenCalledTimes(1);
  });

  it("is unconfigured without host, user or password, and opens no connection", async () => {
    mockConfig.MAIL_READ = { ...mockConfig.MAIL_READ, password: "" };
    expect(isMailReadConfigured()).toBe(false);
    expect(await listFolders()).toEqual({ kind: "unconfigured" });
    expect(imap.instances).toBe(0);
  });

  it("lists the newest messages first with EXAMINE only, paging below `before`", async () => {
    imap.search.mockResolvedValue([3, 1, 2, 5]);
    imap.fetchAll.mockResolvedValue([
      { uid: 2, size: 10, flags: new Set(["\\Seen"]), envelope: { date: new Date("2026-11-01T00:00:00Z"), subject: "a", from: [{ name: "A", address: "a@x.test" }], to: [{ address: "inbox@bonkus.io" }] } },
      { uid: 3, size: 20, flags: new Set(), envelope: { subject: "b" }, internalDate: "2026-11-02T00:00:00Z" },
    ]);
    const res = await listMessages("dmarc", 2, 4);
    expect(imap.mailboxOpen).toHaveBeenCalledWith("dmarc", { readOnly: true });
    expect(imap.search).toHaveBeenCalledWith({ uid: "1:3" }, { uid: true });
    expect(imap.fetchAll).toHaveBeenCalledWith("2,3", { uid: true, envelope: true, size: true, flags: true, internalDate: true }, { uid: true });
    expect(res).toEqual({
      kind: "ok",
      value: [
        { uid: 3, date: "2026-11-02T00:00:00.000Z", from: [], to: [], subject: "b", size: 20, flags: [] },
        { uid: 2, date: "2026-11-01T00:00:00.000Z", from: ["A <a@x.test>"], to: ["inbox@bonkus.io"], subject: "a", size: 10, flags: ["\\Seen"] },
      ],
    });
    imap.fetchAll.mockClear();
    expect(await listMessages("INBOX", 50, 1)).toEqual({ kind: "ok", value: [] });
    expect(imap.fetchAll).not.toHaveBeenCalled();
  });

  it("parses one message into headers, plain body and attachment list, and serves the attachment bytes", async () => {
    imap.fetchOne.mockImplementation(async (_uid: string, query: { source?: boolean }) =>
      query.source ? { uid: 7, source: Buffer.from(RAW) } : { uid: 7, size: RAW.length },
    );
    const msg = await getMessage("INBOX", 7);
    expect(imap.mailboxOpen).toHaveBeenCalledWith("INBOX", { readOnly: true });
    for (const call of imap.fetchOne.mock.calls) expect(call[2]).toEqual({ uid: true });
    expect(msg.kind).toBe("ok");
    if (msg.kind !== "ok") return;
    expect(msg.value.bodyType).toBe("plain");
    expect(msg.value.body.trim()).toBe("See attached.");
    expect(msg.value.headers).toContainEqual({ name: "Subject", value: "Report domain bonkus.io" });
    expect(msg.value.attachments).toEqual([{ index: 0, filename: "report.xml.gz", contentType: "application/gzip", size: 5 }]);
    const att = await getAttachment("INBOX", 7, 0);
    expect(att.kind).toBe("ok");
    if (att.kind === "ok") expect([...att.value.content]).toEqual([0x1f, 0x8b, 1, 2, 3]);
    expect((await getAttachment("INBOX", 7, 1)).kind).toBe("not-found");
  });

  it("refuses a message over 25 MB before fetching its source, and maps a missing uid to not-found", async () => {
    imap.fetchOne.mockResolvedValueOnce({ uid: 7, size: MAX_MESSAGE_BYTES + 1 });
    expect(await getMessage("INBOX", 7)).toEqual({ kind: "too-large" });
    expect(imap.fetchOne).toHaveBeenCalledTimes(1);
    imap.fetchOne.mockResolvedValueOnce(false);
    expect(await getMessage("INBOX", 8)).toEqual({ kind: "not-found" });
  });

  it("reports an upstream failure by error name only, and still closes the connection", async () => {
    const err = new Error("secret detail");
    err.name = "AuthenticationFailure";
    imap.connect.mockRejectedValue(err);
    imap.logout.mockRejectedValue(new Error("not connected"));
    expect(await listFolders()).toEqual({ kind: "upstream-error", error: "AuthenticationFailure" });
    expect(imap.close).toHaveBeenCalledTimes(1);
  });

  it("runs at most two connections at once", async () => {
    let inFlight = 0;
    let peak = 0;
    imap.list.mockImplementation(async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return [];
    });
    await Promise.all([listFolders(), listFolders(), listFolders(), listFolders(), listFolders()]);
    expect(peak).toBe(2);
    expect(imap.list).toHaveBeenCalledTimes(5);
  });

  it("validates folder names, uids and indexes", () => {
    expect(isValidMailFolder("INBOX")).toBe(true);
    expect(isValidMailFolder("Archive/2026")).toBe(true);
    for (const bad of ["", "a".repeat(201), "IN\nBOX", "x\u0000", "x\u007f"]) expect(isValidMailFolder(bad), JSON.stringify(bad)).toBe(false);
    expect(parseMailUid("42")).toBe(42);
    for (const bad of [null, "", "0", "-1", "1x", "1.5", "99999999999"]) expect(parseMailUid(bad), String(bad)).toBeNull();
    expect(parseMailIndex("0")).toBe(0);
    for (const bad of [null, "", "-1", "a", "12345"]) expect(parseMailIndex(bad), String(bad)).toBeNull();
  });

  it("names no imapflow method that writes, and opens folders read-only", () => {
    const source = fs.readFileSync(new URL("./mail-read-proxy.ts", import.meta.url), "utf8");
    for (const name of [
      "messageFlagsAdd",
      "messageFlagsSet",
      "messageFlagsRemove",
      "setFlagColor",
      "messageCopy",
      "messageMove",
      "messageDelete",
      "append",
      "mailboxCreate",
      "mailboxDelete",
      "mailboxRename",
      "mailboxSubscribe",
      "mailboxUnsubscribe",
      "expunge",
      "getMailboxLock",
    ]) {
      expect(source, name).not.toMatch(new RegExp(`\\b${name}\\b`, "i"));
    }
    const opens = source.match(/mailboxOpen\([^)]*\)/g) ?? [];
    expect(opens.length).toBeGreaterThan(0);
    for (const call of opens) expect(call).toContain("readOnly: true");
  });
});
