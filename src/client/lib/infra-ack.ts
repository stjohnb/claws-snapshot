/**
 * The Approve infra changes block's buttons (`.infra-ack-approve`,
 * `.infra-ack-withdraw`, src/pages/infra-ack.ts) on a board card and the
 * issue page: `POST /board/infra-ack` `{repo, ref, hash, withdraw}` with the
 * block's `data-repo`/`data-ref`/`data-hash`, then swap the block for the
 * server's re-rendered one, kept open. A refusal shows inside the block and
 * re-enables the button; a refusal that carries a re-rendered block (the
 * declarations changed since the page rendered) swaps that in first, so the
 * operator reviews the new list before approving again.
 */

/** What one click came to: `ok` when the server recorded it, `ignored` when nothing was posted, else the refusal shown in the block. */
export interface InfraAckResult {
  ok: boolean;
  ignored?: boolean;
  error?: string;
}

/** Whether a click on `button` would post: its block is present and idle and the button enabled. */
export function infraAckClickable(button: HTMLButtonElement): boolean {
  const block = button.closest<HTMLElement>(".infra-ack");
  return !!block && !button.disabled && block.getAttribute("aria-busy") !== "true";
}

/** Post one click; resolves `ok` when the server recorded it, else with the refusal it showed. */
export async function postInfraAck(button: HTMLButtonElement): Promise<InfraAckResult> {
  const block = button.closest<HTMLElement>(".infra-ack");
  if (!block || !infraAckClickable(button)) return { ok: false, ignored: true };
  const withdraw = button.classList.contains("infra-ack-withdraw");
  const buttons = Array.from(block.querySelectorAll<HTMLButtonElement>("button"));
  block.setAttribute("aria-busy", "true");
  for (const b of buttons) b.disabled = true;
  block.querySelector(".infra-ack-error")?.remove();
  let message: string;
  try {
    const res = await fetch("/board/infra-ack", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repo: block.dataset["repo"] ?? "", ref: block.dataset["ref"] ?? "", hash: block.dataset["hash"] ?? "", withdraw }),
    });
    const data = (await res.json().catch(() => ({}))) as { ok?: boolean; block?: string; error?: string };
    if (res.ok && data.ok) {
      const fresh = swapBlock(block, data.block ?? "");
      fresh?.querySelector<HTMLButtonElement>("button")?.focus();
      return { ok: true };
    }
    message = data.error ?? `Could not ${withdraw ? "withdraw" : "approve"} the infra changes (HTTP ${res.status})`;
    // The declarations changed since the page rendered: show the new list, with the refusal under it.
    if (res.status === 409 && data.block) {
      const fresh = swapBlock(block, data.block);
      if (fresh) {
        showError(fresh, message);
        fresh.querySelector<HTMLButtonElement>("button")?.focus();
        return { ok: false, error: message };
      }
    }
  } catch {
    message = `Could not ${withdraw ? "withdraw" : "approve"} the infra changes (network error)`;
  }
  block.removeAttribute("aria-busy");
  for (const b of buttons) b.disabled = false;
  showError(block, message);
  return { ok: false, error: message };
}

/** Replace `block` with the server's rendered one, kept open; null (block removed) when the server sent none. */
function swapBlock(block: HTMLElement, html: string): HTMLDetailsElement | null {
  const tpl = document.createElement("template");
  tpl.innerHTML = html.trim();
  const fresh = tpl.content.firstElementChild as HTMLDetailsElement | null;
  if (!fresh) {
    block.remove();
    return null;
  }
  fresh.open = true;
  block.replaceWith(fresh);
  return fresh;
}

function showError(block: HTMLElement, message: string): void {
  const error = document.createElement("p");
  error.className = "infra-ack-error";
  error.setAttribute("role", "alert");
  error.textContent = message;
  (block.querySelector(".infra-ack-body") ?? block).appendChild(error);
}
