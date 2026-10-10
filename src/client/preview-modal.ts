// Overlay modal for the collapsed plan / requirements previews on /board and
// /issues (`details.preview-peek`). The page carries one <dialog> (see
// PREVIEW_MODAL_HTML in src/pages/layout.ts); a click on a preview's summary
// copies that preview into it. Without `showModal` the click is left alone and
// the <details> expands inline, which is also the no-JS behaviour.
(function clawsPreviewModal() {
  let opener: HTMLElement | null = null;

  function init() {
    const dialog = document.getElementById("preview-modal") as HTMLDialogElement | null;
    if (!dialog) return;
    const title = dialog.querySelector<HTMLElement>("#preview-modal-title");
    const body = dialog.querySelector<HTMLElement>(".preview-modal-body");
    const foot = dialog.querySelector<HTMLElement>(".preview-modal-foot");
    const link = dialog.querySelector<HTMLAnchorElement>(".preview-modal-link");
    if (!title || !body || !foot || !link) return;
    if (dialog.dataset.wired) return;
    dialog.dataset.wired = "1";

    document.addEventListener("click", (ev: Event) => {
      const target = ev.target as Element | null;
      const summary = target && target.closest ? target.closest("summary") : null;
      const details = summary ? summary.parentElement : null;
      if (!summary || !details || !details.matches("details.preview-peek")) return;
      if (typeof dialog.showModal !== "function") return;
      if (dialog.open) return;
      ev.preventDefault();
      title.textContent = summary.textContent;
      const md = details.querySelector(".markdown");
      body.innerHTML = md ? md.innerHTML : "";
      const anchors = details.querySelectorAll("a");
      const last = anchors.length ? anchors[anchors.length - 1] : null;
      if (last) {
        link.href = last.getAttribute("href") ?? "#";
        link.textContent = last.textContent;
        foot.hidden = false;
      } else {
        foot.hidden = true;
      }
      opener = summary as HTMLElement;
      dialog.showModal();
    });

    dialog.querySelector(".preview-modal-close")?.addEventListener("click", () => dialog.close());
    dialog.addEventListener("click", (ev: Event) => {
      if (ev.target === dialog) dialog.close();
    });
    dialog.addEventListener("close", () => {
      body.innerHTML = "";
      if (opener) opener.focus();
      opener = null;
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

  // Exposed for the jsdom unit test.
  (window as unknown as { clawsPreviewModalInit: () => void }).clawsPreviewModalInit = init;
})();

export {};
