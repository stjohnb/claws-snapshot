import crypto from "node:crypto";
import { Readable } from "node:stream";
import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  getActionRunByNumber: vi.fn(),
  listActionRunArtifacts: vi.fn(),
  openActionArtifactZip: vi.fn(),
  listRepos: vi.fn(),
}));

vi.mock("./config.js", async (importOriginal) => (await import("./test-helpers.js")).completeConfigMock(await importOriginal<typeof import("./config.js")>(), {}));
vi.mock("./github.js", () => ({ listRepos: mocks.listRepos }));
vi.mock("./forgejo.js", () => ({
  ForgejoActionNotFoundError: class extends Error {},
  ForgejoJobLogEndpointUnavailableError: class extends Error {},
  ForgejoArtifactEndpointUnavailableError: class ForgejoArtifactEndpointUnavailableError extends Error {},
  getActionRunByNumber: mocks.getActionRunByNumber,
  getActionRunJobs: vi.fn(),
  getActionJobStepLogs: vi.fn(),
  listActionRunArtifacts: mocks.listActionRunArtifacts,
  openActionArtifactZip: mocks.openActionArtifactZip,
  selectFailedJobs: () => [],
}));

import { FORGEJO_ARTIFACT_MAX_BYTES, ForgejoArtifactError, fetchForgejoRunArtifacts, openForgejoRunArtifact } from "./forgejo-run-artifacts.js";
import { ForgejoJobLogsError } from "./forgejo-job-logs.js";
import { ForgejoArtifactEndpointUnavailableError } from "./forgejo.js";

const artifact = (over: Record<string, unknown> = {}) => ({
  id: 590001, name: "build", sizeBytes: 21, expired: false, created: "2026-11-01T00:00:00Z", expires: "2027-02-01T00:00:00Z", ...over,
});

async function caught(p: Promise<unknown>): Promise<unknown> {
  return p.then(() => null, (e: unknown) => e);
}

async function drain(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of stream) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.listRepos.mockResolvedValue([{ fullName: "O/R" }]);
  mocks.getActionRunByNumber.mockResolvedValue({ id: 590000, number: 7 });
});

describe("fetchForgejoRunArtifacts", () => {
  it("lists a run's artifacts by its global id, under the managed repo's canonical name", async () => {
    mocks.listActionRunArtifacts.mockResolvedValue([artifact()]);
    const res = await fetchForgejoRunArtifacts({ repo: "o/r", run: 7 });
    expect(mocks.listActionRunArtifacts).toHaveBeenCalledWith("O/R", 590000);
    expect(res).toEqual({
      repo: "O/R", run: 7,
      artifacts: [{ id: 590001, name: "build", size_bytes: 21, expired: false, created: "2026-11-01T00:00:00Z", expires: "2027-02-01T00:00:00Z" }],
    });
  });

  it("404s a repo Claws does not manage without reading Forgejo", async () => {
    const err = await caught(fetchForgejoRunArtifacts({ repo: "x/y", run: 7 }));
    expect(err).toBeInstanceOf(ForgejoJobLogsError);
    expect((err as ForgejoJobLogsError).status).toBe(404);
    expect(mocks.getActionRunByNumber).not.toHaveBeenCalled();
  });

  it("404s an unknown run", async () => {
    mocks.getActionRunByNumber.mockResolvedValue(null);
    const err = await caught(fetchForgejoRunArtifacts({ repo: "o/r", run: 99 }));
    expect((err as ForgejoJobLogsError).status).toBe(404);
    expect((err as Error).message).toContain("no Actions run 99");
  });

  it("502s naming patch 0009 when the image lacks the artifacts API", async () => {
    mocks.listActionRunArtifacts.mockRejectedValue(new ForgejoArtifactEndpointUnavailableError("x"));
    const err = await caught(fetchForgejoRunArtifacts({ repo: "o/r", run: 7 }));
    expect((err as ForgejoJobLogsError).status).toBe(502);
    expect((err as Error).message).toBe("this Forgejo image lacks the artifacts API (forgejo patch 0009)");
  });
});

describe("openForgejoRunArtifact", () => {
  it("refuses an unknown name, listing the run's names", async () => {
    mocks.listActionRunArtifacts.mockResolvedValue([artifact(), artifact({ id: 2, name: "logs" })]);
    const err = await caught(openForgejoRunArtifact({ repo: "o/r", run: 7, name: "Build" }));
    expect(err).toBeInstanceOf(ForgejoArtifactError);
    expect((err as ForgejoArtifactError).status).toBe(404);
    expect((err as Error).message).toContain(`"build", "logs"`);
    expect((err as ForgejoArtifactError).unknown).toEqual({ repo: "O/R", run: 7, requested: "Build", names: ["build", "logs"] });
    expect(mocks.openActionArtifactZip).not.toHaveBeenCalled();
  });

  it("refuses an expired artifact", async () => {
    mocks.listActionRunArtifacts.mockResolvedValue([artifact({ expired: true })]);
    const err = await caught(openForgejoRunArtifact({ repo: "o/r", run: 7, name: "build" }));
    expect((err as ForgejoArtifactError).status).toBe(409);
    expect((err as Error).message).toContain("expired");
    expect(mocks.openActionArtifactZip).not.toHaveBeenCalled();
  });

  it("refuses an artifact whose listed size is over the cap, stating size and cap", async () => {
    mocks.listActionRunArtifacts.mockResolvedValue([artifact({ sizeBytes: 300 * 1024 * 1024 })]);
    const err = await caught(openForgejoRunArtifact({ repo: "o/r", run: 7, name: "build" }));
    expect((err as ForgejoArtifactError).status).toBe(413);
    expect((err as Error).message).toContain("300.0 MB");
    expect((err as Error).message).toContain(`${FORGEJO_ARTIFACT_MAX_BYTES} bytes`);
    expect(mocks.openActionArtifactZip).not.toHaveBeenCalled();
  });

  it("errors the stream once the zip passes the cap mid-stream", async () => {
    mocks.listActionRunArtifacts.mockResolvedValue([artifact({ sizeBytes: 10 })]);
    const chunk = Buffer.alloc(64 * 1024 * 1024);
    const source = Readable.from([chunk, chunk, chunk, chunk]);
    mocks.openActionArtifactZip.mockResolvedValue({ stream: source, declaredLength: null });
    const dl = await openForgejoRunArtifact({ repo: "o/r", run: 7, name: "build" });
    const err = await caught(drain(dl.stream));
    expect(err).toBeInstanceOf(ForgejoArtifactError);
    expect((err as ForgejoArtifactError).status).toBe(413);
    expect(dl.overCap).toBe(true);
    expect(dl.digest()).toBeNull();
    await vi.waitFor(() => expect(source.destroyed).toBe(true));
  });

  it("passes the zip through and reports its size and sha256 once it ends", async () => {
    mocks.listActionRunArtifacts.mockResolvedValue([artifact()]);
    const bytes = Buffer.from("PK\u0003\u0004 not really a zip");
    mocks.openActionArtifactZip.mockResolvedValue({ stream: Readable.from([bytes.subarray(0, 5), bytes.subarray(5)]), declaredLength: bytes.length });
    const dl = await openForgejoRunArtifact({ repo: "o/r", run: 7, name: "build" });
    expect(mocks.openActionArtifactZip).toHaveBeenCalledWith("O/R", 590001);
    expect(dl.digest()).toBeNull();
    expect(await drain(dl.stream)).toEqual(bytes);
    expect(dl.overCap).toBe(false);
    expect(dl.digest()).toEqual({ size: bytes.length, sha256: crypto.createHash("sha256").update(bytes).digest("hex") });
  });
});
