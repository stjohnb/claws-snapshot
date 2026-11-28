import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import { Transform, pipeline } from "node:stream";
import { pathToFileURL } from "node:url";

// Entry point of the two pods that move a session's HOME volume to another
// node (#clw_01M7Q3P5PR480HYED9TNH6VTV9), built by `buildSessionMoveReceiverPod`
// and `buildSessionMoveSenderPod`. `receive` runs on the new node with the new
// PVC mounted at HOME, `send` on the old node with the old PVC read-only.
// The sender streams a tar of HOME's entries (not of `.`) to the receiver's
// `PUT /home`, which untars it; leaving HOME itself out of the archive means
// the receiver never tries to chmod the new volume's root, which it does not
// own (#clw_01M7T8P6X0GTRKJXFDPX27H174); then `POST /commit {sha256, bytes}` succeeds only when both sides
// saw the same stream and tar extracted it cleanly. Each pod exits 0 only on a
// committed copy, which is what Claws waits for. Runs with no Claws config,
// database or logger: one JSON line on stdout reports the outcome.

const PORT = 7681;
/** How long the sender keeps probing for a receiver that is not yet listening. */
const RECEIVER_WAIT_MS = 120_000;
const PROBE_INTERVAL_MS = 2_000;

interface StreamCount {
  sha256: string;
  bytes: number;
}

/** A pass-through that hashes and counts what flows through it. */
function counter(): Transform & { result(): StreamCount } {
  const hash = crypto.createHash("sha256");
  let bytes = 0;
  const t = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      hash.update(chunk);
      bytes += chunk.length;
      cb(null, chunk);
    },
  }) as Transform & { result(): StreamCount };
  let digest: string | null = null;
  t.result = () => ({ sha256: (digest ??= hash.digest("hex")), bytes });
  return t;
}

function bearerOk(header: string | undefined, token: string): boolean {
  const got = Buffer.from(header?.startsWith("Bearer ") ? header.slice(7) : "", "utf8");
  const want = Buffer.from(token, "utf8");
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

export interface ReceiveOptions {
  home: string;
  token: string;
  port?: number;
  host?: string;
  /** Called once listening, with the bound port (tests use port 0). */
  onListening?: (port: number) => void;
  tarBin?: string;
}

/**
 * Serve one copy into `home`. Resolves the process exit code: 0 once a commit
 * matched what was received and extracted, 1 when it did not (the receiver
 * then stops, and Claws discards the new volume).
 */
export function receiveHome(opts: ReceiveOptions): Promise<number> {
  return new Promise((resolve) => {
    let received: (StreamCount & { tarOk: boolean; detail: string }) | null = null;
    let uploading = false;
    let finished = false;
    const finish = (code: number, line: Record<string, unknown>) => {
      if (finished) return;
      finished = true;
      process.stdout.write(`${JSON.stringify(line)}\n`);
      server.close();
      server.closeAllConnections?.();
      resolve(code);
    };
    const server = http.createServer((req, res) => {
      const url = req.url ?? "";
      if (req.method === "GET" && url === "/healthz") {
        res.writeHead(200).end("ok");
        return;
      }
      if (!bearerOk(req.headers.authorization, opts.token)) {
        res.writeHead(401).end();
        return;
      }
      if (req.method === "PUT" && url === "/home") {
        if (uploading || received) {
          res.writeHead(409).end("already received");
          return;
        }
        uploading = true;
        const count = counter();
        const tar = spawn(opts.tarBin ?? "tar", ["-C", opts.home, "--no-overwrite-dir", "-xpf", "-"], { stdio: ["pipe", "ignore", "pipe"] });
        let stderr = "";
        tar.stderr.on("data", (c: Buffer) => { stderr = (stderr + c.toString("utf8")).slice(-2000); });
        pipeline(req, count, tar.stdin, () => { /* tar's exit decides */ });
        tar.on("close", (code) => {
          const result = count.result();
          received = { ...result, tarOk: code === 0, detail: code === 0 ? "" : `tar exited ${code}: ${stderr.trim()}` };
          res.writeHead(code === 0 ? 200 : 500, { "Content-Type": "application/json" }).end(JSON.stringify({ ...result, ok: code === 0, detail: received.detail }));
        });
        tar.on("error", (err) => {
          received = { ...count.result(), tarOk: false, detail: `tar failed: ${err.message}` };
          if (!res.headersSent) res.writeHead(500).end(received.detail);
        });
        return;
      }
      if (req.method === "POST" && url === "/commit") {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => { if (chunks.length < 64) chunks.push(c); });
        req.on("end", () => {
          let claimed: Partial<StreamCount> = {};
          try {
            claimed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Partial<StreamCount>;
          } catch { /* mismatch below */ }
          const ok = !!received && received.tarOk && claimed.sha256 === received.sha256 && claimed.bytes === received.bytes;
          res.writeHead(ok ? 200 : 409, { "Content-Type": "application/json" }).end(JSON.stringify({ ok }), () => {
            finish(ok ? 0 : 1, ok
              ? { ok: true, bytes: received!.bytes, sha256: received!.sha256 }
              : { ok: false, detail: received ? (received.tarOk ? "stream hash or size mismatch" : received.detail) : "commit before any upload" });
          });
        });
        return;
      }
      res.writeHead(404).end();
    });
    server.listen(opts.port ?? PORT, opts.host ?? "0.0.0.0", () => {
      const addr = server.address();
      opts.onListening?.(typeof addr === "object" && addr ? addr.port : opts.port ?? PORT);
    });
  });
}

