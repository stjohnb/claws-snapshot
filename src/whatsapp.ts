import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  downloadContentFromMessage,
  fetchLatestBaileysVersion,
  type WASocket,
  type WAMessage,
  type proto,
} from "baileys";
import { Boom } from "@hapi/boom";
import fs from "node:fs";
import path from "node:path";
import QRCode from "qrcode";
import { WHATSAPP_ALLOWED_NUMBERS, WHATSAPP_AUTH_DIR } from "./config.js";
import * as log from "./log.js";
import { reportError } from "./error-reporter.js";
import { notify } from "./slack.js";

export interface WhatsAppMessage {
  from: string;
  text?: string;
  audioBuffer?: Buffer;
  messageId: string;
}

export type MessageHandler = (msg: WhatsAppMessage) => Promise<void>;

export type PairingEvent =
  | { type: "qr"; dataUrl: string }
  | { type: "connected" }
  | { type: "error"; message: string }
  | { type: "timeout" };

export type PairingListener = (event: PairingEvent) => void;

let socket: WASocket | null = null;
let connected = false;
let ownJid: string | null = null;
let storedOnMessage: MessageHandler | null = null;
const processedIds = new Set<string>();
const MAX_PROCESSED_IDS = 10_000;

// Reconnection state
let consecutiveFailures = 0;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let pairingRequired = false;
let connectionGeneration = 0;

// Slack notification deduplication — tracks what was last notified
let lastNotifiedState: "connected" | "pairing-required" | null = null;

// Pairing state
let pairingListener: PairingListener | null = null;
let pairingTimeout: ReturnType<typeof setTimeout> | null = null;
const PAIRING_TIMEOUT_MS = 2 * 60 * 1000; // 2 minutes
const MAX_FAILURES_BEFORE_CLEAR = 5;

export function isConnected(): boolean {
  return connected;
}

export function isPairingRequired(): boolean {
  return pairingRequired;
}

export function isPairing(): boolean {
  return pairingListener !== null;
}

export function whatsappStatus(): {
  configured: boolean;
  connected: boolean;
  pairingRequired: boolean;
} {
  return {
    configured: WHATSAPP_ALLOWED_NUMBERS.length > 0,
    connected,
    pairingRequired,
  };
}

export function hasAuthState(): boolean {
  try {
    return fs.existsSync(path.join(WHATSAPP_AUTH_DIR, "creds.json"));
  } catch {
    return false;
  }
}

function clearAuthState(): void {
  try {
    if (fs.existsSync(WHATSAPP_AUTH_DIR)) {
      for (const file of fs.readdirSync(WHATSAPP_AUTH_DIR)) {
        fs.unlinkSync(path.join(WHATSAPP_AUTH_DIR, file));
      }
    }
  } catch (err) {
    log.warn(`[whatsapp] Failed to clear auth state: ${err}`);
  }
}

function isAllowed(jid: string, jidAlt?: string | null): boolean {
  // JID format: <number>@s.whatsapp.net or <lid>@lid
  const number = jid.split("@")[0];
  if (WHATSAPP_ALLOWED_NUMBERS.includes(number)) return true;

  // When the primary JID is @lid, the alternate JID may contain the phone number
  if (jidAlt) {
    const altNumber = jidAlt.split("@")[0];
    if (WHATSAPP_ALLOWED_NUMBERS.includes(altNumber)) return true;
  }

  return false;
}

function isGroupMessage(jid: string): boolean {
  return jid.endsWith("@g.us");
}

async function downloadAudio(
  message: proto.IMessage,
): Promise<Buffer | undefined> {
  const audioMsg = message.audioMessage;
  if (!audioMsg) return undefined;

  try {
    const stream = await downloadContentFromMessage(audioMsg, "audio");
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(chunk as Buffer);
    }
    const buffer = Buffer.concat(chunks);

    // Cap at ~10 minutes (~2.4 MB for Opus at 32kbps).
    // Whisper API has a 25 MB limit, but we keep it reasonable.
    const MAX_AUDIO_BYTES = 25 * 1024 * 1024;
    if (buffer.length > MAX_AUDIO_BYTES) {
      return undefined; // Caller should notify user
    }
    return buffer;
  } catch (err) {
    log.warn(`[whatsapp] Failed to download audio: ${err}`);
    return undefined;
  }
}

