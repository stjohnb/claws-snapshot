import { describe, it, expect, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Regression for #clw_01M70191MPKP6VW93C1XE8NQG2: production loads config.js
// first, and the config.ts → github-app.ts → log.ts → db.ts → outcome.ts →
// claude.ts → capabilities.ts import cycle evaluates capabilities.ts while
// config.ts's bindings are still in their temporal dead zone. Nothing is
// mocked here, so this exercises that real order. HOME points at an empty dir
// so config.ts reads its defaults (no ~/.claws/config.json) on any machine.
const home = fs.mkdtempSync(path.join(os.tmpdir(), "claws-cap-import-order-"));
process.env["HOME"] = home;
process.env["CLAWS_PROD_CLUSTER_TAILNET_HOST"] = "prod-cluster-99.example.ts.net";

await import("./config.js");
const { allCapabilities, availableCapabilities } = await import("./capabilities.js");

afterAll(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

describe("capabilities loaded after config.js (real import order)", () => {
  it("registers both Mac runner SSH capabilities", () => {
    const ids = allCapabilities().map((c) => c.id);
    expect(ids).toContain("ssh:brendans-macbook-pro");
    expect(ids).toContain("ssh:brendans-macbook-pro-3");
    const available = availableCapabilities().map((c) => c.id);
    expect(available).toContain("ssh:brendans-macbook-pro");
    expect(available).toContain("ssh:brendans-macbook-pro-3");
  });

  it("names the configured prod-cluster tailnet host, not the default", () => {
    const cap = allCapabilities().find((c) => c.id === "ssh:prod-cluster")!;
    expect(cap.description).toContain("HostName prod-cluster-99.example.ts.net");
    expect(cap.description).not.toContain("prod-cluster-11");
  });
});
