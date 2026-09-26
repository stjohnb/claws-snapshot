import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// The launch files (config.json) must be on disk before any
// service module loads, so importing the entry must not touch them.
vi.mock("../config.js", () => { throw new Error("agent-pod/main must not import config.js"); });
vi.mock("../log.js", () => { throw new Error("agent-pod/main must not import log.js"); });
vi.mock("../db.js", () => { throw new Error("agent-pod/main must not import db.js"); });

import { AgentLaunchSpecSchema, loadAgentLaunchSpec, resolveInHome, writeLaunchFiles } from "./main.js";

describe("agent-pod/main.js import", () => {
  it("imports while config.js, log.js and db.js throw on import", async () => {
    const mod = await import("./main.js");
    expect(typeof mod.main).toBe("function");
  });
});

describe("agent pod launch spec", () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "claws-agent-pod-"));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("parses a spec and defaults files to empty", () => {
    const file = path.join(root, "launch.json");
    fs.writeFileSync(file, JSON.stringify({ rowId: 42, runId: "run-1" }));
    expect(loadAgentLaunchSpec(file)).toEqual({ rowId: 42, runId: "run-1", files: [] });
  });

  it("rejects a spec with a missing or invalid row id", () => {
    expect(() => AgentLaunchSpecSchema.parse({ runId: "run-1" })).toThrow();
    expect(() => AgentLaunchSpecSchema.parse({ rowId: "42", runId: "run-1" })).toThrow();
    expect(() => AgentLaunchSpecSchema.parse({ rowId: 42, runId: "" })).toThrow();
  });

  it("writes files inside HOME at 0600, creating parent dirs and replacing existing files", () => {
    const home = path.join(root, "home");
    fs.mkdirSync(path.join(home, ".claws"), { recursive: true });
    fs.writeFileSync(path.join(home, ".claws/config.json"), "old", { mode: 0o644 });
    writeLaunchFiles(home, [
      { path: ".claws/config.json", content: "{\"repos\":[]}" },
      { path: ".claws/env", content: "K=v" },
      { path: "bin/tool", content: "#!/bin/sh\n", mode: 0o755 },
    ]);
    expect(fs.readFileSync(path.join(home, ".claws/config.json"), "utf8")).toBe("{\"repos\":[]}");
    expect(fs.statSync(path.join(home, ".claws/config.json")).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.join(home, ".claws/env")).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.join(home, "bin/tool")).mode & 0o777).toBe(0o755);
  });

  it("refuses a file path that escapes HOME", () => {
    const home = path.join(root, "home");
    fs.mkdirSync(home);
    expect(() => resolveInHome(home, "../outside")).toThrow(/escapes HOME/);
    expect(() => resolveInHome(home, "/etc/passwd")).toThrow(/escapes HOME/);
    expect(() => writeLaunchFiles(home, [{ path: "../outside", content: "x" }])).toThrow(/escapes HOME/);
    expect(fs.existsSync(path.join(root, "outside"))).toBe(false);
    expect(resolveInHome(home, ".claws/config.json")).toBe(path.join(home, ".claws/config.json"));
    // A trailing slash on HOME must not make every path "escape" it.
    expect(resolveInHome(home + "/", ".claws/config.json")).toBe(path.join(home, ".claws/config.json"));
    expect(() => resolveInHome(home + "/", "../outside")).toThrow(/escapes HOME/);
  });
});
