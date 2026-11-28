/** One pinned nav link's badge: the visible count text (empty for none) and the link's accessible name. */
export interface NavEntry {
  href: string;
  text: string;
  name: string;
}

/** Mirror `buildNav`'s pinned links: `aria-label` and a `.nav-count` badge (`99+` above 99) only when `text` is non-empty. */
export function applyNav(nav: NavEntry[]): void {
  for (const entry of nav) {
    const link = document.querySelector<HTMLAnchorElement>(`nav a[href="${entry.href}"]`);
    if (!link) continue;
    let badge = link.querySelector<HTMLElement>(".nav-count");
    if (!entry.text) {
      link.removeAttribute("aria-label");
      badge?.remove();
      continue;
    }
    link.setAttribute("aria-label", entry.name);
    if (!badge) {
      badge = document.createElement("span");
      badge.className = "nav-count";
      badge.setAttribute("aria-hidden", "true");
      link.appendChild(badge);
    }
    badge.textContent = entry.text;
  }
}
