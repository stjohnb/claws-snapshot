#!/usr/bin/env bash
# Install dependencies for CI and prove native bindings load.
#
# npm silently drops optional dependencies that fail to fetch or extract, so
# `npm ci` can exit 0 without @img/sharp-libvips-linux-x64 (CI run 74 failed
# with ERR_DLOPEN_FAILED: libvips-cpp.so.8.18.7). Verify and retry cleanly.
#
# The same happened to rolldown: CI run 491 (2026-10-18) passed `npm ci` and the
# sharp check, but vitest aborted at startup with "Cannot find native binding"
# because @rolldown/binding-linux-x64-gnu was missing. rolldown is checked too.
set -euo pipefail

attempts=3
for i in $(seq 1 "$attempts"); do
  if npm ci && node --input-type=module -e "
for (const m of ['sharp', 'rolldown']) {
  try { await import(m); } catch (e) {
    console.error('::error::' + m + ' failed to load its native binding after npm ci: ' + e.message);
    process.exit(1);
  }
}
"; then
    echo "sharp and rolldown loaded after npm ci attempt $i"
    exit 0
  fi
  echo "npm ci / native binding load check failed on attempt $i" >&2
  ls -la node_modules/@img || true
  npm ls @img/sharp-linux-x64 @img/sharp-libvips-linux-x64 || true
  ls -la node_modules/@rolldown || true
  npm ls rolldown @rolldown/binding-linux-x64-gnu || true
  rm -rf node_modules
  sleep 5
done

echo "::error::a native binding (sharp's libvips or rolldown's @rolldown/binding-*) failed to install after $attempts npm ci attempts"
exit 1
