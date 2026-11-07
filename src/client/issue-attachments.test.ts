// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import "./issue-attachments.js";

const ISSUE = "clw_01JBQ7X4M2K8NV3TYRW9GZ5PDC";
const ATT = "cla_01JBQ7X4M2K8NV3TYRW9GZ5PD1";

/** The parts of the markup src/pages/issue.ts produces that the script touches. */
function render(target: string): void {
  document.body.innerHTML = `
    <form class="issue-form" method="POST" action="/issues">
      <textarea name="body" data-attach-target="${target}">Intro</textarea>
      <div class="attach-row" data-attach-row hidden>
        <label>Attach files<input type="file" multiple hidden data-attach-input></label>
        <span class="attach-status" data-attach-status></span>
      </div>
      ${target === "new" ? `<div data-attachment-inputs hidden></div>` : ""}
    </form>
    <table><tbody>
      <tr data-attachment-row><td>
        <form method="POST" action="/issues/${ISSUE}/attachments/${ATT}/delete" data-attachment-delete><button type="submit">Delete</button></form>
      </td></tr>
    </tbody></table>`;
  (window as unknown as { clawsIssueAttachmentsInit: () => void }).clawsIssueAttachmentsInit();
}

function textarea(): HTMLTextAreaElement {
  return document.querySelector("textarea")!;
}

function jsonResponse(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) } as Response;
}

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

function pick(files: File[]): void {
  const input = document.querySelector<HTMLInputElement>("input[data-attach-input]")!;
  Object.defineProperty(input, "files", { value: files, configurable: true });
  input.dispatchEvent(new Event("change"));
}

/** The Attachments section's markup: drop zone wrapping the table and upload form. */
function renderSection(): void {
  document.body.innerHTML = `
    <div class="issue-form attach-dropzone" data-attach-dropzone>
      <table><tbody></tbody></table>
      <form method="POST" action="/issues/${ISSUE}/attachments" enctype="multipart/form-data" data-attach-form>
        <input type="file" name="file" multiple required>
        <button type="submit" data-attach-submit>Attach files</button>
        <span class="attach-status" data-attach-status></span>
      </form>
    </div>`;
  (window as unknown as { clawsIssueAttachmentsInit: () => void }).clawsIssueAttachmentsInit();
}

function dropzone(): HTMLElement {
  return document.querySelector<HTMLElement>("[data-attach-dropzone]")!;
}

function sectionPicker(): HTMLInputElement {
  return document.querySelector<HTMLInputElement>('form[data-attach-form] input[type="file"]')!;
}

function dragEvent(type: string, files: boolean): Event {
  const e = new Event(type, { cancelable: true });
  Object.defineProperty(e, "dataTransfer", { value: { types: files ? ["Files"] : [], files: [] } });
  return e;
}

