// The issue page's Mark step done form (`.step-done-form`, src/pages/issue.ts):
// confirm through the in-page dialog (`confirmStepDone`) before the form
// posts. Without script the form posts straight away, unconfirmed.
import { confirmStepDone } from "./lib/step-done-dialog.js";

(function clawsStepDone() {
  function init() {
    if (document.documentElement.dataset.stepDoneWired) return;
    document.documentElement.dataset.stepDoneWired = "1";
    document.addEventListener("submit", (ev: Event) => {
      const form = ev.target as HTMLFormElement | null;
      if (!form || !form.matches || !form.matches("form.step-done-form")) return;
      ev.preventDefault();
      if (form.dataset.busy) return;
      const button = form.querySelector<HTMLButtonElement>("button[type=submit]");
      const title = form.dataset.stepTitle ?? button?.textContent ?? "this step";
      void confirmStepDone(title, form.dataset.stepText ?? "").then((yes) => {
        if (!yes) return;
        form.dataset.busy = "1";
        if (button) button.disabled = true;
        form.submit();
      });
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

  // Exposed for the jsdom unit test.
  (window as unknown as { clawsStepDoneInit: () => void }).clawsStepDoneInit = init;
})();

export {};
