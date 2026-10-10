import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { createHttpsTransport, createK8sClient, type K8sRequest, type K8sResponse, type K8sTransport } from "./api.js";

const SECRET_BODY = "c3VwZXItc2VjcmV0LXZhbHVl";

describe("createK8sClient", () => {
  let saDir: string;
  let requests: K8sRequest[];

  function fakeTransport(respond: (req: K8sRequest) => K8sResponse | Promise<K8sResponse>): K8sTransport {
    return async (req) => {
      requests.push(req);
      return respond(req);
    };
  }

  beforeEach(() => {
    saDir = fs.mkdtempSync(path.join(os.tmpdir(), "k8s-api-test-"));
    fs.writeFileSync(path.join(saDir, "token"), "token-1\n");
    requests = [];
  });

  afterEach(() => {
    fs.rmSync(saDir, { recursive: true, force: true });
  });

  it("sends the ServiceAccount token and re-reads it on every request", async () => {
    const client = createK8sClient({ saDir, transport: fakeTransport(() => ({ status: 200, body: "{}" })) });
    await client.get("pods", "claws-sessions", "claws-session-abc");
    fs.writeFileSync(path.join(saDir, "token"), "token-2");
    await client.get("pods", "claws-sessions", "claws-session-abc");
    expect(requests.map((r) => r.headers.Authorization)).toEqual(["Bearer token-1", "Bearer token-2"]);
    expect(requests[0].path).toBe("/api/v1/namespaces/claws-sessions/pods/claws-session-abc");
    expect(requests[0].timeoutMs).toBe(15_000);
  });

  it("returns unreachable without calling the transport when there is no token", async () => {
    fs.rmSync(path.join(saDir, "token"));
    const client = createK8sClient({ saDir, transport: fakeTransport(() => ({ status: 200, body: "{}" })) });
    const res = await client.get("pods", "ns", "p");
    expect(res).toMatchObject({ ok: false, kind: "unreachable", applied: "no" });
    expect(requests).toHaveLength(0);
  });

  it.each([
    [404, "not-found", "no"],
    [409, "conflict", "no"],
    [403, "forbidden", "no"],
    [401, "http-error", "no"],
    [422, "http-error", "no"],
    [500, "http-error", "maybe"],
    [503, "http-error", "maybe"],
  ])("classifies HTTP %i as %s (applied: %s)", async (status, kind, applied) => {
    const client = createK8sClient({ saDir, transport: fakeTransport(() => ({ status, body: "{}" })) });
    const res = await client.delete("secrets", "ns", "s");
    expect(res).toEqual({ ok: false, kind, status, applied, message: `DELETE /api/v1/namespaces/ns/secrets/s: HTTP ${status}` });
  });

  it.each([
    ["ECONNREFUSED", "no"],
    ["ENOTFOUND", "no"],
    ["EAI_AGAIN", "no"],
    ["UNABLE_TO_VERIFY_LEAF_SIGNATURE", "no"],
    ["ERR_TLS_CERT_ALTNAME_INVALID", "no"],
    ["ETIMEDOUT", "maybe"],
    ["ECONNRESET", "maybe"],
    ["EPIPE", "maybe"],
    [undefined, "maybe"],
  ])("marks a %s transport failure as applied: %s", async (code, applied) => {
    const client = createK8sClient({
      saDir,
      transport: async () => { throw Object.assign(new Error("failed"), code ? { code } : {}); },
    });
    expect(await client.create("secrets", "ns", { metadata: { name: "s" } })).toMatchObject({ ok: false, kind: "unreachable", applied });
  });

  it("classifies a transport failure as unreachable", async () => {
    const client = createK8sClient({
      saDir,
      transport: async () => { throw Object.assign(new Error(`socket hang up ${SECRET_BODY}`), { code: "ECONNRESET" }); },
    });
    const res = await client.list("pods", "ns", "claws-workload=session");
    expect(res).toMatchObject({ ok: false, kind: "unreachable" });
    if (!res.ok) {
      expect(res.message).toContain("ECONNRESET");
      expect(res.message).not.toContain(SECRET_BODY);
    }
  });

  it("never puts request or response bodies in error messages", async () => {
    const client = createK8sClient({
      saDir,
      transport: fakeTransport(() => ({ status: 422, body: JSON.stringify({ message: `invalid: ${SECRET_BODY}` }) })),
    });
    const res = await client.create("secrets", "ns", { metadata: { name: "s" }, data: { token: SECRET_BODY } });
    expect(res.ok).toBe(false);
    expect(JSON.stringify(res)).not.toContain(SECRET_BODY);
  });

  it("reports a non-JSON success body as http-error without echoing it", async () => {
    const client = createK8sClient({ saDir, transport: fakeTransport(() => ({ status: 200, body: `<html>${SECRET_BODY}` })) });
    const res = await client.get("pods", "ns", "p");
    expect(res).toMatchObject({ ok: false, kind: "http-error", status: 200 });
    expect(JSON.stringify(res)).not.toContain(SECRET_BODY);
  });

  it("lists with an encoded label selector and returns the items", async () => {
    const client = createK8sClient({
      saDir,
      transport: fakeTransport(() => ({ status: 200, body: JSON.stringify({ items: [{ metadata: { name: "a" } }] }) })),
    });
    const res = await client.list("pods", "ns", "app.kubernetes.io/managed-by=claws,claws-workload=session");
    expect(res).toEqual({ ok: true, value: [{ metadata: { name: "a" } }] });
    expect(requests[0].path).toBe(
      "/api/v1/namespaces/ns/pods?labelSelector=app.kubernetes.io%2Fmanaged-by%3Dclaws%2Cclaws-workload%3Dsession",
    );
  });

  it("creates with a JSON body and merge-patches with the merge-patch content type", async () => {
    const client = createK8sClient({ saDir, transport: fakeTransport((req) => ({ status: 201, body: req.body ?? "{}" })) });
    const created = await client.create("services", "ns", { metadata: { name: "svc" } });
    expect(created).toEqual({ ok: true, value: { metadata: { name: "svc" } } });
    expect(requests[0]).toMatchObject({ method: "POST", path: "/api/v1/namespaces/ns/services" });
    expect(requests[0].headers["Content-Type"]).toBe("application/json");

    await client.patch("secrets", "ns", "s", { data: { "github-token": "eA==" } });
    expect(requests[1]).toMatchObject({ method: "PATCH", path: "/api/v1/namespaces/ns/secrets/s" });
    expect(requests[1].headers["Content-Type"]).toBe("application/merge-patch+json");
    expect(JSON.parse(requests[1].body!)).toEqual({ data: { "github-token": "eA==" } });
  });

  it("encodes names so they cannot escape the resource path", async () => {
    const client = createK8sClient({ saDir, transport: fakeTransport(() => ({ status: 200, body: "{}" })) });
    await client.get("pods", "ns", "../../secrets/x");
    expect(requests[0].path).toBe("/api/v1/namespaces/ns/pods/..%2F..%2Fsecrets%2Fx");
  });

  it("runs a SelfSubjectAccessReview", async () => {
    const client = createK8sClient({
      saDir,
      transport: fakeTransport(() => ({ status: 201, body: JSON.stringify({ status: { allowed: false, reason: "no RBAC" } }) })),
    });
    const res = await client.selfSubjectAccessReview({ namespace: "claws-sessions", verb: "patch", resource: "secrets" });
    expect(res).toEqual({ ok: true, value: { allowed: false, reason: "no RBAC" } });
    expect(requests[0].path).toBe("/apis/authorization.k8s.io/v1/selfsubjectaccessreviews");
    expect(JSON.parse(requests[0].body!).spec.resourceAttributes).toEqual({
      namespace: "claws-sessions", verb: "patch", group: "", resource: "secrets",
    });
  });
});

