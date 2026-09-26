/** Elision marker inserted where the middle of a log was dropped. */
export const LOG_ELISION_MARKER = "… [Claws elided N characters of log] …";

// CSI sequences (e.g. `\x1b[33m` SGR colour codes) and OSC sequences (e.g. hyperlinks).
const ANSI_CSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
const ANSI_OSC_RE = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;

/** Strips ANSI escape sequences (colour codes, hyperlinks) from log text so pattern
 *  matching sees the same text a human would in a terminal. `gh api .../logs` refuses to
 *  print a body containing raw escape sequences without `--allow-escape-sequences`, and
 *  Docker/buildx build output is colourised, so callers must pass that flag and then strip
 *  here before slicing or pattern-matching. Leaves `\r` and other control characters alone. */
export function stripAnsi(text: string): string {
  return text.replace(ANSI_CSI_RE, "").replace(ANSI_OSC_RE, "");
}

export function excerptLog(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  if (maxChars < 10) return text.slice(-maxChars);

  const headLen = Math.floor(maxChars * 0.2);
  const head = text.slice(0, headLen);
  const droppedCount = text.length - maxChars;
  const marker = LOG_ELISION_MARKER.replace("N", String(droppedCount));
  const tailStart = text.length - (maxChars - headLen);
  const tail = text.slice(tailStart);

  return `${head}\n\n${marker}\n\n${tail}`;
}
