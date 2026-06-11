import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import nodemailer from "nodemailer";
import * as config from "../config.js";
import * as claude from "../claude.js";
import * as log from "../log.js";
import { reportError } from "../error-reporter.js";
import { guardContent, makeGuardCtx } from "../prompt-guard.js";
import { getModel } from "../model-selector.js";
import { sleep } from "../util.js";

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

  const imapConfig = {
    host: "imap.gmail.com",
    port: 993,
    secure: true,
    auth: {
      user: config.EMAIL_USER,
      pass: config.EMAIL_APP_PASSWORD,
    },
    logger: false as const,
    connectionTimeout: 30_000,
  };

  let client!: ImapFlow;

  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      client = new ImapFlow(imapConfig);
      try {
        await client.connect();
        break;
      } catch (err) {
        if (attempt === 0) {
          log.warn(`[email-monitor] IMAP connect failed, retrying in 5s: ${err}`);
          await sleep(5000);
        } else {
          throw err;
        }
      }
    }
    await client.mailboxOpen("INBOX");

    // Search for all unseen emails — Claude extraction classifies content
    const searchResult = await client.search({
      seen: false,
    });

    emailStatus.lastCheck = new Date().toISOString();
    emailStatus.lastError = null;

    const messages = searchResult || [];
    if (messages.length === 0) {
      log.info("[email-monitor] No new unread emails found");
      await client.logout();
      return;
    }

    log.info(`[email-monitor] Found ${messages.length} unread email(s)`);

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
  const source = (msg as { source?: Buffer }).source;
  if (!source) throw new Error(`Could not fetch email UID ${uid}`);

  const parsed = await simpleParser(source);
  const emailBody = parsed.text;

  if (!emailBody) {
    log.warn(`[email-monitor] Could not extract text body from email UID ${uid}`);
    await client.messageFlagsAdd(uid, ["\\Seen"]);
    return;
  }

  // Step 1: Extract vegetable list via Claude
  const guardCtx = makeGuardCtx("email-monitor", uid);
  const extractPrompt = [
    "You are reading the body of an email that may contain a weekly vegetable box list.",
    "Look for any list of vegetables in the email. If there are multiple size sections",
    "(e.g. Regular, Large), prefer the Regular size list. If there are no size sections,",
    "extract whatever vegetable list you can find.",
    "Return the items as a plain list, one item per line, with no bullet points or numbers.",
    "If this email does not contain a vegetable list, return exactly: NOT_FOUND",
    "",
    "Email body:",
    guardContent(emailBody, guardCtx("email-body")),
  ].join("\n");

  const vegListResult = await claude.runClaude(extractPrompt, process.cwd(), { capability: "text-only", tier: "sonnet", agent: "plan" });

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

  const recipes = await claude.runClaude(recipePrompt, process.cwd(), { capability: "text-only", tier: "sonnet", agent: "plan" });

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
