/** Elision marker inserted where the middle of a log was dropped. */
export const LOG_ELISION_MARKER = "… [Claws elided N characters of log] …";

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