function getBackoffDelay(): number {
  return Math.min(3000 * Math.pow(2, consecutiveFailures - 1), 60_000);
}

function notifySlack(
  newState: "connected" | "pairing-required",
  reason?: string,
): void {
  if (
    newState === "pairing-required" &&
    lastNotifiedState !== "pairing-required"
  ) {
    notify(`[whatsapp] Pairing required: ${reason}. Pair at /whatsapp`);
    lastNotifiedState = "pairing-required";
  } else if (
    newState === "connected" &&
    lastNotifiedState === "pairing-required"
  ) {
    notify("[whatsapp] Pairing complete — WhatsApp connected");
    lastNotifiedState = "connected";
  }
}

const noop = () => {};
const DECRYPT_KEYWORDS = /retry|decrypt|session|prekey|cipher|signal/i;
const TRANSIENT_MESSAGES = /keep alive|stream errored/i;

const baileysLogger = {
  level: "debug" as const,
  child() { return baileysLogger; },
  trace: noop,
  debug(obj: unknown, msg?: string) {
    const text = msg ?? String(obj);
    if (DECRYPT_KEYWORDS.test(text)) {
      log.debug(`[whatsapp/baileys] ${text}`);
    }
  },
  info(obj: unknown, msg?: string) {
    const text = msg ?? String(obj);
    if (DECRYPT_KEYWORDS.test(text)) {
      log.info(`[whatsapp/baileys] ${text}`);
    }
  },
  warn(obj: unknown, msg?: string) {
    log.warn(`[whatsapp/baileys] ${msg ?? obj}`);
  },
  error(obj: unknown, msg?: string) {
    const text = msg ?? String(obj);
    if (TRANSIENT_MESSAGES.test(text)) {
      log.warn(`[whatsapp/baileys] ${text}`);
      return;
    }
    log.error(`[whatsapp/baileys] ${text}`);
    const errorPayload = (typeof obj === "object" && obj !== null)
      ? (obj as Record<string, unknown>).err ?? (obj as Record<string, unknown>).trace ?? obj
      : obj;
    reportError("whatsapp:baileys-error", text, errorPayload).catch(() => {});
  },
};

