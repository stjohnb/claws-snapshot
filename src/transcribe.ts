import { z } from "zod";
import { OPENAI_API_KEY, WHISPER_BASE_URL, WHISPER_LOCAL_URL, WHISPER_MODEL } from "./config.js";
import * as log from "./log.js";
import { isShuttingDown } from "./shutdown.js";
import { sleep } from "./util.js";

const TranscribeResponseSchema = z.object({ text: z.string() });

const MAX_ATTEMPTS = 3;

const WHISPER_CIRCUIT_BREAKER_DISABLE_MS = 5 * 60 * 1000;

interface Breaker {
  failures: number;
  disabledUntil: number;
}
const whisperBreakers = new Map<string, Breaker>();
function getBreaker(url: string): Breaker {
  let b = whisperBreakers.get(url);
  if (!b) {
    b = { failures: 0, disabledUntil: 0 };
    whisperBreakers.set(url, b);
  }
  return b;
}

export class WhisperRateLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WhisperRateLimitError";
  }
}

/** OpenAI billing quota is exhausted — retrying will not help; an operator must act. */
export class WhisperQuotaExhaustedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WhisperQuotaExhaustedError";
  }
}

export function clearWhisperLocalAvailabilityCache(): void {
  whisperBreakers.clear();
}

function whisperServerUrls(): string[] {
  return [...new Set([WHISPER_LOCAL_URL, WHISPER_BASE_URL].filter(Boolean))];
}

/** Whether transcription is available (a Whisper server or OpenAI). */
export function isAvailable(): boolean {
  return whisperServerUrls().length > 0 || !!OPENAI_API_KEY;
}

async function transcribeWithWhisperServer(
  baseUrl: string,
  audio: Buffer,
  filename: string,
  prompt?: string,
): Promise<string> {
  const blob = new Blob([new Uint8Array(audio)], { type: "audio/ogg" });
  const form = new FormData();
  form.append("file", blob, filename);
  form.append("model", WHISPER_MODEL);
  if (prompt) {
    form.append("prompt", prompt);
  }

  const breaker = getBreaker(baseUrl);

  let response: Response;
  try {
    response = await fetch(`${baseUrl.replace(/\/$/, "")}/v1/audio/transcriptions`, {
      method: "POST",
      body: form,
      signal: AbortSignal.timeout(60_000),
    });
  } catch (err) {
    breaker.failures++;
    if (breaker.failures >= 3) {
      breaker.disabledUntil = Date.now() + WHISPER_CIRCUIT_BREAKER_DISABLE_MS;
      log.warn(`[transcribe] Whisper (${baseUrl}) circuit breaker tripped after ${breaker.failures} failures, disabling for 5 minutes`);
    }
    throw err;
  }

  if (!response.ok) {
    const body = await response.text();
    log.warn(`[transcribe] Whisper (${baseUrl}) error (HTTP ${response.status}): ${body.slice(0, 500)}`);
    if (response.status !== 429) {
      breaker.failures++;
      if (breaker.failures >= 3) {
        breaker.disabledUntil = Date.now() + WHISPER_CIRCUIT_BREAKER_DISABLE_MS;
        log.warn(`[transcribe] Whisper (${baseUrl}) circuit breaker tripped after ${breaker.failures} failures, disabling for 5 minutes`);
      }
    }
    throw new Error(`Whisper (${baseUrl}) returned HTTP ${response.status}`);
  }

  const result = TranscribeResponseSchema.parse(await response.json());
  breaker.failures = 0;
  return result.text;
}

/** Transcribe an audio buffer using local-first Whisper servers, falling back to OpenAI. */
export async function transcribe(
  audio: Buffer,
  filename = "voice-note.ogg",
  prompt?: string,
): Promise<string> {
  const servers = whisperServerUrls();
  if (servers.length === 0 && !OPENAI_API_KEY) {
    throw new Error("Voice transcription unavailable: set CLAWS_WHISPER_LOCAL_URL, CLAWS_WHISPER_BASE_URL, or OPENAI_API_KEY");
  }

  let lastError: unknown = null;
  let anyAttempted = false;
  let anySkippedByBreaker = false;
  for (const url of servers) {
    const breaker = getBreaker(url);
    if (breaker.disabledUntil > Date.now()) {
      anySkippedByBreaker = true;
      continue;
    }
    anyAttempted = true;
    try {
      return await transcribeWithWhisperServer(url, audio, filename, prompt);
    } catch (err) {
      lastError = err;
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`[transcribe] Whisper server ${url} failed, trying next backend: ${msg}`);
    }
  }

  if (!OPENAI_API_KEY) {
    const lastErrorIs429 = lastError instanceof Error && lastError.message.includes("HTTP 429");
    if (lastErrorIs429) throw new WhisperRateLimitError("All Whisper servers rate-limited or unavailable");
    if (!anyAttempted && anySkippedByBreaker) {
      throw new Error("Voice transcription unavailable: all configured Whisper servers are temporarily disabled and OPENAI_API_KEY is not set");
    }
    if (lastError) throw lastError instanceof Error ? lastError : new Error(String(lastError));
    throw new Error("Voice transcription unavailable: all Whisper servers failed and OPENAI_API_KEY is not set");
  }

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    // Rebuilt every attempt: the Blob backing the FormData is a single-use
    // stream, so re-POSTing the same body fails with "body already used".
    const blob = new Blob([new Uint8Array(audio)], { type: "audio/ogg" });
    const form = new FormData();
    form.append("file", blob, filename);
    form.append("model", "whisper-1");
    if (prompt) {
      form.append("prompt", prompt);
    }

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

    // Billing quota exhausted — retrying is pure latency, and reporting it as a
    // transient rate limit hides the outage (see #1920, #1931, #2121).
    if (response.status === 429 && body.includes("insufficient_quota")) {
      throw new WhisperQuotaExhaustedError(
        "OpenAI Whisper quota exhausted (insufficient_quota) — top up billing or fix a self-hosted Whisper server",
      );
    }

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
