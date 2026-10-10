import { describe, it, expect, vi, afterEach } from "vitest";
import {
  PagesS3Client,
  canonicalQuery,
  contentTypeFor,
  encodeKeyPath,
  pagesKeyFromUrl,
  parseListObjectsV2,
  signRequest,
} from "./pages-s3.js";

// The S3 SigV4 header-auth examples from AWS's "Signature Calculations for
// the Authorization Header" documentation.
const AWS_EXAMPLE = {
  host: "examplebucket.s3.amazonaws.com",
  region: "us-east-1",
  accessKeyId: "AKIAIOSFODNN7EXAMPLE",
  secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
  date: new Date("2013-05-24T00:00:00Z"),
  payloadHash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
};

describe("signRequest", () => {
  it("matches the AWS GET Object example", () => {
    const headers = signRequest({ ...AWS_EXAMPLE, method: "GET", path: "/test.txt", headers: { range: "bytes=0-9" } });
    expect(headers["x-amz-date"]).toBe("20130524T000000Z");
    expect(headers["Authorization"]).toBe(
      "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, " +
        "SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, " +
        "Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41",
    );
  });

  it("matches the AWS GET Bucket (list) example, canonicalising the query", () => {
    const headers = signRequest({ ...AWS_EXAMPLE, method: "GET", path: "/", query: { prefix: "J", "max-keys": "2" } });
    expect(headers["Authorization"]).toContain("SignedHeaders=host;x-amz-content-sha256;x-amz-date");
    expect(headers["Authorization"]).toContain(
      "Signature=34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7",
    );
  });
});

describe("key encoding", () => {
  it("encodes each path segment and keeps slashes", () => {
    expect(encodeKeyPath("repo/docs/my branch/abcd1234/a+b(1)*.html")).toBe(
      "repo/docs/my%20branch/abcd1234/a%2Bb%281%29%2A.html",
    );
    expect(encodeKeyPath("repo/issue/clw_01AB~x/index.html")).toBe("repo/issue/clw_01AB~x/index.html");
  });

  it("sorts and encodes query parameters", () => {
    expect(canonicalQuery({ prefix: "a/b c/", "list-type": "2" })).toBe("list-type=2&prefix=a%2Fb%20c%2F");
    expect(canonicalQuery()).toBe("");
  });
});

describe("parseListObjectsV2", () => {
  it("reads keys, truncation and the continuation token", () => {
    const xml = `<?xml version="1.0"?><ListBucketResult><IsTruncated>true</IsTruncated>
      <Contents><Key>r/pr/pr-1/aaaaaaaa/index.html</Key></Contents>
      <Contents><Key>r/pr/pr-1/aaaaaaaa/a&amp;b.html</Key></Contents>
      <NextContinuationToken>tok&lt;1&gt;</NextContinuationToken></ListBucketResult>`;
    expect(parseListObjectsV2(xml)).toEqual({
      keys: ["r/pr/pr-1/aaaaaaaa/index.html", "r/pr/pr-1/aaaaaaaa/a&b.html"],
      isTruncated: true,
      nextToken: "tok<1>",
    });
    expect(parseListObjectsV2("<ListBucketResult><IsTruncated>false</IsTruncated></ListBucketResult>")).toEqual({
      keys: [],
      isTruncated: false,
      nextToken: null,
    });
  });
});

describe("PagesS3Client", () => {
  afterEach(() => vi.unstubAllGlobals());

  const client = () =>
    new PagesS3Client({
      endpoint: "http://garage.default.svc.cluster.local:3900",
      region: "garage",
      bucket: "pages",
      accessKeyId: "GK1",
      secretAccessKey: "s3cret",
    });

  it("addresses objects path-style and signs every request", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response("", { status: 200 });
    });
    await client().putObject("r/docs/main/abcd1234/index.html", Buffer.from("<p>hi</p>"), "text/html");
    expect(calls[0]!.url).toBe("http://garage.default.svc.cluster.local:3900/pages/r/docs/main/abcd1234/index.html");
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(calls[0]!.init.method).toBe("PUT");
    expect(headers["content-type"]).toBe("text/html");
    expect(headers["Authorization"]).toMatch(/^AWS4-HMAC-SHA256 Credential=GK1\/\d{8}\/garage\/s3\/aws4_request, SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/);
    expect(JSON.stringify(calls)).not.toContain("s3cret");
  });

  it("pages ListObjectsV2 by continuation token", async () => {
    const urls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      urls.push(url);
      const body = url.includes("continuation-token")
        ? "<ListBucketResult><IsTruncated>false</IsTruncated><Contents><Key>r/pr/pr-1/b/index.html</Key></Contents></ListBucketResult>"
        : "<ListBucketResult><IsTruncated>true</IsTruncated><Contents><Key>r/pr/pr-1/a/index.html</Key></Contents><NextContinuationToken>t2</NextContinuationToken></ListBucketResult>";
      return new Response(body, { status: 200 });
    });
    expect(await client().listKeys("r/pr/pr-1/")).toEqual(["r/pr/pr-1/a/index.html", "r/pr/pr-1/b/index.html"]);
    expect(urls[0]).toBe("http://garage.default.svc.cluster.local:3900/pages?list-type=2&prefix=r%2Fpr%2Fpr-1%2F");
    expect(urls[1]).toBe(
      "http://garage.default.svc.cluster.local:3900/pages?continuation-token=t2&list-type=2&prefix=r%2Fpr%2Fpr-1%2F",
    );
  });

  it("returns a 404 from getObject rather than throwing, and throws on a failed PUT", async () => {
    vi.stubGlobal("fetch", async () => new Response("NoSuchKey", { status: 404 }));
    expect((await client().getObject("missing")).status).toBe(404);
    await client().deleteObject("missing");
    vi.stubGlobal("fetch", async () => new Response("denied", { status: 403 }));
    await expect(client().putObject("k", Buffer.from(""), "text/plain")).rejects.toThrow(/HTTP 403/);
  });
});

describe("contentTypeFor", () => {
  it("maps known extensions and falls back to octet-stream", () => {
    expect(contentTypeFor("a/index.HTML")).toBe("text/html; charset=utf-8");
    expect(contentTypeFor("preview-summary.json")).toBe("application/json");
    expect(contentTypeFor("model.stl")).toBe("model/stl");
    expect(contentTypeFor("font.woff2")).toBe("font/woff2");
    expect(contentTypeFor("dir.d/README")).toBe("application/octet-stream");
    expect(contentTypeFor("blob.bin")).toBe("application/octet-stream");
  });
});

describe("pagesKeyFromUrl", () => {
  it("returns the key under the base URL and null otherwise", () => {
    const base = "https://pages.home.bstjohn.net/";
    expect(pagesKeyFromUrl(base, "https://pages.home.bstjohn.net/repo/issue/17/abcd1234/preview-summary.json")).toBe(
      "repo/issue/17/abcd1234/preview-summary.json",
    );
    expect(pagesKeyFromUrl(base, "https://www.bstjohn.net/3d-models/x.json")).toBeNull();
    expect(pagesKeyFromUrl(base, "https://pages.home.bstjohn.net/")).toBeNull();
    expect(pagesKeyFromUrl(base, "not a url")).toBeNull();
  });
});