describe("createHttpsTransport", () => {
  let saDir: string;
  let server: http.Server;

  // Serve plain HTTP and route the transport's `https.request` to it, so the
  // real `node:http` client behaviour (errors once a response has started) is exercised.
  async function transportFor(handler: http.RequestListener): Promise<K8sTransport> {
    server = http.createServer(handler);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    vi.spyOn(https, "request").mockImplementation(((url: URL, opts: http.RequestOptions, cb: (res: http.IncomingMessage) => void) => {
      const plain = new URL(url);
      plain.protocol = "http:";
      return http.request(plain, opts, cb);
    }) as unknown as typeof https.request);
    return createHttpsTransport(saDir, `https://127.0.0.1:${port}`);
  }

  function get(timeoutMs = 5_000): K8sRequest {
    return { method: "GET", path: "/api/v1/namespaces/ns/pods", headers: {}, timeoutMs };
  }

  beforeEach(() => {
    saDir = fs.mkdtempSync(path.join(os.tmpdir(), "k8s-transport-test-"));
    fs.writeFileSync(path.join(saDir, "ca.crt"), "unused");
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(saDir, { recursive: true, force: true });
  });

  it("resolves with the response", async () => {
    const transport = await transportFor((_req, res) => { res.writeHead(404); res.end("nope"); });
    await expect(transport(get())).resolves.toEqual({ status: 404, body: "nope" });
  });

  it("rejects with ETOOLARGE, not ECONNRESET, when the body exceeds the limit", async () => {
    const transport = await transportFor((_req, res) => {
      res.writeHead(200);
      const chunk = Buffer.alloc(1024 * 1024, 120);
      const pump = () => {
        while (!res.destroyed) {
          if (!res.write(chunk)) {
            res.once("drain", pump);
            return;
          }
        }
      };
      res.on("error", () => {});
      pump();
    });
    await expect(transport(get())).rejects.toMatchObject({ code: "ETOOLARGE" });
  });

  it("rejects with ETIMEDOUT, not ECONNRESET, when the body stalls mid-response", async () => {
    const transport = await transportFor((_req, res) => {
      res.writeHead(200);
      res.write("{\"items\":[");
    });
    await expect(transport(get(100))).rejects.toMatchObject({ code: "ETIMEDOUT" });
  });
});
