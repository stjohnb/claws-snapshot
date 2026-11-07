// The operator's optional Initial prompt from a dashboard New Session form:
// their own first message, handed to the agent CLI at pod launch.

/** Longest Initial prompt accepted, after normalising; the form's `maxlength` matches. */
export const MAX_SESSION_INITIAL_PROMPT_CHARS = 16_000;

/**
 * Normalise a submitted Initial prompt: CRLF becomes LF and the result is
 * trimmed. Returns null for a missing, non-string or blank value, which means
 * the session starts with no prompt. Callers enforce
 * `MAX_SESSION_INITIAL_PROMPT_CHARS` on the result.
 */
export function normalizeInitialPrompt(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const text = raw.replace(/\r\n?/g, "\n").trim();
  return text === "" ? null : text;
}
