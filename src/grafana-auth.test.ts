import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { grafanaAuthMode, grafanaAuthorization, grafanaServiceAccount } from "./grafana-auth.js";

const basic = (username: string, password: string) => `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;

describe("grafana-auth", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "claws-grafana-auth-"));
    process.env.CLAWS_AUTHENTIK_CREDENTIALS_DIR = dir;
  });
  afterEach(() => {
    delete process.env.CLAWS_AUTHENTIK_CREDENTIALS_DIR;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const write = (name: string, value: string) => fs.writeFileSync(path.join(dir, name), value);

  it("returns the username and Basic header when both files are present", () => {
    write("username", "claws-service");
    write("app-password", "pa:ss");
    expect(grafanaServiceAccount()).toEqual({ username: "claws-service", authorization: basic("claws-service", "pa:ss") });
    expect(grafanaAuthMode()).toBe("authentik");
    expect(grafanaAuthorization()).toBe(basic("claws-service", "pa:ss"));
  });

  it("trims a trailing newline and surrounding whitespace", () => {
    write("username", "claws-service\n");
    write("app-password", "  secret\r\n");
    expect(grafanaServiceAccount()).toEqual({ username: "claws-service", authorization: basic("claws-service", "secret") });
  });

  it.each([
    ["the password file is missing", () => write("username", "claws-service")],
    ["the username file is missing", () => write("app-password", "secret")],
    ["the password file is empty", () => { write("username", "claws-service"); write("app-password", "\n"); }],
    ["the username file is empty", () => { write("username", " "); write("app-password", "secret"); }],
  ])("is null and unconfigured, with no fallback header, when %s", (_label, setup) => {
    setup();
    expect(grafanaServiceAccount()).toBeNull();
    expect(grafanaAuthMode()).toBe("unconfigured");
    expect(grafanaAuthorization()).toBeNull();
  });

  it("is null when the variable is unset or blank, or names a missing directory", () => {
    write("username", "claws-service");
    write("app-password", "secret");
    delete process.env.CLAWS_AUTHENTIK_CREDENTIALS_DIR;
    expect(grafanaServiceAccount()).toBeNull();
    process.env.CLAWS_AUTHENTIK_CREDENTIALS_DIR = "  ";
    expect(grafanaServiceAccount()).toBeNull();
    process.env.CLAWS_AUTHENTIK_CREDENTIALS_DIR = path.join(dir, "absent");
    expect(grafanaServiceAccount()).toBeNull();
  });

  it("re-reads the files on every call, so a rotation takes effect without a restart", () => {
    write("username", "claws-service");
    write("app-password", "old");
    expect(grafanaAuthorization()).toBe(basic("claws-service", "old"));
    write("app-password", "new");
    expect(grafanaAuthorization()).toBe(basic("claws-service", "new"));
    fs.rmSync(path.join(dir, "app-password"));
    expect(grafanaAuthorization()).toBeNull();
  });
});
