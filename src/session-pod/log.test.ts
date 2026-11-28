import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("../config.js", async (importOriginal) => (await import("../test-helpers.js")).completeConfigMock(await importOriginal<typeof import("../config.js")>(), await (() => { throw new Error("session-pod must not import config.js"); })()));
vi.mock("../log.js", () => { throw new Error("session-pod must not import log.js"); });
vi.mock("../db.js", () => { throw new Error("session-pod must not import db.js"); });

import * as log from "./log.js";
import * as core from "../log-core.js";

describe("session-pod log", () => {
  afterEach(() => {
    delete process.env["CLAWS_LOG_FORMAT"];
    vi.restoreAllMocks();
  });

  it("stamps service, component and session_id without relabelling the service's own lines", () => {
    process.env["CLAWS_LOG_FORMAT"] = "json";
    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    log.setSessionId("sess-1");
    log.info("Created tmux session claws-abc");
    expect(JSON.parse(String(out.mock.calls[0]?.[0]))).toMatchObject({
      service: "claws-session", component: "session-pod", session_id: "sess-1", msg: "Created tmux session claws-abc",
    });
    core.info("[scheduler] tick");
    const serviceLine = JSON.parse(String(out.mock.calls[1]?.[0]));
    expect(serviceLine).toMatchObject({ service: "claws", component: "scheduler" });
    expect(serviceLine).not.toHaveProperty("session_id");
  });

  it("passes extra fields through on info, warn and error", () => {
    process.env["CLAWS_LOG_FORMAT"] = "json";
    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    const warnOut = vi.spyOn(console, "warn").mockImplementation(() => {});
    const errOut = vi.spyOn(console, "error").mockImplementation(() => {});
    log.info("ended", { reason: "pane_dead", check: "poll" });
    log.warn("query failed", undefined, { tmux_code: 1 });
    log.error("boom", new Error("x"), { why: "query_failed" });
    expect(JSON.parse(String(out.mock.calls[0]?.[0]))).toMatchObject({ service: "claws-session", reason: "pane_dead", check: "poll" });
    expect(JSON.parse(String(warnOut.mock.calls[0]?.[0]))).toMatchObject({ level: "warn", tmux_code: 1 });
    expect(JSON.parse(String(errOut.mock.calls[0]?.[0]))).toMatchObject({ level: "error", why: "query_failed" });
  });
});
