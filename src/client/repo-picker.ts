// New issue form: names the selected repositories under the phone repo strip
// so a tap is confirmed without scrolling the strip. Tapping a name un-selects
// it. Without JS the form keeps the CSS "N selected" count.
(function clawsRepoPicker() {
  function render(form: HTMLElement, list: HTMLElement): void {
    const checked = Array.from(form.querySelectorAll<HTMLInputElement>("input[name=repo]:checked"));
    list.textContent = "";
    if (checked.length === 0) {
      list.textContent = "No repository selected";
      return;
    }
    for (const input of checked) {
      const text = input.closest("label")?.querySelector(".check-text")?.cloneNode(true) as HTMLElement | undefined;
      text?.querySelectorAll(".repo-avatar").forEach((a) => a.remove());
      const short = text?.textContent?.trim() || input.value;
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "repo-selected-chip";
      btn.setAttribute("aria-label", "Remove " + input.value);
      btn.textContent = short + " ×";
      btn.addEventListener("click", () => {
        input.checked = false;
        input.dispatchEvent(new Event("change", { bubbles: true }));
      });
      list.appendChild(btn);
    }
  }

  function init(): void {
    for (const list of Array.from(document.querySelectorAll<HTMLElement>("[data-repo-selected]"))) {
      const form = list.closest("form");
      if (!form || list.dataset["repoPickerReady"]) continue;
      list.dataset["repoPickerReady"] = "1";
      list.hidden = false;
      const count = form.querySelector<HTMLElement>(".repo-picker-count");
      if (count) count.hidden = true;
      const update = () => render(form, list);
      form.addEventListener("change", update);
      form.addEventListener("reset", () => setTimeout(update, 0));
      update();
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

  // Exposed for the jsdom unit test.
  (window as unknown as { clawsRepoPickerInit: () => void }).clawsRepoPickerInit = init;
})();
