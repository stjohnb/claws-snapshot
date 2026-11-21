/**
 * The Mark step done confirmation on /board and the issue page
 * (`STEP_DONE_DIALOG_HTML` in src/pages/layout.ts). An in-page `<dialog>`
 * replaces the native `confirm()`, which a home-screen PWA can answer false
 * without showing anything, so a press used to end silently. The step's
 * title and manual-action text go in as `textContent`, never HTML.
 * Falls back to `window.confirm` when the page has no dialog or the browser
 * has no `showModal`.
 */

/** The fallback `window.confirm` text: the title and manual-action text, capped like the server's. */
function fallbackText(title: string, text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const msg = `Mark "${title}" done?${flat ? ` ${flat}` : ""}`;
  return msg.length > 600 ? `${msg.slice(0, 599)}…` : msg;
}

/**
 * Ask the operator to confirm marking a step done. Resolves true on Mark
 * done, false on Cancel, Escape or a backdrop click; focus returns to the
 * element that had it when the dialog opened.
 */
export function confirmStepDone(title: string, text: string): Promise<boolean> {
  const dialog = document.getElementById("step-done-dialog") as HTMLDialogElement | null;
  const step = dialog?.querySelector<HTMLElement>(".step-done-dialog-step");
  const body = dialog?.querySelector<HTMLElement>(".step-done-dialog-text");
  const ok = dialog?.querySelector<HTMLButtonElement>(".step-done-dialog-confirm");
  const cancel = dialog?.querySelector<HTMLButtonElement>(".step-done-dialog-cancel");
  if (!dialog || !step || !body || !ok || !cancel || typeof dialog.showModal !== "function") {
    return Promise.resolve(window.confirm(fallbackText(title, text)));
  }
  if (dialog.open) return Promise.resolve(false);
  step.textContent = title;
  body.textContent = text;
  body.hidden = text.trim() === "";
  const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  return new Promise<boolean>((resolve) => {
    let confirmed = false;
    const onOk = () => { confirmed = true; dialog.close(); };
    const onCancel = () => dialog.close();
    const onBackdrop = (ev: Event) => { if (ev.target === dialog) dialog.close(); };
    const onClose = () => {
      ok.removeEventListener("click", onOk);
      cancel.removeEventListener("click", onCancel);
      dialog.removeEventListener("click", onBackdrop);
      dialog.removeEventListener("close", onClose);
      if (opener && opener.isConnected) opener.focus();
      resolve(confirmed);
    };
    ok.addEventListener("click", onOk);
    cancel.addEventListener("click", onCancel);
    dialog.addEventListener("click", onBackdrop);
    dialog.addEventListener("close", onClose);
    dialog.showModal();
    ok.focus();
  });
}
