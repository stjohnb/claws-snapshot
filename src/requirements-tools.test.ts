import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerRequirementsTools } from "./requirements-tools.js";
import { parseRequirementsFile } from "./requirements-record.js";

const RECORD = {
  title: "Add a thing",
  kind: "feature",
  context: "People want it.",
  requirement: "The thing exists.",
  acceptanceCriteria: ["The thing is visible"],
  outOfScope: ["Other things"],
};

async function connect(outFile: string): Promise<Client> {
  const server = new McpServer({ name: "claws-state", version: "1.0.0" });
  registerRequirementsTools(server, { outFile });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "1.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

describe("registerRequirementsTools", () => {
  let dir: string;
  let outFile: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "claws-req-tools-"));
    outFile = path.join(dir, "requirements.json");
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("registers nothing without an out file", async () => {
    const client = await connect("");
    const tools = await client.listTools().then((r) => r.tools).catch(() => []);
    expect(tools).toEqual([]);
  });

  it("writes the record to the out file, the last call winning", async () => {
    const client = await connect(outFile);
    expect((await client.listTools()).tools.map((t) => t.name)).toEqual(["claws_save_requirements"]);

    await client.callTool({ name: "claws_save_requirements", arguments: { ...RECORD, title: "First" } });
    const res = await client.callTool({ name: "claws_save_requirements", arguments: RECORD });

    expect(res.isError).toBeFalsy();
    expect(parseRequirementsFile(fs.readFileSync(outFile, "utf8"))).toEqual(RECORD);
  });

  it("rejects a record with no acceptance criteria and writes nothing", async () => {
    const client = await connect(outFile);
    const res = await client.callTool({ name: "claws_save_requirements", arguments: { ...RECORD, acceptanceCriteria: [] } });
    expect(res.isError).toBe(true);
    expect(fs.existsSync(outFile)).toBe(false);
  });
});
