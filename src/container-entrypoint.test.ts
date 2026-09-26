import { afterEach, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

it.each([true, false])("create-only shell seeding preserves user symlinks (dangling: %s) and edits", (dangling) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claws-entrypoint-"));
  roots.push(root);
  const skel = path.join(root, "skel");
  const home = path.join(root, "home");
  const target = path.join(root, "user-config");
  fs.mkdirSync(path.join(skel, ".config"), { recursive: true });
  fs.mkdirSync(home);
  if (!dangling) fs.mkdirSync(target);
  fs.symlinkSync(target, path.join(home, ".config"));
  fs.writeFileSync(path.join(skel, ".config/default"), "default");
  fs.writeFileSync(path.join(skel, ".zshrc"), "default", { mode: 0o644 });
  const script = fs.readFileSync(new URL("../deploy/container-entrypoint.sh", import.meta.url), "utf8");
  const helper = script.slice(script.indexOf("seed_skel_dir()"), script.indexOf("# A PVC"));
  const seed = () => execFileSync("bash", ["-euc", helper + '\nseed_skel_dir "$1" "$2"', "seed", skel, home]);
  seed();
  expect(fs.readlinkSync(path.join(home, ".config"))).toBe(target);
  expect(fs.existsSync(path.join(target, "default"))).toBe(false);
  expect(fs.existsSync(target)).toBe(!dangling);
  fs.writeFileSync(path.join(home, ".zshrc"), "edited");
  seed();
  expect(fs.readFileSync(path.join(home, ".zshrc"), "utf8")).toBe("edited");
});

it.each([
  [{ CLAWS_AGENT_POD_ROW: "42" }, "/opt/claws/dist/agent-pod/main.js"],
  [{ CLAWS_AGENT_POD_ROW: "" }, "/opt/claws/dist/main.js --flag"],
  [{}, "/opt/claws/dist/main.js --flag"],
])("execs the agent pod runtime only when CLAWS_AGENT_POD_ROW is set (%o)", (env, expected) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claws-entrypoint-"));
  roots.push(root);
  const bin = path.join(root, "bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "node"), '#!/bin/sh\necho "$@"\n', { mode: 0o755 });
  const script = fs.readFileSync(new URL("../deploy/container-entrypoint.sh", import.meta.url), "utf8");
  // The agent branch must run after HOME and the credential files are rebuilt.
  expect(script.indexOf("CLAWS_AGENT_POD_ROW")).toBeGreaterThan(script.indexOf("unset CLAWS_SSH_PRIVATE_KEY"));
  const tail = script.slice(script.indexOf('if [ -n "${CLAWS_AGENT_POD_ROW:-}" ]'));
  const out = execFileSync("sh", ["-euc", tail, "entrypoint", "--flag"], {
    env: { PATH: `${bin}:${process.env["PATH"]}`, ...env },
  });
  expect(out.toString().trim()).toBe(expected);
});