async function connect(onMessage: MessageHandler): Promise<void> {
  const gen = connectionGeneration;
  fs.mkdirSync(WHATSAPP_AUTH_DIR, { recursive: true });
  const { state, saveCreds } = await useMultiFileAuthState(WHATSAPP_AUTH_DIR);

  // Fetch latest WA Web version to avoid 405 rejection from stale bundled version
  let version: [number, number, number] | undefined;
  try {
    const result = await fetchLatestBaileysVersion();
    if (result.version) {
      version = result.version;
      log.info(`[whatsapp] Using WA Web version ${version.join(".")}`);
    }
  } catch {
    log.warn("[whatsapp] Failed to fetch latest WA version, using bundled default");
  }

  const sock = makeWASocket({
    auth: state,
    ...(version && { version }),
    logger: baileysLogger,
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      // Print QR to terminal as fallback
      try {
        const terminalQR = await QRCode.toString(qr, { type: "terminal", small: true });
        console.log(terminalQR);
        log.info("[whatsapp] QR code printed above — scan with WhatsApp to link");
      } catch {
        log.warn("[whatsapp] Failed to render QR in terminal");
      }

      // Send to pairing listener (web UI) if active
      if (pairingListener) {
        try {
          const dataUrl = await QRCode.toDataURL(qr);
          pairingListener({ type: "qr", dataUrl });
        } catch {
          log.warn("[whatsapp] Failed to generate QR data URL");
        }
      }
    }

    if (connection === "open") {
      connected = true;
      consecutiveFailures = 0;
      pairingRequired = false;
      notifySlack("connected");
      if (sock.user?.id) {
        ownJid = sock.user.id.split(":")[0].split("@")[0];
        log.info(`[whatsapp] Bot JID: ${ownJid}`);
      }
      log.info("[whatsapp] Connected");

      if (pairingListener) {
        try {
          pairingListener({ type: "connected" });
        } finally {
          clearPairingState();
        }
      }
    }

    if (connection === "close") {
      connected = false;
      ownJid = null;
      // If this connection has been superseded by stop(), don't reconnect
      if (gen !== connectionGeneration) return;
      const statusCode =
        (lastDisconnect?.error as Boom)?.output?.statusCode ??
        (lastDisconnect?.error as Boom)?.output?.payload?.statusCode;

      if (statusCode === DisconnectReason.loggedOut) {
        log.error("[whatsapp] Logged out — delete auth state and re-scan QR code");
        clearAuthState();
        pairingRequired = true;
        notifySlack("pairing-required", "Logged out by WhatsApp");
        if (pairingListener) {
          try {
            pairingListener({ type: "error", message: "Logged out by WhatsApp" });
          } finally {
            clearPairingState();
          }
        }
        return;
      }

      // 405 = registration rejected (stale device credentials)
      // 500 = badSession (corrupted local state)
      // Both indicate permanently invalid auth — retrying is pointless.
      if (statusCode === 405 || statusCode === DisconnectReason.badSession) {
        log.warn(`[whatsapp] Stale session (status ${statusCode}) — clearing auth state`);
        clearAuthState();
        pairingRequired = true;
        notifySlack("pairing-required", `Stale session (status ${statusCode})`);
        log.info("[whatsapp] Pair via web UI at /whatsapp");
        if (pairingListener) {
          try {
            pairingListener({ type: "error", message: "Session expired, auth cleared" });
          } finally {
            clearPairingState();
          }
        }
        return;
      }

      consecutiveFailures++;

      if (consecutiveFailures >= MAX_FAILURES_BEFORE_CLEAR) {
        log.warn(`[whatsapp] ${consecutiveFailures} consecutive failures — clearing stale auth state`);
        clearAuthState();
        pairingRequired = true;
        notifySlack("pairing-required", `${consecutiveFailures} consecutive connection failures`);
        log.info("[whatsapp] Pair via web UI at /whatsapp");
        if (pairingListener) {
          try {
            pairingListener({ type: "error", message: "Too many failures, auth cleared" });
          } finally {
            clearPairingState();
          }
        }
        return;
      }

      const delay = getBackoffDelay();
      log.warn(`[whatsapp] Disconnected (status ${statusCode}), reconnecting in ${delay / 1000}s...`);
      reconnectTimer = setTimeout(() => {
        connect(onMessage).catch((err) => {
          log.error(`[whatsapp] Reconnect failed: ${err}`);
          reportError("whatsapp:reconnect", "reconnect attempt failed", err).catch(() => {});
        });
      }, delay);
    }
  });

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;

    for (const msg of messages) {
      try {
        await handleIncoming(msg, onMessage);
      } catch (err) {
        log.warn(`[whatsapp] Error handling message: ${err}`);
      }
    }
  });

  socket = sock;
}

function clearPairingState(): void {
  pairingListener = null;
  if (pairingTimeout) {
    clearTimeout(pairingTimeout);
    pairingTimeout = null;
  }
}

export async function start(onMessage: MessageHandler): Promise<void> {
  storedOnMessage = onMessage;

  if (!hasAuthState()) {
    pairingRequired = true;
    notifySlack("pairing-required", "No auth state found");
    log.info("[whatsapp] No auth state — pair via web UI at /whatsapp");
    return;
  }

  await connect(onMessage);
}

export async function startPairing(listener: PairingListener): Promise<void> {
  if (pairingListener) {
    listener({ type: "error", message: "Pairing already in progress" });
    return;
  }

  if (!storedOnMessage) {
    listener({ type: "error", message: "WhatsApp not initialized — call start() first" });
    return;
  }

  // Stop existing connection if any
  await stop();

  // Clear stale auth state for fresh pairing
  clearAuthState();
  consecutiveFailures = 0;
  pairingRequired = false;

  pairingListener = listener;

  // Set a timeout for pairing
  pairingTimeout = setTimeout(() => {
    if (pairingListener) {
      pairingListener({ type: "timeout" });
      clearPairingState();
      stop().catch(() => {});
      pairingRequired = true;
      notifySlack("pairing-required", "Pairing attempt timed out");
    }
  }, PAIRING_TIMEOUT_MS);

  try {
    await connect(storedOnMessage);
  } catch (err) {
    clearPairingState();
    pairingRequired = true;
    notifySlack("pairing-required", "Pairing connection failed");
    throw err;
  }
}

