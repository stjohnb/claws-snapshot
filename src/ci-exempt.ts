/** Paths CI workflows commonly `paths-ignore` (docs/**, Markdown, LICENSE).
 * A commit touching only these can end up with zero check runs at all. */
export function isCiExemptPath(path: string): boolean {
  return path.startsWith("docs/") || path.endsWith(".md") || path === "LICENSE";
}