export interface SendOptions {
  home: string;
  token: string;
  /** The receiver's base URL, e.g. `http://10.42.0.7:7681`. */
  receiverUrl: string;
  receiverWaitMs?: number;
  tarBin?: string;
  /** Overrides the sha256/bytes the commit claims (tests of a mismatch). */
  tamperCommit?: (count: StreamCount) => StreamCount;
}

function request(url: URL, method: string, token: string, body: Buffer | NodeJS.ReadableStream | null): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string | number> = { Authorization: `Bearer ${token}` };
    if (Buffer.isBuffer(body)) {
      headers["Content-Type"] = "application/json";
      headers["Content-Length"] = body.length;
    }
    const req = http.request(url, { method, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => { if (chunks.length < 64) chunks.push(c); });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
      res.on("error", reject);
    });
    req.on("error", reject);
    if (Buffer.isBuffer(body)) req.end(body);
    else if (body) pipeline(body, req, (err) => { if (err) req.destroy(err); });
    else req.end();
  });
}

async function waitForReceiver(base: string, waitMs: number): Promise<boolean> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      const res = await request(new URL("/healthz", base), "GET", "", null);
      if (res.status === 200) return true;
    } catch { /* not listening yet */ }
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, PROBE_INTERVAL_MS));
  }
}

/** Stream `home` to the receiver and commit it. Resolves the exit code: 0 only on a 200 commit. */
export async function sendHome(opts: SendOptions): Promise<number> {
  const report = (code: number, line: Record<string, unknown>) => {
    process.stdout.write(`${JSON.stringify(line)}\n`);
    return code;
  };
  if (!await waitForReceiver(opts.receiverUrl, opts.receiverWaitMs ?? RECEIVER_WAIT_MS)) {
    return report(1, { ok: false, detail: "receiver never answered" });
  }
  let entries: Buffer[];
  try {
    entries = fs.readdirSync(opts.home, { encoding: "buffer" });
  } catch (err) {
    return report(1, { ok: false, detail: `cannot read HOME: ${err instanceof Error ? err.message : String(err)}` });
  }
  // HOME's entries, not `.`: an archive without a `./` member never makes the receiver restore the root's mode.
  const tar = spawn(opts.tarBin ?? "tar", ["-C", opts.home, "--null", "-T", "-", "-cf", "-"], { stdio: ["pipe", "pipe", "pipe"] });
  tar.stdin.on("error", () => { /* tar's exit decides */ });
  tar.stdin.end(Buffer.concat(entries.flatMap((e) => [Buffer.from("./"), e, Buffer.from([0])])));
  let stderr = "";
  tar.stderr.on("data", (c: Buffer) => { stderr = (stderr + c.toString("utf8")).slice(-2000); });
  const tarExit = new Promise<number | null>((resolve) => {
    tar.on("close", (code) => resolve(code));
    tar.on("error", () => resolve(null));
  });
  const count = counter();
  tar.stdout.pipe(count);
  let put: { status: number; body: string };
  try {
    put = await request(new URL("/home", opts.receiverUrl), "PUT", opts.token, count);
  } catch (err) {
    tar.kill();
    return report(1, { ok: false, detail: `upload failed: ${err instanceof Error ? err.message : String(err)}` });
  }
  const code = await tarExit;
  if (code !== 0) return report(1, { ok: false, detail: `tar exited ${code}: ${stderr.trim()}` });
  if (put.status !== 200) return report(1, { ok: false, detail: `receiver answered HTTP ${put.status}: ${put.body.slice(0, 500)}` });
  const sent = count.result();
  const claim = opts.tamperCommit ? opts.tamperCommit(sent) : sent;
  let commit: { status: number; body: string };
  try {
    commit = await request(new URL("/commit", opts.receiverUrl), "POST", opts.token, Buffer.from(JSON.stringify(claim), "utf8"));
  } catch (err) {
    return report(1, { ok: false, detail: `commit failed: ${err instanceof Error ? err.message : String(err)}` });
  }
  if (commit.status !== 200) return report(1, { ok: false, detail: `commit refused: HTTP ${commit.status}` });
  return report(0, { ok: true, bytes: sent.bytes, sha256: sent.sha256 });
}

function isEntryPoint(): boolean {
  const script = process.argv[1];
  if (!script) return false;
  try {
    return import.meta.url === pathToFileURL(fs.realpathSync(script)).href;
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  const home = process.env.HOME || os.homedir();
  const token = process.env.CLAWS_MOVE_TOKEN ?? "";
  const mode = process.argv[2];
  const run = !token
    ? Promise.resolve(1).then((c) => { process.stderr.write("move-home: CLAWS_MOVE_TOKEN is not set\n"); return c; })
    : mode === "receive"
      ? receiveHome({ home, token })
      : mode === "send"
        ? sendHome({ home, token, receiverUrl: process.env.CLAWS_MOVE_RECEIVER_URL ?? "" })
        : Promise.resolve(2).then((c) => { process.stderr.write("usage: move-home.js receive|send\n"); return c; });
  run.then((code) => { process.exitCode = code; }, (err: unknown) => {
    process.stderr.write(`move-home failed: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  });
}
