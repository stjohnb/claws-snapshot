import fs from "node:fs";
import https from "node:https";
import path from "node:path";

// In-cluster Kubernetes API client for Claws-managed workloads (#3026).
//
// Authenticates only with the projected ServiceAccount token, re-read on every
// request so kubelet's token rotation is picked up. It deliberately never reads
// `~/.kube/config`: in the container that is the cluster-admin kubeconfig the
// entrypoint writes from `CLAWS_KUBECONFIG` (same reasoning as
// `jobs/auth-secret-sync.ts`), and using it would silently bypass the
// namespaced RBAC this client is meant to run under.
//
// Pure apart from `node:*` — no `config.js`/`log.js` — so any process can use it.

export const SERVICE_ACCOUNT_DIR = "/var/run/secrets/kubernetes.io/serviceaccount";
export const IN_CLUSTER_API_SERVER = "https://kubernetes.default.svc";
export const K8S_REQUEST_TIMEOUT_MS = 15_000;
/** Responses larger than this are abandoned as `unreachable`, so a huge list cannot exhaust memory. */
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;

export interface K8sRequest {
  method: "GET" | "POST" | "PATCH" | "DELETE";
  /** Absolute API path including any query string, e.g. `/api/v1/namespaces/x/pods?labelSelector=…`. */
  path: string;
  headers: Record<string, string>;
  body?: string;
  timeoutMs: number;
}

export interface K8sResponse {
  status: number;
  body: string;
}

/**
 * Sends one request. Resolves with any HTTP response (including 4xx/5xx);
 * rejects only when no response arrived (network failure, TLS error, timeout).
 */
export type K8sTransport = (req: K8sRequest) => Promise<K8sResponse>;

export type K8sErrorKind = "not-found" | "conflict" | "forbidden" | "http-error" | "unreachable";

/**
 * A failed call. `message` names the method, path and status only — never a
 * request or response body, which may carry Secret data.
 */
export interface K8sError {
  ok: false;
  kind: K8sErrorKind;
  /** HTTP status when a response arrived. */
  status?: number;
  /**
   * Whether a write may have been applied anyway: `"no"` when the API refused
   * it (4xx) or never received it (no token, connect/DNS/TLS failure);
   * `"maybe"` when the answer was lost mid-exchange (timeout, reset) or was a 5xx.
   */
  applied: "no" | "maybe";
  message: string;
}

export type K8sResult<T> = { ok: true; value: T } | K8sError;

/** Namespaced core/v1 resources Claws workloads use. */
export type K8sResource = "pods" | "services" | "secrets" | "persistentvolumeclaims";

