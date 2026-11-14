/**
 * The approval track's ⋯ withdrawal menu (`details.approval-menu`,
 * src/pages/approval-track.ts): a `<details>` so it opens without script, with
 * the `role="menu"` behaviour added here — one menu open at a time, focus on
 * the first item on open, ArrowDown/ArrowUp/Home/End between items, Escape
 * closing it back to its ⋯ button, Tab and an outside pointer closing it.
 * An open list is placed `position: fixed` from its ⋯ button, so a scrolling
 * board column cannot clip it, and a scroll or resize outside it closes it.
 * Listeners are delegated, so a track swapped in later is covered too.
 */

const MENU = "details.approval-menu";
const ITEM = '[role="menuitem"]';
const LIST = ".approval-menu-list";
/** Gap kept between the placed list and the viewport edge, in px. */
const EDGE = 8;

/** Roots already wired, so a re-run of a page's `init` adds no second set. */
const wired = new WeakSet<Node>();
let documentWired = false;

function setOpen(menu: HTMLDetailsElement, open: boolean): void {
  if (menu.open !== open) menu.open = open;
  menu.querySelector("summary")?.setAttribute("aria-expanded", open ? "true" : "false");
}

/**
 * Close every open approval menu under `root`, except `keep`. With
 * `refocus`, focus inside a menu being closed moves to its ⋯ button first,
 * since a hidden item cannot keep it.
 */
export function closeApprovalMenus(root: ParentNode, keep?: Element | null, opts?: { refocus?: boolean }): void {
  root.querySelectorAll<HTMLDetailsElement>(`${MENU}[open]`).forEach((menu) => {
    if (menu === keep) return;
    if (opts?.refocus && menu.contains(document.activeElement)) {
      menu.querySelector<HTMLElement>("summary")?.focus({ preventScroll: true });
    }
    setOpen(menu, false);
  });
}

/**
 * Place an open menu's list `position: fixed` under its ⋯ button, right
 * edges aligned, kept inside the viewport and flipped above the button when
 * there is no room below — so a column body's scroll box cannot clip it.
 */
function placeList(menu: HTMLDetailsElement): void {
  const summary = menu.querySelector<HTMLElement>("summary");
  const list = menu.querySelector<HTMLElement>(LIST);
  if (!summary || !list) return;
  list.style.position = "fixed";
  list.style.right = "auto";
  list.style.removeProperty("max-height");
  const anchor = summary.getBoundingClientRect();
  const vw = document.documentElement.clientWidth || window.innerWidth;
  const vh = window.innerHeight;
  const width = list.offsetWidth;
  const height = list.offsetHeight;
  const left = Math.max(EDGE, Math.min(anchor.right - width, vw - width - EDGE));
  let top = anchor.bottom + 4;
  if (top + height > vh - EDGE && anchor.top - height - 4 >= EDGE) top = anchor.top - height - 4;
  else if (top + height > vh - EDGE) list.style.maxHeight = `${Math.max(vh - top - EDGE, 0)}px`;
  list.style.left = `${left}px`;
  list.style.top = `${top}px`;
}

function items(menu: Element): HTMLElement[] {
  return Array.from(menu.querySelectorAll<HTMLElement>(ITEM)).filter((el) => !(el as HTMLButtonElement).disabled);
}

/** Wire the menus under `root`; safe to call again on the same root. */
export function wireApprovalMenus(root: HTMLElement): void {
  if (!documentWired) {
    documentWired = true;
    document.addEventListener("pointerdown", (ev: Event) => {
      const target = ev.target as Element | null;
      const inside = target?.closest?.(MENU) ?? null;
      closeApprovalMenus(document, inside);
    }, true);
    // The placed list stays where it was put: a scroll anywhere but inside
    // it, or a resize, closes it rather than leave it detached from its ⋯.
    document.addEventListener("scroll", (ev: Event) => {
      const target = ev.target as Element | null;
      if (target?.closest?.(LIST)) return;
      closeApprovalMenus(document, null, { refocus: true });
    }, true);
    window.addEventListener("resize", () => closeApprovalMenus(document, null, { refocus: true }));
  }
  if (wired.has(root)) return;
  wired.add(root);

  // `toggle` does not bubble: taken in the capture phase.
  root.addEventListener("toggle", (ev: Event) => {
    const menu = ev.target as HTMLElement | null;
    if (!(menu instanceof HTMLDetailsElement) || !menu.matches(MENU)) return;
    menu.querySelector("summary")?.setAttribute("aria-expanded", menu.open ? "true" : "false");
    if (!menu.open) return;
    closeApprovalMenus(document, menu);
    placeList(menu);
    items(menu)[0]?.focus({ preventScroll: true });
  }, true);

  // The ⋯ button sits inside a draggable card: its clicks reach nothing else.
  root.addEventListener("click", (ev: Event) => {
    if ((ev.target as Element | null)?.closest?.(`${MENU} > summary`)) ev.stopPropagation();
  });

  root.addEventListener("keydown", (ev: Event) => {
    const key = (ev as KeyboardEvent).key;
    const target = ev.target as HTMLElement | null;
    const menu = target?.closest?.<HTMLDetailsElement>(MENU);
    if (!menu) return;
    const summary = menu.querySelector<HTMLElement>("summary");
    if (key === "Escape") {
      if (!menu.open) return;
      ev.preventDefault();
      setOpen(menu, false);
      summary?.focus({ preventScroll: true });
      return;
    }
    if (key === "Tab") {
      if (menu.open) setOpen(menu, false);
      return;
    }
    const list = items(menu);
    if (list.length === 0) return;
    const onSummary = target === summary;
    if (onSummary && key === "ArrowDown") {
      ev.preventDefault();
      setOpen(menu, true);
      list[0].focus({ preventScroll: true });
      return;
    }
    if (onSummary) return;
    const at = list.indexOf(target as HTMLElement);
    let next: number | null = null;
    if (key === "ArrowDown") next = (at + 1) % list.length;
    else if (key === "ArrowUp") next = (at - 1 + list.length) % list.length;
    else if (key === "Home") next = 0;
    else if (key === "End") next = list.length - 1;
    if (next === null) return;
    ev.preventDefault();
    list[next].focus({ preventScroll: true });
  });
}