export function stopPairing(): void {
  if (pairingListener) {
    clearPairingState();
    stop().catch(() => {});
    pairingRequired = true;
  }
}

/** Force-cancel any active pairing session so a new one can start. */
export function cancelPairing(): void {
  clearPairingState();
  stop().catch(() => {});
  pairingRequired = true;
}

export async function unpair(): Promise<void> {
  await stop();
  clearAuthState();
  pairingRequired = true;
  log.info("[whatsapp] Unpaired — auth state cleared");
}

async function handleIncoming(
  msg: WAMessage,
  onMessage: MessageHandler,
): Promise<void> {
  const messageId = msg.key.id;
  if (!messageId) return;

  // Deduplication
  if (processedIds.has(messageId)) return;
  processedIds.add(messageId);
  if (processedIds.size > MAX_PROCESSED_IDS) {
    // Evict oldest entries (Set maintains insertion order)
    const iter = processedIds.values();
    for (let i = 0; i < 1000; i++) iter.next();
    // Rebuild set without first 1000 entries
    const arr = [...processedIds];
    processedIds.clear();
    for (const id of arr.slice(1000)) processedIds.add(id);
  }

  // Skip own messages
  if (msg.key.fromMe) return;

  const jid = msg.key.remoteJid;
  if (!jid) return;

  // Skip group messages
  if (isGroupMessage(jid)) return;

  // Skip messages where remoteJid is our own number (corrupted metadata from decrypt retry)
  if (ownJid && jid.split("@")[0] === ownJid) {
    log.warn(`[whatsapp] Received message with own JID as remoteJid (likely decrypt retry artifact) — skipping`);
    return;
  }

  // Allowlist check — use remoteJidAlt to resolve LID JIDs to phone numbers
  if (!isAllowed(jid, msg.key.remoteJidAlt)) {
    log.info(
      `[whatsapp] Ignoring message from non-allowlisted number: ${jid}` +
      (msg.key.remoteJidAlt ? ` (alt: ${msg.key.remoteJidAlt})` : ""),
    );
    return;
  }

  // Log decryption failures — Baileys delivers these as CIPHERTEXT stubs with no message body
  if (msg.messageStubType != null && !msg.message) {
    log.warn(
      `[whatsapp] Received undecryptable message from ${jid} ` +
      `(stubType=${msg.messageStubType}, params=${JSON.stringify(msg.messageStubParameters ?? [])})`,
    );
    return;
  }

  const message = msg.message;
  if (!message) return;

  // Send read receipt (blue ticks) to the sender
  if (socket) {
    try {
      await socket.readMessages([msg.key]);
    } catch (err) {
      log.warn(`[whatsapp] Failed to send read receipt: ${err}`);
    }
  }

  // Handle text messages
  const text = message.conversation || message.extendedTextMessage?.text;

  // Handle voice notes
  const audioBuffer = message.audioMessage ? await downloadAudio(message) : undefined;

  // Handle unsupported media types
  if (
    !text &&
    !audioBuffer &&
    (message.imageMessage || message.videoMessage || message.documentMessage)
  ) {
    await sendMessage(jid, "Sorry, only text messages and voice notes are supported at the moment.");
    return;
  }

  if (!text && !audioBuffer) return;

  // Check if audio was too large
  if (message.audioMessage && !audioBuffer) {
    await sendMessage(jid, "That voice note is too large to process. Please keep voice notes under 10 minutes.");
    return;
  }

  await onMessage({
    from: jid,
    text: text ?? undefined,
    audioBuffer,
    messageId,
  });
}

export async function sendMessage(jid: string, text: string): Promise<void> {
  if (!socket) {
    log.warn("[whatsapp] Cannot send message: not connected");
    return;
  }
  await socket.sendMessage(jid, { text });
}

export async function stop(): Promise<void> {
  connectionGeneration++;
  lastNotifiedState = null;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  clearPairingState();
  if (socket) {
    socket.end(undefined);
    socket = null;
    connected = false;
    log.info("[whatsapp] Stopped");
  }
}