/** Minimal shape of any Kubernetes object this client returns. */
export interface K8sObject {
  apiVersion?: string;
  kind?: string;
  metadata?: {
    name?: string;
    namespace?: string;
    uid?: string;
    labels?: Record<string, string>;
    annotations?: Record<string, string>;
    creationTimestamp?: string;
    deletionTimestamp?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface AccessReviewRequest {
  namespace: string;
  verb: string;
  resource: string;
  /** API group; `""` (the default) is the core group. */
  group?: string;
  name?: string;
}

export interface AccessReviewResult {
  allowed: boolean;
  reason?: string;
}

export interface K8sClient {
  create<T extends K8sObject = K8sObject>(resource: K8sResource, namespace: string, obj: K8sObject): Promise<K8sResult<T>>;
  get<T extends K8sObject = K8sObject>(resource: K8sResource, namespace: string, name: string): Promise<K8sResult<T>>;
  list<T extends K8sObject = K8sObject>(resource: K8sResource, namespace: string, labelSelector?: string): Promise<K8sResult<T[]>>;
  delete(resource: K8sResource, namespace: string, name: string): Promise<K8sResult<void>>;
  /** JSON merge patch (`application/merge-patch+json`). */
  patch<T extends K8sObject = K8sObject>(resource: K8sResource, namespace: string, name: string, patch: unknown): Promise<K8sResult<T>>;
  selfSubjectAccessReview(req: AccessReviewRequest): Promise<K8sResult<AccessReviewResult>>;
}

export interface K8sClientOptions {
  /** Defaults to an `node:https` transport trusting the ServiceAccount CA. */
  transport?: K8sTransport;
  /** Directory holding `token` and `ca.crt`; defaults to the projected ServiceAccount mount. */
  saDir?: string;
  timeoutMs?: number;
}

/**
 * Default transport: `node:https` to `https://kubernetes.default.svc`, trusting
 * the ServiceAccount `ca.crt` (re-read per request). The timeout covers the
 * whole exchange, not just socket idleness.
 */
export function createHttpsTransport(saDir: string = SERVICE_ACCOUNT_DIR, server: string = IN_CLUSTER_API_SERVER): K8sTransport {
  return (req) => new Promise<K8sResponse>((resolve, reject) => {
    let ca: Buffer;
    try {
      ca = fs.readFileSync(path.join(saDir, "ca.crt"));
    } catch {
      reject(Object.assign(new Error("no ServiceAccount CA"), { code: "ENOCA" }));
      return;
    }
    const url = new URL(req.path, server);
    // Once a response has started, `destroy(err)` surfaces as a generic
    // ECONNRESET on `res` rather than `err`, so reject with the specific error
    // first; the later rejections from the error handlers are no-ops.
    const fail = (message: string, code: string) => {
      clearTimeout(timer);
      reject(Object.assign(new Error(message), { code }));
      request.destroy();
    };
    const request = https.request(url, { method: req.method, headers: req.headers, ca }, (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_RESPONSE_BYTES) {
          fail("response too large", "ETOOLARGE");
          return;
        }
        chunks.push(chunk);
      });
      res.on("end", () => {
        clearTimeout(timer);
        resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") });
      });
      res.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
    const timer = setTimeout(() => fail("timeout", "ETIMEDOUT"), req.timeoutMs);
    request.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    if (req.body !== undefined) request.write(req.body);
    request.end();
  });
}

function errorKindForStatus(status: number): K8sErrorKind {
  if (status === 404) return "not-found";
  if (status === 409) return "conflict";
  if (status === 403) return "forbidden";
  return "http-error";
}

/** Transport failures that happen before the request reaches the API server, so nothing can have been applied. */
const NOT_SENT_CODES = new Set(["ENOCA", "ECONNREFUSED", "ENOTFOUND", "EHOSTUNREACH", "ENETUNREACH", "EAI_AGAIN"]);

function appliedForTransportError(code: string | undefined): K8sError["applied"] {
  if (!code) return "maybe";
  return NOT_SENT_CODES.has(code) || /CERT|SIGNATURE|^ERR_TLS_|^ERR_SSL_/.test(code) ? "no" : "maybe";
}

function resourcePath(resource: K8sResource, namespace: string, name?: string): string {
  const base = `/api/v1/namespaces/${encodeURIComponent(namespace)}/${resource}`;
  return name === undefined ? base : `${base}/${encodeURIComponent(name)}`;
}

export function createK8sClient(opts: K8sClientOptions = {}): K8sClient {
  const saDir = opts.saDir ?? SERVICE_ACCOUNT_DIR;
  const transport = opts.transport ?? createHttpsTransport(saDir);
  const timeoutMs = opts.timeoutMs ?? K8S_REQUEST_TIMEOUT_MS;

  async function request<T>(
    method: K8sRequest["method"],
    apiPath: string,
    body: unknown,
    contentType: string,
    parse: boolean,
  ): Promise<K8sResult<T>> {
    // Log-safe label: the path without its query string.
    const label = `${method} ${apiPath.split("?")[0]}`;
    let token: string;
    try {
      token = fs.readFileSync(path.join(saDir, "token"), "utf8").trim();
    } catch {
      token = "";
    }
    if (!token) return { ok: false, kind: "unreachable", applied: "no", message: `${label}: no ServiceAccount token` };

    const headers: Record<string, string> = { Authorization: `Bearer ${token}`, Accept: "application/json" };
    let payload: string | undefined;
    if (body !== undefined) {
      payload = JSON.stringify(body);
      headers["Content-Type"] = contentType;
    }

    let res: K8sResponse;
    try {
      res = await transport({ method, path: apiPath, headers, body: payload, timeoutMs });
    } catch (err) {
      // Only the error code — a transport's message is not guaranteed body-free.
      const code = (err as NodeJS.ErrnoException | undefined)?.code;
      return { ok: false, kind: "unreachable", applied: appliedForTransportError(code), message: `${label}: ${code ?? "request failed"}` };
    }

    if (res.status < 200 || res.status >= 300) {
      const applied = res.status >= 400 && res.status < 500 ? "no" : "maybe";
      return { ok: false, kind: errorKindForStatus(res.status), status: res.status, applied, message: `${label}: HTTP ${res.status}` };
    }
    if (!parse) return { ok: true, value: undefined as T };
    try {
      return { ok: true, value: JSON.parse(res.body) as T };
    } catch {
      return { ok: false, kind: "http-error", status: res.status, applied: "maybe", message: `${label}: invalid JSON response` };
    }
  }

  return {
    create: (resource, namespace, obj) =>
      request("POST", resourcePath(resource, namespace), obj, "application/json", true),

    get: (resource, namespace, name) =>
      request("GET", resourcePath(resource, namespace, name), undefined, "", true),

    async list<T extends K8sObject>(resource: K8sResource, namespace: string, labelSelector?: string) {
      const query = labelSelector ? `?labelSelector=${encodeURIComponent(labelSelector)}` : "";
      const res = await request<{ items?: T[] }>("GET", `${resourcePath(resource, namespace)}${query}`, undefined, "", true);
      if (!res.ok) return res;
      return { ok: true as const, value: Array.isArray(res.value.items) ? res.value.items : [] };
    },

    delete: (resource, namespace, name) =>
      request<void>("DELETE", resourcePath(resource, namespace, name), undefined, "", false),

    patch: (resource, namespace, name, patch) =>
      request("PATCH", resourcePath(resource, namespace, name), patch, "application/merge-patch+json", true),

    async selfSubjectAccessReview(req) {
      const review = {
        apiVersion: "authorization.k8s.io/v1",
        kind: "SelfSubjectAccessReview",
        spec: {
          resourceAttributes: {
            namespace: req.namespace,
            verb: req.verb,
            group: req.group ?? "",
            resource: req.resource,
            ...(req.name ? { name: req.name } : {}),
          },
        },
      };
      const res = await request<{ status?: { allowed?: boolean; reason?: string } }>(
        "POST", "/apis/authorization.k8s.io/v1/selfsubjectaccessreviews", review, "application/json", true,
      );
      if (!res.ok) return res;
      const status = res.value.status ?? {};
      return { ok: true as const, value: { allowed: status.allowed === true, ...(status.reason ? { reason: status.reason } : {}) } };
    },
  };
}
