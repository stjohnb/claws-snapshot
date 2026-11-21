import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { receiveHome, sendHome } from "./move-home.js";

let dirs: string[] = [];
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "move-home-"));
  dirs.push(d);
  return d;
};

beforeEach(() => {
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  dirs = [];
});

async function startReceiver(home: string, token: string): Promise<{ url: string; done: Promise<number> }> {
  let port = 0;
  let done!: Promise<number>;
  const listening = new Promise<void>((resolve) => {
    done = receiveHome({ home, token, port: 0, host: "127.0.0.1", onListening: (p) => { port = p; resolve(); } });
  });
  await listening;
  return { url: `http://127.0.0.1:${port}`, done };
}

describe("move-home", () => {
  it("copies HOME, files, modes and nested dirs, and both sides exit 0", async () => {
    const from = tmp();
    const to = tmp();
    fs.mkdirSync(path.join(from, ".claude", "projects", "p"), { recursive: true });
    fs.writeFileSync(path.join(from, ".claude", "projects", "p", "MEMORY.md"), "remember\n");
    fs.writeFileSync(path.join(from, "script.sh"), "#!/bin/sh\n", { mode: 0o755 });
    const receiver = await startReceiver(to, "secret");
    const sent = await sendHome({ home: from, token: "secret", receiverUrl: receiver.url, receiverWaitMs: 5_000 });
    expect(sent).toBe(0);
    expect(await receiver.done).toBe(0);
    expect(fs.readFileSync(path.join(to, ".claude", "projects", "p", "MEMORY.md"), "utf8")).toBe("remember\n");
    expect(fs.statSync(path.join(to, "script.sh")).mode & 0o777).toBe(0o755);
  });

  it("copies into a destination root whose mode the receiver leaves alone, as on a fresh volume it does not own", async () => {
    const from = tmp();
    const to = tmp();
    fs.chmodSync(from, 0o700);
    fs.chmodSync(to, 0o755);
    fs.writeFileSync(path.join(from, ".bashrc"), "export X=1\n");
    fs.writeFileSync(path.join(from, "run.sh"), "#!/bin/sh\n", { mode: 0o755 });
    fs.writeFileSync(path.join(from, "-x y"), "dash\n");
    const receiver = await startReceiver(to, "secret");
    const sent = await sendHome({ home: from, token: "secret", receiverUrl: receiver.url, receiverWaitMs: 5_000 });
    expect(sent).toBe(0);
    expect(await receiver.done).toBe(0);
    // No `./` member: tar never tried to chmod the root (EPERM on a root-owned PVC, #clw_01M7T8P6X0GTRKJXFDPX27H174).
    expect(fs.statSync(to).mode & 0o777).toBe(0o755);
    expect(fs.readFileSync(path.join(to, ".bashrc"), "utf8")).toBe("export X=1\n");
    expect(fs.statSync(path.join(to, "run.sh")).mode & 0o777).toBe(0o755);
    expect(fs.readFileSync(path.join(to, "-x y"), "utf8")).toBe("dash\n");
  });

  it("commits a move of an empty HOME", async () => {
    const to = tmp();
    const receiver = await startReceiver(to, "secret");
    expect(await sendHome({ home: tmp(), token: "secret", receiverUrl: receiver.url, receiverWaitMs: 5_000 })).toBe(0);
    expect(await receiver.done).toBe(0);
    expect(fs.readdirSync(to)).toEqual([]);
  });

  it("refuses a commit whose hash does not match what was received", async () => {
    const from = tmp();
    fs.writeFileSync(path.join(from, "a.txt"), "a");
    const receiver = await startReceiver(tmp(), "secret");
    const sent = await sendHome({
      home: from, token: "secret", receiverUrl: receiver.url, receiverWaitMs: 5_000,
      tamperCommit: (c) => ({ ...c, sha256: "0".repeat(64) }),
    });
    expect(sent).toBe(1);
    expect(await receiver.done).toBe(1);
  });

  it("rejects an upload without the bearer token", async () => {
    const from = tmp();
    fs.writeFileSync(path.join(from, "a.txt"), "a");
    const receiver = await startReceiver(tmp(), "secret");
    expect(await sendHome({ home: from, token: "wrong", receiverUrl: receiver.url, receiverWaitMs: 5_000 })).toBe(1);
    // The receiver is still waiting for a real upload; a correct one still succeeds.
    expect(await sendHome({ home: from, token: "secret", receiverUrl: receiver.url, receiverWaitMs: 5_000 })).toBe(0);
    expect(await receiver.done).toBe(0);
  });

  it("gives up when no receiver ever answers", async () => {
    expect(await sendHome({ home: tmp(), token: "t", receiverUrl: "http://127.0.0.1:1", receiverWaitMs: 0 })).toBe(1);
  });
});
