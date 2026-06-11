/**
 * Multi-strategy JSON extraction for LLM outputs that may contain backticks or
 * braces inside quoted string values.
 */
export function extractJsonCandidates(output: string): string[] {
  const candidates: string[] = [];

  // Strategy 1: greedy fence — handles bodies that contain ``` because we
  // anchor on the LAST closing fence in the output, not the first.
  const greedyFence = output.match(/```json\s*([\s\S]*)```/);
  if (greedyFence) candidates.push(greedyFence[1].trim());

  // Strategy 2: original non-greedy fence (fallback for trailing prose after
  // the fence that contains stray ```).
  const lazyFence = output.match(/```json\s*([\s\S]*?)```/);
  if (lazyFence) candidates.push(lazyFence[1].trim());

  // Strategy 3: brace-balanced extraction starting at the last '{' before the
  // first top-level key found in the output. Walks the string while respecting
  // JSON string escapes so embedded braces and backticks inside quoted values
  // don't throw off balance.
  const firstKeyIdx = output.search(/"[a-zA-Z_][a-zA-Z0-9_]*"\s*:/);
  if (firstKeyIdx !== -1) {
    let start = -1;
    for (let i = firstKeyIdx; i >= 0; i--) {
      if (output[i] === "{") { start = i; break; }
    }
    if (start !== -1) {
      let depth = 0;
      let inString = false;
      let escape = false;
      for (let i = start; i < output.length; i++) {
        const ch = output[i];
        if (escape) { escape = false; continue; }
        if (inString) {
          if (ch === "\\") { escape = true; continue; }
          if (ch === '"') inString = false;
          continue;
        }
        if (ch === '"') { inString = true; continue; }
        if (ch === "{") depth++;
        else if (ch === "}") {
          depth--;
          if (depth === 0) {
            candidates.push(output.slice(start, i + 1));
            break;
          }
        }
      }
    }
  }

  return [...new Set(candidates)];
}
