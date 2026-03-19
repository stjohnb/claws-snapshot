import { type Repo } from "../config.js";
import * as claude from "../claude.js";
import * as gh from "../github.js";
import * as log from "../log.js";
import { reportError } from "../error-reporter.js";
import { transcribe, isAvailable as transcribeAvailable } from "../transcribe.js";
import { sendMessage, type WhatsAppMessage, type MessageHandler } from "../whatsapp.js";

const MAX_BODY_LENGTH = 10_000;

export function createHandler(
  listRepos: () => Promise<Repo[]>,
): MessageHandler {
  return async (msg: WhatsAppMessage) => {
    log.info(`[whatsapp-handler] Message from ${msg.from} (id: ${msg.messageId})`);

    try {
      let text = msg.text ?? "";

      // Transcribe voice notes
      if (msg.audioBuffer) {
        if (!transcribeAvailable()) {
          await sendMessage(
            msg.from,
            "Voice notes aren't supported yet — OPENAI_API_KEY is not configured. Please send a text message instead.",
          );
          return;
        }

        log.info("[whatsapp-handler] Transcribing voice note...");
        text = await transcribe(msg.audioBuffer, "voice-note.ogg", "Kwyjibo, Claws, GitHub");
        log.info(`[whatsapp-handler] Transcription: ${text.slice(0, 200)}`);
      }

      if (!text.trim()) {
        await sendMessage(msg.from, "I couldn't understand that message. Please send a text or voice note describing the issue you'd like to create.");
        return;
      }

      // Truncate excessively long messages
      if (text.length > MAX_BODY_LENGTH) {
        text = text.slice(0, MAX_BODY_LENGTH);
      }

      // Get available repos
      const repos = await listRepos();
      if (repos.length === 0) {
        await sendMessage(msg.from, "No repositories found. Check Claws configuration.");
        return;
      }

      const repoList = repos
        .map((r) => `- ${r.fullName}`)
        .join("\n");

      // Ask Claude to interpret the message
      const prompt = [
        "You are processing a WhatsApp message from a user who wants to create a GitHub issue.",
        "",
        "Available repositories:",
        repoList,
        "",
        `User's message:`,
        `"${text}"`,
        "",
        "Respond with ONLY a JSON object (no markdown fences, no explanation):",
        '{',
        '  "repo": "owner/repo",',
        '  "title": "Issue title"',
        '}',
        "",
        "If the user doesn't specify a repo, pick the most likely one based on context.",
        "If the message is unclear or not an issue request, set \"repo\" to null.",
        "Keep the title concise (under 80 chars).",
      ].join("\n");

      const claudeResult = await claude.enqueue(() =>
        claude.runClaude(prompt, process.cwd()),
      );

      // Parse Claude's response
      let parsed: { repo: string | null; title: string };
      try {
        // Strip markdown fences if Claude included them
        const cleaned = claudeResult
          .replace(/^```(?:json)?\s*/m, "")
          .replace(/```\s*$/m, "")
          .trim();
        parsed = JSON.parse(cleaned);
      } catch {
        log.warn(`[whatsapp-handler] Failed to parse Claude response: ${claudeResult.slice(0, 500)}`);
        await sendMessage(msg.from, "I had trouble understanding your message. Could you try rephrasing it?");
        return;
      }

      if (!parsed.repo) {
        await sendMessage(msg.from, "I couldn't determine which repository this issue belongs to. Could you specify the repo or rephrase your idea?");
        return;
      }

      // Validate the repo exists in our list
      const targetRepo = repos.find((r) => r.fullName === parsed.repo);
      if (!targetRepo) {
        await sendMessage(
          msg.from,
          `I don't have access to "${parsed.repo}". Available repos:\n${repos.map((r) => `• ${r.fullName}`).join("\n")}`,
        );
        return;
      }

      // Create the issue with the raw user text as the body
      const body = msg.audioBuffer
        ? `*Transcribed from a voice note.*\n\n${text}`
        : text;
      const issueNumber = await gh.createIssue(
        targetRepo.fullName,
        parsed.title,
        body,
        [],
      );

      const issueUrl = `https://github.com/${targetRepo.fullName}/issues/${issueNumber}`;
      await sendMessage(
        msg.from,
        `Created issue #${issueNumber} in ${targetRepo.fullName}\n${issueUrl}`,
      );
      log.info(`[whatsapp-handler] Created issue ${issueUrl}`);
    } catch (err) {
      log.error(`[whatsapp-handler] Error processing message: ${err}`);
      reportError("whatsapp-handler:process-message", msg.from, err).catch(() => {});
      await sendMessage(
        msg.from,
        "Something went wrong while creating your issue. Please try again later.",
      );
    }
  };
}

export type { WhatsAppMessage, MessageHandler };
