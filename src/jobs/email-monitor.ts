import { ImapFlow } from "imapflow";
import nodemailer from "nodemailer";
import * as config from "../config.js";
import * as claude from "../claude.js";
import * as log from "../log.js";
import { reportError } from "../error-reporter.js";

let emailStatus = {
  configured: false,
  lastCheck: null as string | null,
  lastError: null as string | null,
};

export function getEmailStatus(): typeof emailStatus {
  return emailStatus;
}

export async function run(): Promise<void> {
  if (!config.EMAIL_ENABLED) {
    emailStatus = { configured: false, lastCheck: null, lastError: null };
    return;
  }

  if (!config.EMAIL_USER || !config.EMAIL_APP_PASSWORD) {
    emailStatus = { configured: false, lastCheck: null, lastError: null };
    log.warn("[email-monitor] Email enabled but user or app password not configured");
    return;
  }

  emailStatus.configured = true;

  const client = new ImapFlow({
    host: "imap.gmail.com",
    port: 993,
    secure: true,
    auth: {
      user: config.EMAIL_USER,
      pass: config.EMAIL_APP_PASSWORD,
    },
    logger: false,
  });

  try {
    await client.connect();
    await client.mailboxOpen("INBOX");

    // Search for unseen emails from the veg box sender with matching subject
    const searchResult = await client.search({
      seen: false,
      from: config.EMAIL_VEG_BOX_SENDER,
      subject: "Veg Content",
    });

    emailStatus.lastCheck = new Date().toISOString();
    emailStatus.lastError = null;

    const messages = searchResult || [];
    if (messages.length === 0) {
      log.info("[email-monitor] No new veg box emails found");
      await client.logout();
      return;
    }

    log.info(`[email-monitor] Found ${messages.length} veg box email(s)`);

    for (const uid of messages) {
      try {
        await processVegBoxEmail(client, uid);
      } catch (err) {
        log.error(`[email-monitor] Error processing email UID ${uid}: ${err}`);
        reportError("email-monitor:process", `Failed to process email UID ${uid}`, err).catch(() => {});
      }
    }

    await client.logout();
  } catch (err) {
    emailStatus.lastError = String(err);
    log.error(`[email-monitor] IMAP error: ${err}`);
    reportError("email-monitor:poll", "Email monitor IMAP connection failed", err).catch(() => {});
    try { await client.logout(); } catch { /* best effort */ }
  }
}

async function processVegBoxEmail(client: ImapFlow, uid: number): Promise<void> {
  const msg = await client.fetchOne(uid, { source: true });
  if (!msg) throw new Error(`Could not fetch email UID ${uid}`);
  const rawSource = msg.source?.toString("utf-8") ?? "";

  // Extract plain text body from the raw email source
  const emailBody = extractPlainText(rawSource);

  if (!emailBody) {
    log.warn(`[email-monitor] Could not extract text body from email UID ${uid}`);
    await client.messageFlagsAdd(uid, ["\\Seen"]);
    return;
  }

  // Step 1: Extract Regular Veg Size items via Claude
  const extractPrompt = [
    "You are reading the body of a weekly vegetable box email from Helen's Bay Organic.",
    "Extract ONLY the items listed under the \"Regular Veg Size\" section.",
    "Return the items as a plain list, one item per line, with no bullet points or numbers.",
    "If you cannot find a \"Regular Veg Size\" section or similar, return exactly: NOT_FOUND",
    "",
    "Email body:",
    emailBody,
  ].join("\n");

  const vegListResult = await claude.enqueue(() =>
    claude.runClaude(extractPrompt, process.cwd()),
  );

  const vegList = vegListResult.trim();

  if (vegList === "NOT_FOUND" || !vegList) {
    log.warn(`[email-monitor] Could not extract veg list from email UID ${uid}`);
    await client.messageFlagsAdd(uid, ["\\Seen"]);
    return;
  }

  log.info(`[email-monitor] Extracted veg list:\n${vegList}`);

  // Step 2: Generate recipes via Claude
  const recipePrompt = [
    "Given the following vegetables from this week's organic veg box, suggest 3-5 recipe ideas.",
    "For each recipe, provide:",
    "- Recipe name",
    "- Brief description (1-2 sentences)",
    "- Key steps (3-5 bullet points)",
    "",
    "Keep it practical and family-friendly. Format as plain text suitable for an email.",
    "",
    "This week's vegetables:",
    vegList,
  ].join("\n");

  const recipes = await claude.enqueue(() =>
    claude.runClaude(recipePrompt, process.cwd()),
  );

  // Step 3: Send recipe email
  const today = new Date().toISOString().slice(0, 10);
  const subject = `Veg Box Recipes — ${today}`;
  const body = [
    `This Week's Veg Box (${today})`,
    "=".repeat(40),
    "",
    vegList,
    "",
    "Recipe Ideas",
    "=".repeat(40),
    "",
    recipes.trim(),
  ].join("\n");

  await sendEmail(subject, body);
  log.info(`[email-monitor] Sent recipe email to ${config.EMAIL_RECIPIENT}`);

  // Mark as read so we don't reprocess
  await client.messageFlagsAdd(uid, ["\\Seen"]);
}

function extractPlainText(rawSource: string): string {
  // Try to find the plain text part in a multipart message
  // Look for Content-Type: text/plain section
  const boundaryMatch = rawSource.match(/boundary="([^"]+)"/);
  if (boundaryMatch) {
    const boundary = boundaryMatch[1];
    const parts = rawSource.split("--" + boundary);
    for (const part of parts) {
      if (part.includes("text/plain")) {
        // Extract content after the headers (double newline)
        const headerEnd = part.indexOf("\r\n\r\n");
        if (headerEnd < 0) continue;
        let content = part.slice(headerEnd + 4);
        // Remove trailing boundary marker
        const nextBoundary = content.indexOf("--" + boundary);
        if (nextBoundary > 0) content = content.slice(0, nextBoundary);
        // Handle quoted-printable encoding
        if (part.includes("quoted-printable")) {
          content = decodeQuotedPrintable(content);
        }
        return content.trim();
      }
    }
  }

  // Fallback: try to extract body after headers
  const headerEnd = rawSource.indexOf("\r\n\r\n");
  if (headerEnd >= 0) {
    return rawSource.slice(headerEnd + 4).trim();
  }

  return rawSource;
}

function decodeQuotedPrintable(input: string): string {
  return input
    .replace(/=\r?\n/g, "") // Remove soft line breaks
    .replace(/=([0-9A-Fa-f]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

async function sendEmail(subject: string, body: string): Promise<void> {
  const transporter = nodemailer.createTransport({
    host: "smtp.gmail.com",
    port: 465,
    secure: true,
    auth: {
      user: config.EMAIL_USER,
      pass: config.EMAIL_APP_PASSWORD,
    },
  });

  await transporter.sendMail({
    from: config.EMAIL_USER,
    to: config.EMAIL_RECIPIENT,
    subject,
    text: body,
  });
}
