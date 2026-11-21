#!/usr/bin/env bash
# Image scan gate (docs/security-contract.md): scans each given image with trivy
# and fails on any fixable HIGH/CRITICAL finding not covered by a `.vex/`
# OpenVEX `not_affected` statement. Run it between `docker build` and
# `docker push`, inside `nix develop .#scripts` (trivy, jq).
#
#   scripts/ci/image-scan.sh IMAGE[:TAG] [IMAGE[:TAG]...]
#
# 1. Validates every .vex/*.json with the same checks as validateVexDocument in
#    src/security-contract.ts; an invalid statement fails the gate.
# 2. Downloads the trivy DB itself from several mirrors: trivy's own fallback
#    only triggers on transient transport errors, so a plain 404 from
#    mirror.gcr.io (2026-10-23, bonkus) aborted the scan without trying ghcr.io.
#    If every source fails the scan is skipped with a loud warning and the push
#    goes ahead; the weekly fleet-infra/production-infra scan is the backstop.
# 3. Scans each image with one --vex per statement file.
#
# Never add `set -x`: the caller's environment holds registry credentials.
set -uo pipefail

if [ "$#" -eq 0 ]; then
  echo "usage: $0 IMAGE[:TAG]..." >&2
  exit 2
fi

vex_dir="${VEX_DIR:-.vex}"
vex_args=()
vex_invalid=0
if [ -d "$vex_dir" ]; then
  shopt -s nullglob
  for f in "$vex_dir"/*.json; do
    # Keep these checks and messages identical to validateVexDocument.
    if ! errors=$(jq -r '
      def nonempty: type == "string" and (gsub("^\\s+|\\s+$"; "") != "");
      def obj: type == "object";
      ["component_not_present", "vulnerable_code_not_present", "vulnerable_code_not_in_execute_path",
       "vulnerable_code_cannot_be_controlled_by_adversary", "inline_mitigations_already_exist"] as $just
      | if (obj | not) then "document is not a JSON object"
        else
          (if ((.["@context"] | type) == "string" and (.["@context"] | startswith("https://openvex.dev/ns"))) then empty
           else "@context is not an OpenVEX context (https://openvex.dev/ns/...)" end),
          (if ((.statements | type) != "array") or ((.statements | length) == 0) then "statements is missing or empty"
           else
             .statements | to_entries[] | .key as $i | .value as $s | "statements[\($i)]" as $at
             | if ($s | obj | not) then "\($at) is not an object"
               else
                 (if (($s.vulnerability | obj) and ($s.vulnerability.name | nonempty)) then empty else "\($at).vulnerability.name is missing" end),
                 (if ((($s.products | type) == "array") and (($s.products | length) > 0)
                      and ($s.products | all(obj and ((.["@id"] | nonempty)
                        or ((.identifiers | obj) and ([.identifiers[] | nonempty] | any)))))) then empty
                  else "\($at).products is missing, empty, or has a product without @id or identifiers" end),
                 (if $s.status == "not_affected" then empty
                  else "\($at).status is \($s.status | tojson); only \"not_affected\" is allowed" end),
                 (if (($s.justification | type) == "string") and ($s.justification as $j | $just | index($j)) then empty
                  else "\($at).justification is missing or not one of the five OpenVEX justifications" end),
                 (if ($s.impact_statement | nonempty) then empty else "\($at).impact_statement is missing or empty" end)
               end
           end)
        end
    ' "$f" 2>&1); then
      echo "::error file=$f::not valid JSON: $errors"
      vex_invalid=1
      continue
    fi
    if [ -n "$errors" ]; then
      while IFS= read -r line; do echo "::error file=$f::$line"; done <<<"$errors"
      vex_invalid=1
      continue
    fi
    vex_args+=(--vex "$f")
  done
  shopt -u nullglob
fi
if [ "$vex_invalid" -ne 0 ]; then
  echo "::error::invalid OpenVEX statement(s) under $vex_dir/ — every statement must be not_affected with a justification and an impact_statement (docs/security-contract.md)"
  exit 1
fi
echo "using $(( ${#vex_args[@]} / 2 )) OpenVEX file(s) from $vex_dir/"

sources="${TRIVY_DB_REPOSITORIES:-mirror.gcr.io/aquasec/trivy-db:2 ghcr.io/aquasecurity/trivy-db:2 public.ecr.aws/aquasecurity/trivy-db:2}"
attempts="${TRIVY_DB_ATTEMPTS_PER_SOURCE:-2}"
delay="${TRIVY_DB_RETRY_DELAY_SECONDS:-15}"
# A hanging mirror counts as a failed source instead of running the step into
# its timeout, which would lose the release the outage tolerance protects.
per_attempt="${TRIVY_DB_ATTEMPT_TIMEOUT_SECONDS:-180}"

downloaded=""
for src in $sources; do
  for attempt in $(seq 1 "$attempts"); do
    # Forgejo exports a GITHUB_TOKEN that ghcr.io would reject.
    if err=$(timeout "$per_attempt" env -u GITHUB_TOKEN -u GITHUB_ACTOR trivy image --quiet --download-db-only --db-repository "$src" 2>&1); then
      downloaded="$src"
      break 2
    fi
    echo "::warning::runner infrastructure: trivy DB download from $src failed (attempt $attempt/$attempts): $(printf '%s\n' "$err" | tail -1)"
    [ "$src" = "${sources##* }" ] && [ "$attempt" -eq "$attempts" ] || sleep "$delay"
  done
done

if [ -z "$downloaded" ]; then
  msg="runner infrastructure: trivy vulnerability DB unavailable from every source ($sources) — images were NOT scanned and the push goes ahead; the weekly fleet-infra/production-infra image scan is the backstop"
  echo "::warning::$msg"
  [ -n "${GITHUB_STEP_SUMMARY:-}" ] && echo "$msg" >> "$GITHUB_STEP_SUMMARY"
  exit 0
fi
echo "trivy DB downloaded from $downloaded"

failed=0
for img in "$@"; do
  echo "scanning $img"
  trivy image --scanners vuln --severity HIGH,CRITICAL --ignore-unfixed --exit-code 1 \
    --skip-db-update --skip-java-db-update --show-suppressed "${vex_args[@]}" "$img" || failed=1
done

if [ "$failed" -ne 0 ]; then
  echo "::error::trivy found fixable HIGH/CRITICAL findings not covered by $vex_dir/, or could not scan with a usable DB — fix them by a bump, or add an OpenVEX not_affected statement only when the finding truly does not apply (docs/security-contract.md)"
  exit 1
fi
echo "no fixable HIGH/CRITICAL findings"
