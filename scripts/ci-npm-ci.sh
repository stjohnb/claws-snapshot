#!/usr/bin/env bash
# Install dependencies for CI and prove sharp's native libvips loads.
#
# npm silently drops optional dependencies that fail to fetch or extract, so
# `npm ci` can exit 0 without @img/sharp-libvips-linux-x64 (CI run 74 failed
# with ERR_DLOPEN_FAILED: libvips-cpp.so.8.18.7). Verify and retry cleanly.
set -euo pipefail

attempts=3
for i in $(seq 1 "$attempts"); do
  if npm ci && node --input-type=module -e "await import('sharp')"; then
    echo "sharp loaded after npm ci attempt $i"
    exit 0
  fi
  echo "npm ci / sharp load check failed on attempt $i" >&2
  ls -la node_modules/@img || true
  npm ls @img/sharp-linux-x64 @img/sharp-libvips-linux-x64 || true
  rm -rf node_modules
  sleep 5
done

echo "::error::sharp's native libvips package failed to install after $attempts npm ci attempts"
exit 1
