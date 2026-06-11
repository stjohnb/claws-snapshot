import { z } from "zod";
import { OPENAI_API_KEY, WHISPER_BASE_URL } from "./config.js";
import * as log from "./log.js";
import { isShuttingDown } from "./shutdown.js";
import { sleep } from "./util.js";

const TranscribeResponseSchema = z.object({ text: z.string() });

const MAX_ATTEMPTS = 3;

const WHISPER_CIRCUIT_BREAKER_DISABLE_MS = 5 * 60 * 1000;
let whisperConsecutiveFailures = 0;
let whisperDisabledUntil = 0;

export class WhisperRateLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WhisperRateLimitError";
  }
}

export function clearWhisperLocalAvailabilityCache(): void {
  whisperConsecutiveFailures = 0;
  whisperDisabledUntil = 0;
}

/** Whether transcription is available (local Whisper or OpenAI). */
export function isAvailable(): boolean {
  return !!(WHISPER_BASE_URL || OPENAI_API_KEY);
}

async function transcribeWithLocalWhisper(
  audio: Buffer,
  filename: string,
  prompt?: string,
): Promise<string> {
  const blob = new Blob([new Uint8Array(audio)], { type: "audio/ogg" });
  const form = new FormData();
  form.append("file", blob, filename);
  form.append("model", "whisper-1");
  if (prompt) {
    form.append("prompt", prompt);
  }

  let response: Response;
  try {
    response = await fetch(`${WHISPER_BASE_URL.replace(/\/$/, "")}/v1/audio/transcriptions`, {
      method: "POST",
      body: form,
      signal: AbortSignal.timeout(60_000),
    });
  } catch (err) {
    whisperConsecutiveFailures++;
    if (whisperConsecutiveFailures >= 3) {
      whisperDisabledUntil = Date.now() + WHISPER_CIRCUIT_BREAKER_DISABLE_MS;
      log.warn(`[transcribe] Local Whisper circuit breaker tripped after ${whisperConsecutiveFailures} failures, disabling for 5 minutes`);
    }
    throw err;
  }

  if (!response.ok) {
    const body = await response.text();
    log.warn(`[transcribe] Local Whisper error (HTTP ${response.status}): ${body.slice(0, 500)}`);
    if (response.status !== 429) {
      whisperConsecutiveFailures++;
      if (whisperConsecutiveFailures >= 3) {
        whisperDisabledUntil = Date.now() + WHISPER_CIRCUIT_BREAKER_DISABLE_MS;
        log.warn(`[transcribe] Local Whisper circuit breaker tripped after ${whisperConsecutiveFailures} failures, disabling for 5 minutes`);
      }
    }
    throw new Error(`Local Whisper returned HTTP ${response.status}`);
  }

  const result = TranscribeResponseSchema.parse(await response.json());
  whisperConsecutiveFailures = 0;
  return result.text;
}

/** Transcribe an audio buffer using local Whisper first, falling back to OpenAI. */
export async function transcribe(
  audio: Buffer,
  filename = "voice-note.ogg",
  prompt?: string,
): Promise<string> {
  if (!WHISPER_BASE_URL && !OPENAI_API_KEY) {
    throw new Error("Voice transcription unavailable: set WHISPER_BASE_URL or OPENAI_API_KEY");
  }

  if (WHISPER_BASE_URL && whisperDisabledUntil <= Date.now()) {
    try {
      return await transcribeWithLocalWhisper(audio, filename, prompt);
    } catch (err) {
      log.warn(`[transcribe] Local Whisper failed, falling back to OpenAI: ${err}`);
      if (!OPENAI_API_KEY) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("HTTP 429")) throw new WhisperRateLimitError(msg);
        throw err;
      }
    }
  }

  if (WHISPER_BASE_URL && !OPENAI_API_KEY) {
    throw new Error("Voice transcription unavailable: local Whisper is temporarily disabled and OPENAI_API_KEY is not set");
  }

  const blob = new Blob([new Uint8Array(audio)], { type: "audio/ogg" });
  const form = new FormData();
  form.append("file", blob, filename);
  form.append("model", "whisper-1");
  if (prompt) {
    form.append("prompt", prompt);
  }

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const response = await fetch(
      "https://api.openai.com/v1/audio/transcriptions",
      {
        method: "POST",
        headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
        body: form,
        signal: AbortSignal.timeout(30_000),
      },
    );

    if (response.ok) {
      const result = TranscribeResponseSchema.parse(await response.json());
      return result.text;
    }

    const body = await response.text();
    log.warn(`Whisper API error (HTTP ${response.status}): ${body.slice(0, 500)}`);

    // Non-retryable errors: fail immediately
    if (response.status !== 429 && response.status < 500) {
      throw new Error(`Whisper API returned HTTP ${response.status}`);
    }

    // Out of retries
    if (attempt >= MAX_ATTEMPTS || isShuttingDown()) {
      if (response.status === 429) {
        throw new WhisperRateLimitError(`Whisper API returned HTTP 429`);
      }
      throw new Error(`Whisper API returned HTTP ${response.status}`);
    }

    // Compute delay: respect Retry-After header for 429, else exponential backoff
    let delayMs = 1000 * 2 ** (attempt - 1); // 1s, 2s
    if (response.status === 429) {
      const retryAfter = response.headers.get("Retry-After");
      if (retryAfter) {
        const parsed = parseInt(retryAfter, 10);
        if (!isNaN(parsed)) delayMs = Math.min(parsed * 1000, 30_000);
      }
    }

    log.warn(`Whisper API transient error (attempt ${attempt}/${MAX_ATTEMPTS}), retrying in ${delayMs}ms`);
    await sleep(delayMs);
  }

  // Should never reach here
  throw new Error("Whisper API transcription failed after retries");
}
