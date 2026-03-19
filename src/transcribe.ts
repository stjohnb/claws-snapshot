import { OPENAI_API_KEY } from "./config.js";
import * as log from "./log.js";

/** Whether the OpenAI Whisper API is available for transcription. */
export function isAvailable(): boolean {
  return !!OPENAI_API_KEY;
}

/** Transcribe an audio buffer using the OpenAI Whisper API. */
export async function transcribe(
  audio: Buffer,
  filename = "voice-note.ogg",
  prompt?: string,
): Promise<string> {
  if (!OPENAI_API_KEY) {
    throw new Error("Voice transcription unavailable: OPENAI_API_KEY not set");
  }

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
    },
  );

  if (!response.ok) {
    const body = await response.text();
    log.warn(`Whisper API error (HTTP ${response.status}): ${body.slice(0, 500)}`);
    throw new Error(`Whisper API returned HTTP ${response.status}`);
  }

  const result = (await response.json()) as { text: string };
  return result.text;
}
