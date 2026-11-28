/**
 * Read-only prod mailbox proxy for sessions holding `prod-mail-read`
 * (#clw_01M8BM2RWC1T085EEEVZ6X21EH).
 *
 * The `/api/mail-read/*` routes (src/server/routes/public.ts) authenticate the
 * session's per-session token (src/mail-read-token.ts), refuse every method
 * but GET and call one of the operations below. Each opens one short-lived
 * IMAP connection with the web-tier-held reader login (`CLAWS_MAIL_READ_*`),
 * STARTTLS required, at most two at a time.
 *
 * Read-only is enforced by the mail server: the reader login's Dovecot ACL is
 * `lr`, so it refuses every write (production-infra `docs/email.md`). This
 * client is the second layer: it opens folders with EXAMINE only, fetches
 * with BODY.PEEK (imapflow's `source`) so a read never sets \Seen, and calls
 * no method that writes. `mail-read-proxy.test.ts` checks this source names
 * none of them.
 */
import { ImapFlow, type FetchMessageObject, type MessageAddressObject } from "imapflow";
import { simpleParser, type ParsedMail } from "mailparser";
import { MAIL_READ } from "./config.js";

const OPERATION_TIMEOUT_MS = 20_000;
const MAX_CONCURRENT = 2;
/** A message larger than this is refused with 413 rather than fetched. */
export const MAX_MESSAGE_BYTES = 25 * 1024 * 1024;
export const MAX_FOLDER_LENGTH = 200;
export const DEFAULT_MESSAGE_LIMIT = 50;
export const MAX_MESSAGE_LIMIT = 200;

export type MailReadResult<T> =
  | { kind: "ok"; value: T }
  | { kind: "unconfigured" }
  | { kind: "not-found" }
  | { kind: "too-large" }
  | { kind: "upstream-error"; error: string };

export interface MailFolder {
  path: string;
  messages: number | null;
}

export interface MailMessageSummary {
  uid: number;
  date: string | null;
  from: string[];
  to: string[];
  subject: string | null;
  size: number | null;
  flags: string[];
}

export interface MailAttachmentInfo {
  index: number;
  filename: string | null;
  contentType: string;
  size: number;
}

export interface MailMessage {
  uid: number;
  headers: { name: string; value: string }[];
  bodyType: "plain" | "html" | "none";
  body: string;
  attachments: MailAttachmentInfo[];
}

export interface MailAttachment {
  filename: string | null;
  contentType: string;
  content: Buffer;
}

/** True when the web tier holds everything needed to log in. */
export function isMailReadConfigured(): boolean {
  return Boolean(MAIL_READ.host && MAIL_READ.user && MAIL_READ.password);
}

/** A folder name the proxy accepts: non-empty, at most 200 chars, no control characters. */
export function isValidMailFolder(folder: string): boolean {
  // eslint-disable-next-line no-control-regex
  return folder.length > 0 && folder.length <= MAX_FOLDER_LENGTH && !/[\u0000-\u001f\u007f]/.test(folder);
}

/** A positive decimal integer within IMAP's 32-bit uid range, else null. */
export function parseMailUid(raw: string | undefined | null): number | null {
  if (raw == null || !/^[0-9]{1,10}$/.test(raw)) return null;
  const n = Number(raw);
  return n >= 1 && n <= 0xffffffff ? n : null;
}

/** A non-negative decimal integer below 10 000, else null (attachment index). */
export function parseMailIndex(raw: string | undefined | null): number | null {
  if (raw == null || !/^[0-9]{1,4}$/.test(raw)) return null;
  return Number(raw);
}

let active = 0;
const waiters: (() => void)[] = [];

async function acquire(): Promise<void> {
  if (active < MAX_CONCURRENT) {
    active++;
    return;
  }
  await new Promise<void>((resolve) => waiters.push(resolve));
}

function release(): void {
  const next = waiters.shift();
  if (next) next();
  else active--;
}

class MailReadNotFound extends Error {}
class MailReadTooLarge extends Error {}

/** Run `op` on a fresh, logged-in connection; never throws. */
async function withClient<T>(op: (client: ImapFlow) => Promise<T>): Promise<MailReadResult<T>> {
  if (!isMailReadConfigured()) return { kind: "unconfigured" };
  await acquire();
  const client = new ImapFlow({
    host: MAIL_READ.host,
    port: MAIL_READ.port,
    secure: false,
    doSTARTTLS: true,
    tls: { servername: MAIL_READ.tlsName || MAIL_READ.host },
    auth: { user: MAIL_READ.user, pass: MAIL_READ.password },
    logger: false,
    disableAutoIdle: true,
    connectionTimeout: OPERATION_TIMEOUT_MS,
    greetingTimeout: OPERATION_TIMEOUT_MS,
    socketTimeout: OPERATION_TIMEOUT_MS,
  });
  // An error event on an idle client must not crash the process.
  client.on("error", () => {});
  let timer: NodeJS.Timeout | undefined;
  let timedOut = false;
  try {
    const run = (async () => {
      await client.connect();
      return op(client);
    })();
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        const err = new Error("Mail read timed out");
        err.name = "TimeoutError";
        reject(err);
      }, OPERATION_TIMEOUT_MS);
    });
    run.catch(() => {});
    const value = await Promise.race([run, timeout]);
    return { kind: "ok", value };
  } catch (err) {
    if (err instanceof MailReadNotFound) return { kind: "not-found" };
    if (err instanceof MailReadTooLarge) return { kind: "too-large" };
    return { kind: "upstream-error", error: err instanceof Error ? err.name : "Error" };
  } finally {
    if (timer) clearTimeout(timer);
    if (timedOut) client.close();
    else {
      try {
        await client.logout();
      } catch {
        client.close();
      }
    }
    release();
  }
}

