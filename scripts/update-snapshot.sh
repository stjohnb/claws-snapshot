#!/usr/bin/env bash
# Mirror the current claws repo (tracked files only) into the public
# stjohnb/claws-snapshot repo as a new commit on top of the existing snapshot history.
# Run manually from a clean checkout of `main` by a maintainer with push
# access to stjohnb/claws-snapshot. Secrets (.mcp-claws.json, config.json,
# *.env) are gitignored and excluded by construction via `git archive`.
set -euo pipefail

SNAPSHOT_REPO="${SNAPSHOT_REPO:-https://github.com/stjohnb/claws-snapshot.git}"
SNAPSHOT_BRANCH="main"

REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT"

# 1. Require a clean working tree so the snapshot matches a real commit.
if [[ -n "$(git status --porcelain)" ]]; then
  echo "ERROR: working tree not clean — commit or stash first." >&2; exit 1
fi
SRC_SHA="$(git rev-parse --short HEAD)"

WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"' EXIT
EXPORT_DIR="$WORKDIR/export"
mkdir -p "$EXPORT_DIR"

# 2. Export ONLY tracked files — gitignored secrets are excluded.
git archive HEAD | tar -x -C "$EXPORT_DIR"

# 3. Defensive: assert no secret files slipped in.
for f in .mcp-claws.json config.json; do
  if [[ -e "$EXPORT_DIR/$f" ]]; then
    echo "ERROR: $f present in export — aborting." >&2; exit 1
  fi
done
if find "$EXPORT_DIR" -name '*.env' | grep -q .; then
  echo "ERROR: .env file present in export — aborting." >&2; exit 1
fi

# 4. Secret-scan safety net (high-confidence credential patterns only,
#    to avoid false positives on SHAs / JWT header test fixtures).
if grep -rIE \
  -e 'eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}' \
  -e 'gh[pousr]_[A-Za-z0-9]{36,}' \
  -e 'github_pat_[A-Za-z0-9_]{50,}' \
  "$EXPORT_DIR" >/dev/null; then
  echo "ERROR: potential credential detected in export — aborting." >&2; exit 1
fi

# A "BEGIN … PRIVATE KEY" header counts only when the next line is real
# base64 key material — doc placeholders like "<contents of ~/.ssh/key>"
# share the header text but never have a key body, so they pass. grep -I
# enumerates header-bearing text files (skipping binary); awk then confirms
# a key body follows the header in each.
while IFS= read -r f; do
  [[ -z "$f" ]] && continue
  if awk '
      prev ~ /-----BEGIN [A-Z ]*PRIVATE KEY-----/ \
        && /^[[:space:]]*[A-Za-z0-9+\/]{40,}={0,2}[[:space:]]*$/ { found = 1 }
      { prev = $0 }
      END { exit found ? 0 : 1 }' "$f"; then
    echo "ERROR: private key material detected in $f — aborting." >&2; exit 1
  fi
done < <(grep -rIlE -e '-----BEGIN [A-Z ]*PRIVATE KEY-----' "$EXPORT_DIR" || true)

# 5. Clone the snapshot, preserve LICENSE, replace all other content,
#    commit on a new branch, and open a PR against main.
CLONE_DIR="$WORKDIR/snapshot"
git clone --depth 1 "$SNAPSHOT_REPO" "$CLONE_DIR"
cd "$CLONE_DIR"
PR_BRANCH="snapshot-${SRC_SHA}"
git checkout -b "$PR_BRANCH"
find . -mindepth 1 -maxdepth 1 ! -name '.git' ! -name 'LICENSE' -exec rm -rf {} +
cp -a "$EXPORT_DIR/." .
git add -A
if git diff --cached --quiet && git diff --quiet; then
  echo "Nothing changed — snapshot already up to date."; exit 0
fi
git commit -m "Snapshot of claws @ ${SRC_SHA}"
git push "$SNAPSHOT_REPO" HEAD:"$PR_BRANCH"
gh pr create \
  --repo "${SNAPSHOT_REPO%.git}" \
  --base "$SNAPSHOT_BRANCH" \
  --head "$PR_BRANCH" \
  --title "Snapshot of claws @ ${SRC_SHA}" \
  --body "Automated snapshot of [St-John-Software/claws](https://github.com/St-John-Software/claws) at commit ${SRC_SHA}."

echo "Done. Opened PR for snapshot of ${SRC_SHA} against ${SNAPSHOT_BRANCH} in ${SNAPSHOT_REPO}."
