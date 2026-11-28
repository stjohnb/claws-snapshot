import { describe, it, expect, vi, beforeEach } from "vitest";

const mockConfig = vi.hoisted(() => ({
  DATASETTE_BASE_URL: "http://datasette.example.test:8001/",
  DATASETTE_DATABASES: ["prod_namey", "garden", "authentik"] as string[],
}));
vi.mock("./config.js", async (importOriginal) => (await import("./test-helpers.js")).completeConfigMock(await importOriginal<typeof import("./config.js")>(), mockConfig));

import { checkDatasettePath, proxyDatasetteRead } from "./datasette-proxy.js";

const GRANTED: ReadonlySet<string> = new Set(["prod_namey", "garden", "not_configured"]);

describe("Datasette read proxy (#clw_01M89P9YVSQY0S29YP6KBPJAQQ)", () => {
  beforeEach(() => {
    mockConfig.DATASETTE_BASE_URL = "http://datasette.example.test:8001/";
    mockConfig.DATASETTE_DATABASES = ["prod_namey", "garden", "authentik"];
  });

  it("allows a granted, configured database's JSON database, table and row paths", () => {
    for (const p of ["/prod_namey.json", "/prod_namey/users.json", "/prod_namey/users/42.json", "/garden/plants~2Fbeds.json", "/prod_namey/users/a%20b.json"]) {
      expect(checkDatasettePath(p, GRANTED).ok, p).toBe(true);
    }
  });

  it("refuses another database, Datasette's own paths, non-JSON, deep paths, traversal and encoded slashes", () => {
    const refused: Array<[string, "path" | "database"]> = [
      ["/authentik.json", "database"], // configured but not granted
      ["/authentik/users.json", "database"],
      ["/not_configured.json", "database"], // granted but not configured
      ["/-/databases.json", "database"],
      ["/_memory.json", "database"],
      ["/_memory/x.json", "database"],
      ["/prod_namey", "path"],
      ["/prod_namey/users", "path"],
      ["/prod_namey/users.csv", "path"],
      ["/prod_namey/users/1/extra.json", "path"],
      ["/prod_namey/../authentik.json", "path"],
      ["/prod_namey/%2e%2e/authentik.json", "path"],
      ["//prod_namey.json", "path"],
      ["/prod_namey//users.json", "path"],
      ["/prod_namey%2fusers.json", "path"],
      ["/prod_namey/users%2F1.json", "path"],
      ["/prod_namey/users%5c1.json", "path"],
      ["/prod_namey\\users.json", "path"],
      ["/prod_namey/%zz.json", "path"],
      ["/.json", "path"],
      ["", "path"],
      ["/", "path"],
    ];
    for (const [p, reason] of refused) {
      const check = checkDatasettePath(p, GRANTED);
      expect(check.ok, p).toBe(false);
      if (!check.ok) expect(check.reason, p).toBe(reason);
    }
  });

  it("forwards an allowed GET with no headers and the query string, and passes back status, type and body", async () => {
    const fetchImpl = vi.fn(async () => new Response('{"rows":[]}', { status: 200, headers: { "content-type": "application/json" } }));
    const result = await proxyDatasetteRead("/prod_namey.json", "sql=select+count(*)+from+users&_shape=array", GRANTED, fetchImpl as unknown as typeof fetch);
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.status).toBe(200);
    expect(result.contentType).toBe("application/json");
    expect(new TextDecoder().decode(result.body)).toBe('{"rows":[]}');
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://datasette.example.test:8001/prod_namey.json?sql=select+count(*)+from+users&_shape=array");
    expect(init.method).toBe("GET");
    expect(init.headers).toBeUndefined();
    expect(init.redirect).toBe("manual");
    expect(init.body).toBeUndefined();
  });

  it("keeps a decoded ? or # inside its path segment", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 200 }));
    await proxyDatasetteRead("/prod_namey/users/a%3Fb%23c.json", "", GRANTED, fetchImpl as unknown as typeof fetch);
    expect((fetchImpl.mock.calls[0] as unknown as [string])[0]).toBe("http://datasette.example.test:8001/prod_namey/users/a%3Fb%23c.json");
  });

  it("refuses an ungranted database without calling fetch", async () => {
    const fetchImpl = vi.fn();
    expect(await proxyDatasetteRead("/authentik/users.json", "", GRANTED, fetchImpl as unknown as typeof fetch)).toEqual({ kind: "forbidden" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("reports unconfigured Datasette and upstream failures", async () => {
    const fetchImpl = vi.fn(async () => { throw new TypeError("fetch failed"); });
    expect(await proxyDatasetteRead("/garden.json", "", GRANTED, fetchImpl as unknown as typeof fetch)).toEqual({ kind: "upstream-error", error: "TypeError" });
    mockConfig.DATASETTE_BASE_URL = "";
    expect(await proxyDatasetteRead("/garden.json", "", GRANTED, fetchImpl as unknown as typeof fetch)).toEqual({ kind: "unconfigured" });
  });
});