/** EXAMINE `folder`; a folder that does not exist or cannot be read is not-found. */
async function examine(client: ImapFlow, folder: string): Promise<void> {
  try {
    await client.mailboxOpen(folder, { readOnly: true });
  } catch (err) {
    if (err instanceof Error && /NONEXISTENT|doesn't exist|does not exist|Mailbox doesn/i.test(`${err.message} ${(err as { responseText?: string }).responseText ?? ""}`)) {
      throw new MailReadNotFound();
    }
    throw err;
  }
}

function formatAddresses(list: MessageAddressObject[] | undefined): string[] {
  return (list ?? []).map((a) => (a.name ? `${a.name} <${a.address ?? ""}>` : (a.address ?? ""))).filter((s) => s !== "");
}

function toDateString(d: Date | string | undefined): string | null {
  if (d == null) return null;
  const date = d instanceof Date ? d : new Date(d);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function summarize(msg: FetchMessageObject): MailMessageSummary {
  return {
    uid: msg.uid,
    date: toDateString(msg.envelope?.date ?? msg.internalDate),
    from: formatAddresses(msg.envelope?.from),
    to: formatAddresses(msg.envelope?.to),
    subject: msg.envelope?.subject ?? null,
    size: msg.size ?? null,
    flags: [...(msg.flags ?? [])],
  };
}

/** Every folder the reader can see, with its message count. */
export function listFolders(): Promise<MailReadResult<MailFolder[]>> {
  return withClient(async (client) => {
    const list = await client.list({ statusQuery: { messages: true } });
    return list.map((f) => ({ path: f.path, messages: f.status?.messages ?? null }));
  });
}

/**
 * Up to `limit` (1–200, default 50) messages of `folder`, newest uid first,
 * with uids below `before` when given (to page back).
 */
export function listMessages(folder: string, limit: number = DEFAULT_MESSAGE_LIMIT, before?: number): Promise<MailReadResult<MailMessageSummary[]>> {
  const take = Math.min(Math.max(Math.trunc(limit) || DEFAULT_MESSAGE_LIMIT, 1), MAX_MESSAGE_LIMIT);
  return withClient(async (client) => {
    await examine(client, folder);
    if (before !== undefined && before <= 1) return [];
    const found = await client.search({ uid: before !== undefined ? `1:${before - 1}` : "1:*" }, { uid: true });
    const uids = (Array.isArray(found) ? found : [])
      .filter((u) => before === undefined || u < before)
      .sort((a, b) => a - b)
      .slice(-take);
    if (uids.length === 0) return [];
    const msgs = await client.fetchAll(uids.join(","), { uid: true, envelope: true, size: true, flags: true, internalDate: true }, { uid: true });
    return msgs.map(summarize).sort((a, b) => b.uid - a.uid);
  });
}

/** Fetch and parse one message by uid, refusing one over `MAX_MESSAGE_BYTES`. */
async function fetchParsed(client: ImapFlow, folder: string, uid: number): Promise<ParsedMail> {
  await examine(client, folder);
  const meta = await client.fetchOne(String(uid), { uid: true, size: true }, { uid: true });
  if (!meta) throw new MailReadNotFound();
  if ((meta.size ?? 0) > MAX_MESSAGE_BYTES) throw new MailReadTooLarge();
  const msg = await client.fetchOne(String(uid), { uid: true, source: true }, { uid: true });
  if (!msg || !msg.source) throw new MailReadNotFound();
  if (msg.source.length > MAX_MESSAGE_BYTES) throw new MailReadTooLarge();
  return simpleParser(msg.source);
}

function headerValue(line: string): string {
  const colon = line.indexOf(":");
  return (colon >= 0 ? line.slice(colon + 1) : line).replace(/\r?\n[ \t]+/g, " ").trim();
}

/** One message's headers, text body (plain, else HTML) and attachment list. */
export function getMessage(folder: string, uid: number): Promise<MailReadResult<MailMessage>> {
  return withClient(async (client) => {
    const parsed = await fetchParsed(client, folder, uid);
    const headers = parsed.headerLines.map((h) => ({ name: h.line.slice(0, Math.max(h.line.indexOf(":"), 0)) || h.key, value: headerValue(h.line) }));
    let bodyType: MailMessage["bodyType"] = "none";
    let body = "";
    if (parsed.text) {
      bodyType = "plain";
      body = parsed.text;
    } else if (typeof parsed.html === "string" && parsed.html) {
      bodyType = "html";
      body = parsed.html;
    }
    const attachments = parsed.attachments.map((a, index) => ({
      index,
      filename: a.filename ?? null,
      contentType: a.contentType,
      size: a.size,
    }));
    return { uid, headers, bodyType, body, attachments };
  });
}

/** The decoded bytes of attachment `index` (as listed by `getMessage`). */
export function getAttachment(folder: string, uid: number, index: number): Promise<MailReadResult<MailAttachment>> {
  return withClient(async (client) => {
    const parsed = await fetchParsed(client, folder, uid);
    const a = parsed.attachments[index];
    if (!a) throw new MailReadNotFound();
    return { filename: a.filename ?? null, contentType: a.contentType, content: a.content };
  });
}
