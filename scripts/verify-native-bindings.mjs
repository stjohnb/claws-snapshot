#!/usr/bin/env node
// postinstall: prove the native bindings npm installed actually load.
//
// npm silently drops an optional dependency whose fetch or extract fails, so
// `npm ci` can exit 0 without sharp's libvips (CI run 74) or rolldown's
// @rolldown/binding-* (CI run 491, friction note 405), and the failure only
// shows up later as "Cannot find native binding" in vitest. This makes the
// install itself fail, naming the module. A package that is not installed at
// all (an `--omit=dev` install leaves out rolldown) is skipped.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let failed = false;
for (const name of ["sharp", "rolldown"]) {
  if (!fs.existsSync(path.join(root, "node_modules", name, "package.json"))) continue;
  try {
    await import(name);
  } catch (e) {
    failed = true;
    console.error(`verify-native-bindings: ${name} failed to load its native binding after install: ${e instanceof Error ? e.message : String(e)}`);
  }
}
if (failed) {
  console.error("verify-native-bindings: npm dropped an optional native binding; run `npm ci` again.");
  process.exit(1);
}
