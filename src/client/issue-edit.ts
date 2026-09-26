// Auto-save for the Labels and Repositories forms on /issues/:id. Plain DOM, no
// Alpine. Each `form[data-autosave]` still posts to its own route
// (`POST /issues/:id/labels` / `/repos`, rendered by src/pages/issue.ts and
// parsed by src/server.ts) — the client only sends it on `change` with
// `Accept: application/json` instead of waiting for the Save button, which it
// hides. Without JS the button and the 303 redirect still work.
//
// Changes are debounced so ticking several boxes sends one request, and each
// form has at most one request in flight: a change during flight re-sends once
// it settles. A failed save puts the checkboxes back to the last saved state.
//
// Also wires the header's inline title editor (`#issue-title-edit`, posting
// to the same `/edit` route as the collapsed Edit section, title only) and
// the copy-URL button (`#issue-copy-url`); both report through
// `#issue-head-status`.

// Everything below is scoped to this IIFE: the client tsconfig compiles
// src/client/*.ts as one program of plain scripts, so top-level names here
// would collide with another bundle's.
(function clawsIssueEdit() {
  const DEBOUNCE_MS = 400;

  // Mirrors `repoShortName()` in src/pages/layout.ts.
  function repoShortName(fullName: string): string {
    const slash = fullName.indexOf("/");
    return slash >= 0 ? fullName.slice(slash + 1) : fullName;
  }

  function checkboxes(form: HTMLFormElement): HTMLInputElement[] {
    return Array.from(form.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'));
  }

  function checkedValues(form: HTMLFormElement): string[] {
    return checkboxes(form).filter((cb) => cb.checked).map((cb) => cb.value);
  }

  function setStatus(form: HTMLFormElement, text: string, error = false): void {
    const el = form.querySelector<HTMLElement>(".autosave-status");
    if (!el) return;
    el.textContent = text;
    el.classList.toggle("autosave-status-error", error);
  }

  /** Rebuild the header's label chips from the chips the checkbox list renders. */
  function refreshLabels(form: HTMLFormElement): void {
    const row = document.getElementById("issue-labels");
    if (!row) return;
    const chips = checkboxes(form)
      .filter((cb) => cb.checked)
      .map((cb) => cb.closest("label")?.querySelector<HTMLElement>(".label-chip")?.cloneNode(true))
      .filter((chip): chip is Node => !!chip);
    row.replaceChildren(...chips);
  }

  function repoChip(fullName: string): HTMLElement {
    const [owner, name] = fullName.split("/");
    if (!owner || !name) {
      const span = document.createElement("span");
      span.className = "repo-chip";
      span.textContent = fullName;
      return span;
    }
    const a = document.createElement("a");
    a.className = "repo-chip";
    // Mirrors `repoUrl()` in src/pages/repo.ts.
    a.href = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
    a.textContent = repoShortName(fullName);
    a.title = fullName;
    return a;
  }

  /** Rebuild the header's repository chips, the no-repository and unmanaged-primary warnings and the multi-repo note. */
  function refreshRepos(form: HTMLFormElement): void {
    const repos = checkedValues(form);
    document.getElementById("issue-repos")?.replaceChildren(...repos.map(repoChip));
    const banner = document.getElementById("issue-repo-warning");
    if (banner) banner.hidden = repos.length > 0;
    // Every repo this form can save is managed, so a save always clears it.
    const unmanaged = document.getElementById("issue-repo-unmanaged");
    if (unmanaged) unmanaged.hidden = true;
    const note = document.getElementById("issue-repo-primary");
    if (note) note.hidden = repos.length < 2;
    // Mirrors `primaryRepo()` in src/claws-issues.ts.
    const primaryFull = [...repos].sort()[0] ?? "";
    const primary = document.getElementById("issue-repo-primary-name");
    if (primary) {
      primary.textContent = repoShortName(primaryFull);
      primary.title = primaryFull;
    }
  }

  function attach(form: HTMLFormElement): void {
    const kind = form.dataset["autosave"];
    const submit = form.querySelector<HTMLElement>("[data-autosave-submit]");
    if (submit) submit.hidden = true;

    let lastSaved = checkedValues(form);
    let timer: ReturnType<typeof setTimeout> | null = null;
    let inFlight = false;
    let pending = false;

    function restore(): void {
      const saved = new Set(lastSaved);
      for (const cb of checkboxes(form)) cb.checked = saved.has(cb.value);
    }

    async function save(): Promise<void> {
      if (inFlight) {
        pending = true;
        return;
      }
      inFlight = true;
      const values = checkedValues(form);
      const body = new URLSearchParams();
      for (const cb of checkboxes(form)) {
        if (cb.checked) body.append(cb.name, cb.value);
      }
      setStatus(form, "Saving…");
      let ok = false;
      try {
        const res = await fetch(form.action, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
          body: body.toString(),
          credentials: "same-origin",
        });
        ok = res.ok;
      } catch {
        ok = false;
      }
      inFlight = false;
      if (ok) {
        lastSaved = values;
        if (kind === "labels") refreshLabels(form);
        if (kind === "repos") refreshRepos(form);
        if (pending) {
          pending = false;
          void save();
          return;
        }
        setStatus(form, "Saved");
      } else {
        pending = false;
        restore();
        setStatus(form, "Save failed — reload the page.", true);
      }
    }

    form.addEventListener("change", () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        void save();
      }, DEBOUNCE_MS);
    });
  }

  function setHeadStatus(text: string, error = false): void {
    const el = document.getElementById("issue-head-status");
    if (!el) return;
    el.textContent = text;
    el.classList.toggle("icon-status-error", error);
  }

  /** The header's inline title editor: pencil button swaps the `<h2>` text for a full-width input. */
  function attachTitleEdit(): void {
    const editBtn = document.getElementById("issue-title-edit");
    const textEl = document.getElementById("issue-title-text");
    const form = document.getElementById("issue-title-form") as HTMLFormElement | null;
    const cancelBtn = document.getElementById("issue-title-cancel") as HTMLButtonElement | null;
    const editTitleInput = document.getElementById("issue-edit-title") as HTMLInputElement | null;
    const input = form?.querySelector<HTMLInputElement>('input[name="title"]') ?? null;
    const submitBtn = form?.querySelector<HTMLButtonElement>('button[type="submit"]') ?? null;
    if (!editBtn || !textEl || !form || !cancelBtn || !input || !submitBtn) return;

    // The short-ref span (e.g. "#clw_GZ5PDC") sits beside #issue-title-text
    // inside the same <h2>; document.title is rebuilt from it after a save.
    function shortRefText(): string {
      const h2 = textEl!.closest("h2");
      const span = h2?.querySelector<HTMLElement>("span:not(#issue-title-text)");
      return span?.textContent ?? "";
    }

    function openEditor(): void {
      input!.value = textEl!.textContent ?? "";
      textEl!.hidden = true;
      form!.hidden = false;
      setHeadStatus("");
      input!.focus();
      input!.select();
    }

    function closeEditor(): void {
      form!.hidden = true;
      textEl!.hidden = false;
    }

    let saving = false;

    function restore(): void {
      if (saving) return;
      input!.value = textEl!.textContent ?? "";
      closeEditor();
      setHeadStatus("");
    }

    editBtn.addEventListener("click", openEditor);
    cancelBtn.addEventListener("click", restore);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Escape") restore();
    });
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      if (saving) return;
      const value = input!.value.trim();
      if (!value) {
        setHeadStatus("Title is required", true);
        return;
      }
      saving = true;
      submitBtn!.disabled = true;
      cancelBtn!.disabled = true;
      setHeadStatus("Saving…");
      void (async () => {
        try {
          const res = await fetch(form!.action, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
            body: new URLSearchParams({ title: value }).toString(),
            credentials: "same-origin",
          });
          if (!res.ok) throw new Error("save failed");
          textEl!.textContent = value;
          document.title = `claws — ${shortRefText()} ${value}`;
          if (editTitleInput) editTitleInput.value = value;
          closeEditor();
          setHeadStatus("Saved");
        } catch {
          setHeadStatus("Save failed — reload the page.", true);
        } finally {
          saving = false;
          submitBtn!.disabled = false;
          cancelBtn!.disabled = false;
        }
      })();
    });
  }

  /** Copies the issue's permalink to the clipboard, falling back to the hidden-textarea execCommand trick used in pages/reauth.ts on non-secure origins. */
  function attachCopyUrl(): void {
    const btn = document.getElementById("issue-copy-url");
    if (!btn) return;

    function showResult(ok: boolean): void {
      setHeadStatus(ok ? "Copied" : "Copy failed", !ok);
      setTimeout(() => setHeadStatus(""), 1500);
    }

    function fallback(url: string): void {
      let ok = false;
      try {
        const ta = document.createElement("textarea");
        ta.value = url;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.focus();
        ta.select();
        ok = document.execCommand("copy");
        document.body.removeChild(ta);
      } catch {
        ok = false;
      }
      showResult(ok);
    }

    btn.addEventListener("click", () => {
      const raw = btn.getAttribute("data-copy-url") ?? "";
      const url = new URL(raw, location.href).href;
      if (!navigator.clipboard?.writeText) {
        fallback(url);
        return;
      }
      navigator.clipboard.writeText(url).then(() => showResult(true), () => fallback(url));
    });
  }

  function init(): void {
    for (const form of Array.from(document.querySelectorAll<HTMLFormElement>("form[data-autosave]"))) {
      attach(form);
    }
    attachTitleEdit();
    attachCopyUrl();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

  // Exposed for the jsdom unit test.
  (window as unknown as { clawsIssueEditInit: () => void }).clawsIssueEditInit = init;
})();
