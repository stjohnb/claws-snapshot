export type DiffOp = { op: "same" | "add" | "del"; text: string };
export type LineDiff = { ops: DiffOp[] } | { tooLarge: true };

function splitLines(s: string): string[] {
  return s === "" ? [] : s.split(/\r?\n/);
}

/**
 * Line diff of `a` (old) against `b` (new): a plain O(n·m) LCS over lines,
 * with the common prefix and suffix trimmed first. Inputs over `maxLines`
 * lines in total return `{ tooLarge: true }` instead of a diff.
 */
export function lineDiff(a: string, b: string, maxLines = 3000): LineDiff {
  const x = splitLines(a);
  const y = splitLines(b);
  if (x.length + y.length > maxLines) return { tooLarge: true };

  let start = 0;
  while (start < x.length && start < y.length && x[start] === y[start]) start++;
  let endX = x.length;
  let endY = y.length;
  while (endX > start && endY > start && x[endX - 1] === y[endY - 1]) {
    endX--;
    endY--;
  }

  const ops: DiffOp[] = x.slice(0, start).map((text) => ({ op: "same", text }));
  const mx = x.slice(start, endX);
  const my = y.slice(start, endY);
  const n = mx.length;
  const m = my.length;
  // lcs[i * (m + 1) + j] = LCS length of mx[i..] and my[j..].
  const lcs = new Uint32Array((n + 1) * (m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i * (m + 1) + j] = mx[i] === my[j]
        ? lcs[(i + 1) * (m + 1) + j + 1]! + 1
        : Math.max(lcs[(i + 1) * (m + 1) + j]!, lcs[i * (m + 1) + j + 1]!);
    }
  }
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (mx[i] === my[j]) {
      ops.push({ op: "same", text: mx[i]! });
      i++;
      j++;
    } else if (lcs[(i + 1) * (m + 1) + j]! >= lcs[i * (m + 1) + j + 1]!) {
      ops.push({ op: "del", text: mx[i]! });
      i++;
    } else {
      ops.push({ op: "add", text: my[j]! });
      j++;
    }
  }
  while (i < n) ops.push({ op: "del", text: mx[i++]! });
  while (j < m) ops.push({ op: "add", text: my[j++]! });

  for (const text of x.slice(endX)) ops.push({ op: "same", text });
  return { ops };
}
