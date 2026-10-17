import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  PublishError,
  listFiles,
  normaliseRef,
  normaliseRepo,
  parseKind,
  publishDirectory,
  sha8Of,
  type PagesStore,
  type PublishOptions,
} from "./pages-publish.js";

class FakeStore implements PagesStore {
  objects = new Map<string, { body: string; contentType: string }>();
  failPut: ((key: string) => boolean) | null = null;
  deleted: string[] = [];

  async putObject(key: string, body: Buffer, contentType: string): Promise<void> {
    if (this.failPut?.(key)) throw new Error(`HTTP 500 on ${key}`);
    this.objects.set(key, { body: body.toString(), contentType });
  }
  async listKeys(prefix: string): Promise<string[]> {
    return [...this.objects.keys()].filter((k) => k.startsWith(prefix));
  }
  async deleteObject(key: string): Promise<void> {
    this.deleted.push(key);
    this.objects.delete(key);
  }
}

let dir: string;
let store: FakeStore;

const opts = (over: Partial<PublishOptions> = {}): PublishOptions => ({
  repo: "ha-carlink",
  kind: "pr",
  ref: "pr-12",
  sha8: "abcdef12",
  dir,
  baseUrl: "https://pages.home.bstjohn.net",
  ...over,
});

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "pages-publish-test-"));
  store = new FakeStore();
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function write(rel: string, body = rel): void {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), body);
}

describe("publishDirectory", () => {
  it("rejects a directory with no root index.html before any request", async () => {
    write("sub/index.html");
    await expect(publishDirectory(store, opts())).rejects.toMatchObject({
      exitCode: 1,
      message: expect.stringContaining("no index.html at the root of"),
    });
    expect(store.objects.size).toBe(0);
  });

  it("uploads every regular file under the conventional prefix and returns the URL", async () => {
    write("index.html", "<h1>hi</h1>");
    write("assets/app.js");
    write(".git/HEAD");
    fs.symlinkSync(path.join(dir, "index.html"), path.join(dir, "link.html"));

    const result = await publishDirectory(store, opts());

    expect(result.url).toBe("https://pages.home.bstjohn.net/ha-carlink/pr/pr-12/abcdef12/");
    expect([...store.objects.keys()].sort()).toEqual([
      "ha-carlink/pr/pr-12/abcdef12/assets/app.js",
      "ha-carlink/pr/pr-12/abcdef12/index.html",
    ]);
    expect(store.objects.get("ha-carlink/pr/pr-12/abcdef12/index.html")).toEqual({
      body: "<h1>hi</h1>",
      contentType: "text/html; charset=utf-8",
    });
  });

  it("deletes only sibling SHAs under the same ref after a successful publish", async () => {
    write("index.html");
    for (const k of [
      "ha-carlink/pr/pr-12/00000000/index.html",
      "ha-carlink/pr/pr-12/11111111/a/b.css",
      "ha-carlink/pr/pr-123/22222222/index.html",
      "ha-carlink/issue/pr-12/33333333/index.html",
      "other/pr/pr-12/44444444/index.html",
    ]) {
      store.objects.set(k, { body: "", contentType: "" });
    }

    const result = await publishDirectory(store, opts());

    expect(store.deleted.sort()).toEqual([
      "ha-carlink/pr/pr-12/00000000/index.html",
      "ha-carlink/pr/pr-12/11111111/a/b.css",
    ]);
    expect(result.deleted).toBe(2);
    expect([...store.objects.keys()].filter((k) => k.startsWith("ha-carlink/pr/pr-12/"))).toEqual([
      "ha-carlink/pr/pr-12/abcdef12/index.html",
    ]);
    expect(store.objects.has("ha-carlink/pr/pr-123/22222222/index.html")).toBe(true);
  });

  it("deletes nothing when an upload fails", async () => {
    write("index.html");
    write("big.bin");
    store.objects.set("ha-carlink/pr/pr-12/00000000/index.html", { body: "", contentType: "" });
    store.failPut = (k) => k.endsWith("big.bin");

    await expect(publishDirectory(store, opts())).rejects.toThrow(/HTTP 500/);
    expect(store.deleted).toEqual([]);
    expect(store.objects.has("ha-carlink/pr/pr-12/00000000/index.html")).toBe(true);
  });
});

describe("argument validation", () => {
  it("normalises the repo name", () => {
    expect(normaliseRepo("St-John-Software/HA-Carlink")).toBe("ha-carlink");
    expect(normaliseRepo("3d-models")).toBe("3d-models");
    expect(() => normaliseRepo("bad name")).toThrow(PublishError);
    expect(() => normaliseRepo("owner/")).toThrow(PublishError);
    expect(() => normaliseRepo("..")).toThrow(PublishError);
  });

  it("turns branch slashes into dashes and rejects anything else unsafe", () => {
    expect(normaliseRef("claws/issue-12-abcd")).toBe("claws-issue-12-abcd");
    expect(normaliseRef("clw_01M3J52H0H9WSH3GTSY87ZY351")).toBe("clw_01M3J52H0H9WSH3GTSY87ZY351");
    expect(() => normaliseRef("")).toThrow(PublishError);
    expect(() => normaliseRef("a b")).toThrow(PublishError);
    expect(() => normaliseRef("..")).toThrow(PublishError);
  });

  it("accepts only the three kinds", () => {
    expect(parseKind("docs")).toBe("docs");
    expect(() => parseKind("site")).toThrow(/pr, issue, docs/);
  });

  it("takes the first 8 lowercase characters of a full SHA", () => {
    expect(sha8Of("ABCDEF1234567890abcdef1234567890abcdef12\n")).toBe("abcdef12");
    expect(() => sha8Of("abcdef12")).toThrow(PublishError);
  });

  it("lists files relative to the directory", () => {
    write("index.html");
    write("a/b/c.txt");
    expect(listFiles(dir)).toEqual(["a/b/c.txt", "index.html"]);
  });
});