describe("issue attachments client", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe("on the Attachments section form", () => {
    beforeEach(() => renderSection());

    it("hides the no-JS submit button", () => {
      expect(document.querySelector<HTMLElement>("[data-attach-submit]")!.hidden).toBe(true);
    });

    it("uploads on file pick without a submit click, marked as feedback", async () => {
      const fetchMock = vi.fn(async () => jsonResponse(200, { attachments: [{ id: ATT, name: "a.txt", url: "/x", size: 1, contentType: "text/plain" }] }));
      vi.stubGlobal("fetch", fetchMock);
      vi.spyOn(console, "error").mockImplementation(() => {});
      const picker = sectionPicker();
      Object.defineProperty(picker, "files", { value: [new File(["x"], "a.txt")], configurable: true });

      picker.dispatchEvent(new Event("change"));
      await flush();

      expect(fetchMock).toHaveBeenCalledWith(`/issues/${ISSUE}/attachments?feedback=1`, expect.objectContaining({ method: "POST" }));
    });

    it("uploads a file dropped on the section", async () => {
      const fetchMock = vi.fn(async () => jsonResponse(200, { attachments: [{ id: ATT, name: "a.txt", url: "/x", size: 1, contentType: "text/plain" }] }));
      vi.stubGlobal("fetch", fetchMock);
      vi.spyOn(console, "error").mockImplementation(() => {});

      const drop = new Event("drop", { cancelable: true });
      Object.defineProperty(drop, "dataTransfer", { value: { types: ["Files"], files: [new File(["x"], "a.txt")] } });
      dropzone().dispatchEvent(drop);
      await flush();

      expect(fetchMock).toHaveBeenCalledWith(`/issues/${ISSUE}/attachments?feedback=1`, expect.objectContaining({ method: "POST" }));
    });

    it("adds and removes the drag-over class as a drag enters and leaves", () => {
      dropzone().dispatchEvent(dragEvent("dragenter", true));
      expect(dropzone().classList.contains("drag-over")).toBe(true);

      dropzone().dispatchEvent(dragEvent("dragleave", true));
      expect(dropzone().classList.contains("drag-over")).toBe(false);
    });
  });

  describe("on the New Issue form", () => {
    beforeEach(() => render("new"));

    it("reveals the attach control", () => {
      expect(document.querySelector<HTMLElement>("[data-attach-row]")!.hidden).toBe(false);
    });

    it("uploads a picked image as pending, inserts an image link and records the id", async () => {
      const url = `/issues/new/attachments/${ATT}/shot.png`;
      const fetchMock = vi.fn(async () => jsonResponse(200, { attachments: [{ id: ATT, name: "shot.png", url, size: 4, contentType: "image/png" }] }));
      vi.stubGlobal("fetch", fetchMock);
      textarea().setSelectionRange(5, 5);

      pick([new File(["PNG!"], "shot.png", { type: "image/png" })]);
      await flush();

      expect(fetchMock).toHaveBeenCalledWith("/issues/new/attachments", expect.objectContaining({ method: "POST" }));
      expect(textarea().value).toBe(`Intro ![shot.png](${url}) `);
      const hidden = document.querySelectorAll<HTMLInputElement>('input[type="hidden"][name="attachment"]');
      expect(Array.from(hidden).map((i) => i.value)).toEqual([ATT]);
    });

    it("shows the server's error for a rejected upload", async () => {
      vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(413, { error: "File too large (max 10 MB)" })));

      pick([new File(["x"], "big.bin")]);
      await flush();

      const status = document.querySelector("[data-attach-status]")!;
      expect(status.textContent).toBe("File too large (max 10 MB)");
      expect(status.classList.contains("attach-status-error")).toBe(true);
      expect(textarea().value).toBe("Intro");
    });
  });

  describe("on an issue page", () => {
    beforeEach(() => render(ISSUE));

    it("uploads a pasted file to the issue and inserts a plain link for a non-image", async () => {
      const url = `/issues/${ISSUE}/attachments/${ATT}/logs.zip`;
      const fetchMock = vi.fn(async () => jsonResponse(200, { attachments: [{ id: ATT, name: "logs.zip", url, size: 4, contentType: "application/zip" }] }));
      vi.stubGlobal("fetch", fetchMock);

      const paste = new Event("paste", { cancelable: true });
      Object.defineProperty(paste, "clipboardData", { value: { files: [new File(["PK"], "logs.zip", { type: "application/zip" })] } });
      textarea().dispatchEvent(paste);
      await flush();

      expect(paste.defaultPrevented).toBe(true);
      expect(fetchMock).toHaveBeenCalledWith(`/issues/${ISSUE}/attachments`, expect.anything());
      expect(textarea().value).toContain(`[logs.zip](${url})`);
      expect(textarea().value).not.toContain("![");
    });

    it("leaves a text-only paste alone", () => {
      const paste = new Event("paste", { cancelable: true });
      Object.defineProperty(paste, "clipboardData", { value: { files: [] } });
      textarea().dispatchEvent(paste);
      expect(paste.defaultPrevented).toBe(false);
    });

    it("deletes an attachment with a JSON request and removes its row", async () => {
      const fetchMock = vi.fn(async () => jsonResponse(200, { ok: true }));
      vi.stubGlobal("fetch", fetchMock);

      document.querySelector<HTMLFormElement>("form[data-attachment-delete]")!
        .dispatchEvent(new Event("submit", { cancelable: true }));
      await flush();

      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining(`/issues/${ISSUE}/attachments/${ATT}/delete`),
        expect.objectContaining({ method: "POST", headers: { Accept: "application/json" } }),
      );
      expect(document.querySelector("[data-attachment-row]")).toBeNull();
    });
  });
});
