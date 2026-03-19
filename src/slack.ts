import { SLACK_WEBHOOK, SLACK_BOT_TOKEN, SLACK_IDEAS_CHANNEL } from "./config.js";

let lastResult: "ok" | "error" | null = null;

export function notify(text: string): void {
  if (!SLACK_WEBHOOK) {
    console.debug("Slack notify skipped: no webhook configured");
    return;
  }

  fetch(SLACK_WEBHOOK, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  })
    .then((response) => {
      lastResult = response.ok ? "ok" : "error";
      if (!response.ok) {
        console.log(`Slack notify failed: HTTP ${response.status}`);
      }
    })
    .catch((err) => {
      lastResult = "error";
      console.log(`Slack notify failed: ${err}`);
    });
}

export function slackStatus(): {
  configured: boolean;
  lastResult: "ok" | "error" | null;
} {
  return { configured: !!SLACK_WEBHOOK, lastResult };
}

// ── Slack Bot Web API (for idea threads) ──

export function isSlackBotConfigured(): boolean {
  return !!SLACK_BOT_TOKEN && !!SLACK_IDEAS_CHANNEL;
}

export async function postMessage(
  channel: string,
  text: string,
  threadTs?: string,
): Promise<string> {
  if (!SLACK_BOT_TOKEN) {
    throw new Error("Slack bot token not configured");
  }

  const payload: Record<string, string> = { channel, text };
  if (threadTs) payload.thread_ts = threadTs;

  const response = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${SLACK_BOT_TOKEN}`,
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    throw new Error(`Slack API HTTP error: ${response.status}`);
  }

  const data = (await response.json()) as { ok: boolean; ts?: string; error?: string };
  if (!data.ok) {
    throw new Error(`Slack API error: ${data.error}`);
  }

  return data.ts!;
}

export interface SlackReaction {
  name: string;
  count: number;
  users: string[];
}

export async function getReactions(
  channel: string,
  messageTs: string,
): Promise<SlackReaction[]> {
  if (!SLACK_BOT_TOKEN) {
    throw new Error("Slack bot token not configured");
  }

  const params = new URLSearchParams({ channel, timestamp: messageTs });
  const response = await fetch(
    `https://slack.com/api/reactions.get?${params}`,
    {
      headers: { Authorization: `Bearer ${SLACK_BOT_TOKEN}` },
    },
  );

  if (!response.ok) {
    throw new Error(`Slack API HTTP error: ${response.status}`);
  }

  const data = (await response.json()) as {
    ok: boolean;
    message?: { reactions?: SlackReaction[] };
    error?: string;
  };

  if (!data.ok) {
    throw new Error(`Slack API error: ${data.error}`);
  }

  return data.message?.reactions ?? [];
}
