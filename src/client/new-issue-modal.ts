// The New issue modal on /board and /issues (`buildNewIssueModal` in
// src/pages/issue.ts). A click on `[data-new-issue-open]` opens the page's one
// `#new-issue-modal` instead of following the link to /issues/new; without
// `showModal` the click is left alone, which is also the no-JS behaviour.
//
// The form posts to `POST /issues` with `Accept: application/json`. On success
// the modal swaps to a confirmation with a link to the new issue, and the same
// message is left in `.new-issue-status` beside the button; the page is not
// reloaded, so the board's filter and fold state survive. On an error the
// message shows in `.new-issue-error` and every field keeps what was typed.
// Closing the dialog never clears the form.
//
// A page that would otherwise reload itself (the Issues list's 60s refresh)
// sets `data-reload-seconds` on the dialog; the reload is put off while the
// dialog is open or the form holds a typed title or body.
(function clawsNewIssueModal() {
  let opener: HTMLElement | null = null;

  function init() {
    const dialog = document.getElementById("new-issue-modal") as HTMLDialogElement | null;
    if (!dialog) return;
    const form = dialog.querySelector<HTMLFormElement>("form[data-new-issue-form]");
    const title = dialog.querySelector<HTMLInputElement>("[data-new-issue-title]");
    const error = dialog.querySelector<HTMLElement>(".new-issue-error");
    const done = dialog.querySelector<HTMLElement>("[data-new-issue-done]");
    const doneText = dialog.querySelector<HTMLElement>("[data-new-issue-done-text]");
    const doneLink = dialog.querySelector<HTMLAnchorElement>("[data-new-issue-link]");
    if (!form || !title || !error || !done || !doneText || !doneLink) return;
    if (dialog.dataset.wired) return;
    dialog.dataset.wired = "1";

    function submitButtons(): HTMLButtonElement[] {
      return Array.from(form!.querySelectorAll<HTMLButtonElement>('button[type="submit"]'));
    }

    function showError(message: string): void {
      error!.textContent = message;
      error!.hidden = false;
      for (const b of submitButtons()) b.disabled = false;
    }

    function showForm(): void {
      done!.hidden = true;
      form!.hidden = false;
      title!.focus();
    }

    function writeStatus(id: string, url: string): void {
      for (const status of Array.from(document.querySelectorAll<HTMLElement>(".new-issue-status"))) {
        status.textContent = "Created #" + id + " — ";
        const a = document.createElement("a");
        a.href = url;
        a.textContent = "Open issue";
        status.appendChild(a);
      }
    }

    document.addEventListener("click", (ev: Event) => {
      const target = ev.target as Element | null;
      const trigger = target && target.closest ? target.closest<HTMLElement>("[data-new-issue-open]") : null;
      if (!trigger) return;
      if (typeof dialog.showModal !== "function") return;
      if (dialog.open) return;
      ev.preventDefault();
      opener = trigger;
      dialog.showModal();
      // A confirmation from the last create stays in the status line; the
      // dialog itself reopens on the form.
      showForm();
    });

    dialog.querySelector(".preview-modal-close")?.addEventListener("click", () => dialog.close());
    dialog.querySelector("[data-new-issue-cancel]")?.addEventListener("click", () => dialog.close());
    dialog.querySelector("[data-new-issue-again]")?.addEventListener("click", () => showForm());
    dialog.addEventListener("click", (ev: Event) => {
      if (ev.target === dialog) dialog.close();
    });
    dialog.addEventListener("close", () => {
      if (opener) opener.focus();
      opener = null;
    });

    form.addEventListener("submit", (ev: Event) => {
      ev.preventDefault();
      error.hidden = true;
      error.textContent = "";
      for (const b of submitButtons()) b.disabled = true;
      const body = new URLSearchParams();
      new FormData(form).forEach((value, key) => {
        if (typeof value === "string") body.append(key, value);
      });
      void (async () => {
        let result: { ok?: boolean; id?: string; url?: string; error?: string } | null = null;
        let status = 0;
        try {
          const res = await fetch(form.action, {
            method: "POST",
            headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
            body: body.toString(),
            credentials: "same-origin",
          });
          status = res.status;
          result = await res.json().catch(() => null);
        } catch (err) {
          showError("Could not create the issue: " + String(err));
          return;
        }
        if (!result || !result.ok || !result.id || !result.url) {
          showError(result?.error ?? "Could not create the issue (" + status + ")");
          return;
        }
        form.reset();
        const pending = form.querySelector("[data-attachment-inputs]");
        if (pending) pending.innerHTML = "";
        for (const b of submitButtons()) b.disabled = false;
        doneText.textContent = "Created #" + result.id + ".";
        doneLink.href = result.url;
        form.hidden = true;
        done.hidden = false;
        doneLink.focus();
        writeStatus(result.id, result.url);
      })();
    });

    const reloadSeconds = Number(dialog.dataset.reloadSeconds ?? "");
    if (reloadSeconds > 0) {
      const tick = () => {
        if (dialog.open || title.value.trim() !== "" || (form.querySelector<HTMLTextAreaElement>("textarea[name=body]")?.value ?? "").trim() !== "") {
          setTimeout(tick, reloadSeconds * 1000);
          return;
        }
        location.reload();
      };
      setTimeout(tick, reloadSeconds * 1000);
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

  // Exposed for the jsdom unit test.
  (window as unknown as { clawsNewIssueModalInit: () => void }).clawsNewIssueModalInit = init;
})();

export {};
