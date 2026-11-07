// File attachments for native issues (#3289) on /issues/:id and /issues/new.
// Plain DOM, no Alpine. Pages are rendered by src/pages/issue.ts; the routes
// live in src/server.ts.
//
// - A `textarea[data-attach-target]` takes pasted and dropped files, and the
//   hidden "Attach files" control in its form is revealed and wired. Each file
//   uploads to `/issues/<target>/attachments` (or the streaming route above
//   10 MB) and a markdown link is inserted at the cursor. `target` is the issue
//   id, or `new` on the New Issue form, where each upload also appends an
//   `attachment` hidden input so `POST /issues` can claim it.
// - `form[data-attach-form]` (the Attachments section) uploads on file pick
//   or on a drop anywhere on its `[data-attach-dropzone]` wrapper, then
//   reloads; without JS it still posts as multipart via its submit button.
// - `form[data-attachment-delete]` deletes with `Accept: application/json` and
//   removes its row; without JS it posts and redirects.

// Scoped to this IIFE: the client tsconfig compiles src/client/*.ts as one
// program of plain scripts, so top-level names here would collide.
(function clawsIssueAttachments() {
  const MAX_INLINE_UPLOAD_BYTES = 10 * 1024 * 1024;
  const MAX_UPLOAD_BYTES = 1024 * 1024 * 1024;
  const INLINE_IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];

  interface UploadedAttachment {
    id: string;
    name: string;
    url: string;
    size: number;
    contentType: string;
  }

  type UploadResult = { ok: true; attachment: UploadedAttachment } | { ok: false; error: string };

  function setStatus(el: HTMLElement | null, text: string, error = false): void {
    if (!el) return;
    el.textContent = text;
    el.classList.toggle("attach-status-error", error);
  }

  function parseUploadResponse(status: number, text: string): UploadResult {
    try {
      const json = JSON.parse(text) as { attachments?: UploadedAttachment[]; error?: string };
      const first = json.attachments?.[0];
      if (status >= 200 && status < 300 && first) return { ok: true, attachment: first };
      return { ok: false, error: json.error ?? "Upload failed (" + status + ")" };
    } catch {
      return { ok: false, error: "Upload failed (" + status + ")" };
    }
  }

  function uploadLarge(target: string, file: File, status: HTMLElement | null, feedback = false): Promise<UploadResult> {
    return new Promise((resolve) => {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", "/issues/" + encodeURIComponent(target) +
        "/attachments/stream?name=" + encodeURIComponent(file.name) + (feedback ? "&feedback=1" : ""));
      xhr.setRequestHeader("Content-Type", file.type || "application/octet-stream");
      xhr.setRequestHeader("Accept", "application/json");
      let lastPct = -1;
      xhr.upload.onprogress = (e) => {
        if (!e.lengthComputable) return;
        const pct = Math.floor((e.loaded / e.total) * 100);
        if (pct === lastPct) return;
        lastPct = pct;
        setStatus(status, "Uploading " + file.name + "… " + pct + "%");
      };
      xhr.onload = () => resolve(parseUploadResponse(xhr.status, xhr.responseText));
      xhr.onerror = () => resolve({ ok: false, error: "Upload failed — connection lost" });
      xhr.onabort = () => resolve({ ok: false, error: "Upload cancelled" });
      xhr.send(file);
    });
  }

  async function uploadFile(target: string, file: File, status: HTMLElement | null, feedback = false): Promise<UploadResult> {
    if (file.size === 0) return { ok: false, error: file.name + ": empty file — not uploaded" };
    if (file.size > MAX_UPLOAD_BYTES) return { ok: false, error: file.name + " is larger than 1 GB" };
    if (file.size > MAX_INLINE_UPLOAD_BYTES) return uploadLarge(target, file, status, feedback);
    setStatus(status, "Uploading " + file.name + "…");
    const fd = new FormData();
    fd.append("file", file, file.name);
    try {
      const res = await fetch("/issues/" + encodeURIComponent(target) + "/attachments" + (feedback ? "?feedback=1" : ""), {
        method: "POST",
        headers: { Accept: "application/json" },
        body: fd,
        credentials: "same-origin",
      });
      return parseUploadResponse(res.status, await res.text());
    } catch (err) {
      return { ok: false, error: "Upload failed: " + String(err) };
    }
  }

  /** `![name](url)` for an image the page renders inline, `[name](url)` otherwise. */
  function markdownLink(att: UploadedAttachment): string {
    const prefix = INLINE_IMAGE_TYPES.indexOf(att.contentType) >= 0 ? "!" : "";
    return prefix + "[" + att.name.replace(/[[\]]/g, "_") + "](" + att.url + ")";
  }

  function insertAtCursor(textarea: HTMLTextAreaElement, text: string): void {
    const start = textarea.selectionStart ?? textarea.value.length;
    const end = textarea.selectionEnd ?? start;
    const before = textarea.value.slice(0, start);
    const after = textarea.value.slice(end);
    const pad = before && !/\s$/.test(before) ? " " : "";
    const insert = pad + text + " ";
    textarea.value = before + insert + after;
    const caret = before.length + insert.length;
    textarea.setSelectionRange(caret, caret);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  }

  function attachTextarea(textarea: HTMLTextAreaElement): void {
    const target = textarea.dataset["attachTarget"];
    if (!target) return;
    const form = textarea.closest("form");
    const status = form?.querySelector<HTMLElement>("[data-attach-status]") ?? null;
    const pendingInputs = form?.querySelector<HTMLElement>("[data-attachment-inputs]") ?? null;
    for (const row of Array.from(form?.querySelectorAll<HTMLElement>("[data-attach-row]") ?? [])) row.hidden = false;

    async function handleFiles(files: File[]): Promise<void> {
      let failed = false;
      for (const file of files) {
        const result = await uploadFile(target!, file, status);
        if (!result.ok) {
          failed = true;
          setStatus(status, result.error, true);
          continue;
        }
        insertAtCursor(textarea, markdownLink(result.attachment));
        if (pendingInputs) {
          const input = document.createElement("input");
          input.type = "hidden";
          input.name = "attachment";
          input.value = result.attachment.id;
          pendingInputs.appendChild(input);
        }
      }
      if (!failed) setStatus(status, files.length === 1 ? "Attached " + files[0]!.name : "Attached " + files.length + " files");
    }

    textarea.addEventListener("paste", (e) => {
      const files = Array.from(e.clipboardData?.files ?? []);
      if (files.length === 0) return;
      e.preventDefault();
      void handleFiles(files);
    });
    textarea.addEventListener("dragover", (e) => {
      if (Array.from(e.dataTransfer?.types ?? []).indexOf("Files") >= 0) e.preventDefault();
    });
    textarea.addEventListener("drop", (e) => {
      const files = Array.from(e.dataTransfer?.files ?? []);
      if (files.length === 0) return;
      e.preventDefault();
      void handleFiles(files);
    });
    const picker = form?.querySelector<HTMLInputElement>("input[data-attach-input]");
    picker?.addEventListener("change", () => {
      const files = Array.from(picker.files ?? []);
      picker.value = "";
      if (files.length > 0) void handleFiles(files);
    });
  }

  /**
   * The Attachments section's form: upload each file on its own request, then
   * reload the list. Uploads fire on file pick or on a drop anywhere on the
   * enclosing `[data-attach-dropzone]`, with the submit button hidden and
   * kept only as the no-JS fallback.
   */
  function attachUploadForm(form: HTMLFormElement): void {
    const picker = form.querySelector<HTMLInputElement>('input[type="file"]');
    const status = form.querySelector<HTMLElement>("[data-attach-status]");
    const submit = form.querySelector<HTMLElement>("[data-attach-submit]");
    const target = /\/issues\/([^/]+)\/attachments$/.exec(new URL(form.action, location.href).pathname)?.[1];
    if (!picker || !target) return;

    async function uploadAll(files: File[]): Promise<void> {
      if (files.length === 0) return;
      for (const file of files) {
        const result = await uploadFile(decodeURIComponent(target!), file, status, true);
        if (!result.ok) {
          setStatus(status, result.error, true);
          return;
        }
      }
      location.reload();
    }

    if (submit) submit.hidden = true;

    form.addEventListener("submit", (e) => {
      e.preventDefault();
      void uploadAll(Array.from(picker.files ?? []));
    });
    picker.addEventListener("change", () => {
      const files = Array.from(picker.files ?? []);
      picker.value = "";
      void uploadAll(files);
    });

    const dropzone = form.closest<HTMLElement>("[data-attach-dropzone]");
    if (!dropzone) return;
    let dragDepth = 0;
    function hasFiles(e: DragEvent): boolean {
      return Array.from(e.dataTransfer?.types ?? []).indexOf("Files") >= 0;
    }
    dropzone.addEventListener("dragenter", (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      dragDepth++;
      dropzone.classList.add("drag-over");
    });
    dropzone.addEventListener("dragover", (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
    });
    dropzone.addEventListener("dragleave", (e) => {
      if (!hasFiles(e)) return;
      dragDepth = Math.max(0, dragDepth - 1);
      if (dragDepth === 0) dropzone.classList.remove("drag-over");
    });
    dropzone.addEventListener("drop", (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      dragDepth = 0;
      dropzone.classList.remove("drag-over");
      void uploadAll(Array.from(e.dataTransfer?.files ?? []));
    });
  }

  function attachDeleteForm(form: HTMLFormElement): void {
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      void (async () => {
        let ok = false;
        try {
          const res = await fetch(form.action, {
            method: "POST",
            headers: { Accept: "application/json" },
            credentials: "same-origin",
          });
          ok = res.ok;
        } catch {
          ok = false;
        }
        if (ok) {
          form.closest("[data-attachment-row]")?.remove();
        } else {
          const button = form.querySelector("button");
          if (button) button.textContent = "Delete failed — reload";
        }
      })();
    });
  }

  function init(): void {
    for (const textarea of Array.from(document.querySelectorAll<HTMLTextAreaElement>("textarea[data-attach-target]"))) {
      attachTextarea(textarea);
    }
    for (const form of Array.from(document.querySelectorAll<HTMLFormElement>("form[data-attach-form]"))) {
      attachUploadForm(form);
    }
    for (const form of Array.from(document.querySelectorAll<HTMLFormElement>("form[data-attachment-delete]"))) {
      attachDeleteForm(form);
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

  // Exposed for the jsdom unit test.
  (window as unknown as { clawsIssueAttachmentsInit: () => void }).clawsIssueAttachmentsInit = init;
})();
