---
name: pcb-review
description: Review a KiCad hardware pull request from the repo's own PCB CI artifact — schematic, board and 3D views, DRC/ERC reports, netlist and BOM diffs — without rendering anything locally. Use when the user types `/pcb-review`, asks to review a board/PCB/schematic change, or a PR touches `hardware/**`.
---

You are almost certainly running inside a worktree of the repo whose hardware
changed, not the `claws` repo — never assume a `claws`-repo-relative path
exists. Everything you need is below.

**Hard rules, apply for the whole session:**

- Read-only. Never run `kicad-cli`, `render.sh`, `fab.sh`, `nix develop`, or
  any other renderer — the automation host has neither Nix nor `kicad-cli`,
  and rendering is the CI workflow's job, never yours.
- Never start a long-running process and never poll or wait in a loop for a
  CI run to finish; if the run you need is still in progress, report that
  with its URL and stop.
- Never `gh pr comment` or `gh pr review` unless the operator has explicitly
  asked you to post in this session. Producing the review is the job;
  posting it is a separate, opt-in step.

## Phase 0 — Pick the forge

Compare the host of `git remote get-url origin` to the host of
`$CLAWS_FORGEJO_BASE_URL`. Same host → this is a Forgejo-hosted repo (currently:
ha-carlink); use the "Forgejo" variant given in each phase below, and never run
`gh` against it. Different host → the GitHub path is unchanged, use `gh`
throughout as before.

On the Forgejo path, authenticate every request with `$CLAWS_FORGEJO_TOKEN` (the
`forgejo` capability, granted automatically to every ha-carlink session) — never
the separate read-only Forgejo token: its `claws-reader` team has no access to
pulls or actions on this repo and gets 403/404 on the endpoints below.

`<owner>/<repo>` in every Forgejo endpoint below comes from the path of the
`git remote get-url origin` URL already read above (strip any `.git` suffix).

## Phase 1 — Resolve the PR

- Numeric argument (`/pcb-review 92`) → that PR number.
- Any other argument → treat it as a head branch: `gh pr list --head
  <branch> --state all`.
- No argument → `gh pr view` on the current branch's open PR.

If nothing resolves, say so and stop.

Record: repo (`gh repo view --json nameWithOwner`), PR number, `headRefName`,
`headRefOid`, `baseRefName`, `state`. A merged PR is a valid target — its run
and artifact are usually still retained.

Fetch `gh pr diff <n> --name-only` and check whether it touches the repo's
hardware directory (see Conventions below). If it does not, give a one-line
"nothing to review" answer and stop — do not run the rest of the phases.

**Forgejo:**

- Numeric argument → `GET /api/v1/repos/<owner>/<repo>/pulls/<n>`; record
  `head.sha`, `head.ref`, `base.ref`, `state`, `merged`.
- Any other argument, or no argument (resolve the current branch first with
  `git branch --show-current`) → treat it as a head branch:
  `GET /api/v1/repos/<owner>/<repo>/pulls?state=all&limit=50`, filtered
  client-side on `.head.ref`; take the newest by `.updated_at`.
- Changed files → `GET /api/v1/repos/<owner>/<repo>/pulls/<n>/files`,
  `.[].filename`, paginating with `page=` until a page comes back short.
- Diff → `GET /api/v1/repos/<owner>/<repo>/pulls/<n>.diff`.

All Forgejo requests: `curl -sH "Authorization: token $CLAWS_FORGEJO_TOKEN"
"$CLAWS_FORGEJO_BASE_URL/api/v1/repos/<owner>/<repo>/..."`. Same
"nothing to review" rule if the changed files don't touch the hardware
directory.

## Phase 2 — Locate the run

Find the workflow: `gh run list --workflow pcb.yml --commit <headRefOid>
--event pull_request`. If the repo has no `pcb.yml`, run `gh workflow list`
and pick the workflow whose file or name matches `pcb` case-insensitively.

Take the newest **completed** run for the head SHA — `cancel-in-progress`
means an older run queued for the same branch was cancelled, so it is not
useful context. If the newest run for the head SHA is still in progress,
report that with its URL and stop; do not poll for it to finish.

If there is no run at all for the head SHA but the PR touches the hardware
directory, say plainly that the workflow did not run for this commit (path
filter, a cancelled run, or a fork PR whose workflow is gated) and stop.
Never fall back silently to an older SHA's run — you may mention the
branch's latest run as context only, clearly labelled as not matching the
head commit.

Record each job/step's conclusion with `gh run view <id> --json jobs` — you
need this later for the docs-SVG check (Phase 6e). If the run failed, also
pull `gh run view <id> --log-failed`.

**Forgejo:**

- `GET /api/v1/repos/<owner>/<repo>/actions/runs?head_sha=<sha>&event=pull_request`.
  If that filter has no effect, fall back to
  `GET /api/v1/repos/<owner>/<repo>/actions/runs` and filter client-side on
  `.workflow_runs[] | select(.commit_sha=="<sha>")`. Within the matches,
  filter to the `pcb` workflow (`.workflow_id`) and take the newest by `.id`.
- If the newest run's `.status` is not one of `success`, `failure`,
  `cancelled`, `skipped`, report its `.html_url` and stop — never poll, same
  rule as the GitHub path.
- No run at all for the head SHA → the same "did not run for this commit"
  message as GitHub, and the same rule against silently falling back to an
  older SHA's run.
- There is no per-job/step conclusion endpoint on Forgejo (`/jobs` 404s);
  step-level detail for Phase 6e comes from `fab/ci-status.txt` in the
  bundle instead, once it is downloaded in Phase 3.

## Phase 3 — Download the artifact

List artifacts first so an expired one is reported as expired, not as a
download failure:

```bash
gh api repos/<owner>/<repo>/actions/runs/<id>/artifacts
```

The artifact you want is the one whose name ends in `-fab` (e.g.
`ha-carlink-carrier-fab`, `heating-controller-pcb-fab`). If several match,
prefer the one containing a `preview/` directory once downloaded, and say
which one you chose and why.

Download into a scratch directory, never into the repo worktree and never
into another repo's data:

```bash
dir="$(mktemp -d "${TMPDIR:-/tmp}/pcb-review.XXXXXX")"
gh run download <id> -n <artifact-name> -D "$dir"
```

**Forgejo:**

List the PR's assets: `GET /api/v1/repos/<owner>/<repo>/issues/<n>/assets`.
The artifact you want is the entry whose name ends in `-fab-<head sha>.tgz`
(e.g. `ha-carlink-carrier-fab-<sha>.tgz`).

No matching asset — distinguish three cases before reporting, they mean
different things:
- no run at all for the head SHA (report as in Phase 2);
- the run is still in progress (report its URL and stop, as in Phase 2);
- the run completed but has no asset for this SHA — this is a CI defect in
  the workflow's attach step, say so explicitly; it is not the same as an
  expired GitHub artifact.

Download without following redirects (no `-L`) and extract into the same
kind of scratch directory as the GitHub path:

```bash
dir="$(mktemp -d "${TMPDIR:-/tmp}/pcb-review.XXXXXX")"
curl -fsSH "Authorization: token $CLAWS_FORGEJO_TOKEN" \
  -o "$dir/bundle.tgz" "<asset browser_download_url>"
tar -xzf "$dir/bundle.tgz" -C "$dir"
```

`-f` makes curl fail on an HTTP error instead of writing it to `bundle.tgz`
and exiting 0. If the download fails, report its status code rather than
passing the response to `tar` — a 3xx means the attachment is served from
redirected storage.

The bundle's tar root is `fab/`, so the artifact root for the rest of this
skill is `$dir/fab`, not `$dir` itself.

## Phase 4 — Inventory before reviewing

Print a present/missing table against the fixed layout below before reading
anything. This is the single source of truth for expected file names —
reference it, do not restate it elsewhere in your output.

| Path (under the artifact root) | Present for |
|---|---|
| `erc.rpt`, `erc-errors.rpt` | every PR run |
| `drc.rpt`, `drc-errors.rpt` | every PR run |
| `<project>-bom.csv` | every PR run |
| `<project>.net` | every PR run |
| `gerbers/` | every PR run |
| `preview/schematic/<project>.svg`, `.pdf` | repos with the preview convention |
| `preview/board/{front,back,assembly}.{svg,png}` | repos with the preview convention |
| `preview/3d/{top,bottom}.png` (or `preview/3d/RENDER_FAILED.txt`) | repos with the preview convention |
| `preview/ibom/ibom.html` | repos with the preview convention |
| `preview/netlist.xml` | repos with the preview convention |
| `preview/bom.csv` | repos with the preview convention |
| `preview/diff/SUMMARY.txt` | PR runs, repos with the preview convention |
| `preview/diff/{schematic-<project>,board-front,board-back,board-assembly}.diff.png` | PR runs, repos with the preview convention |
| `preview/diff/netlist.diff`, `preview/diff/bom.diff` | PR runs, repos with the preview convention |
| `preview/diff/base/` (or `preview/diff/SKIPPED.txt` when the base had no board) | PR runs, repos with the preview convention |

When `preview/` is absent entirely (a fab-only repo — see Conventions), glob
instead for `**/erc*.{rpt,json}`, `**/drc*.{rpt,json}`, `**/*.net.xml`,
`**/*bom*.csv`, `**/*.pdf` and review from whatever that finds. Every `preview/`
row absent in that case is one line in the report's Missing CI outputs
section, not a silent gap.

## Phase 5 — Read the evidence, in this order

1. ERC report, then DRC report: violation counts, every error and warning
   line, every exclusion.
2. Schematic — there is no schematic PNG; read `preview/schematic/<project>.pdf`
   with the Read tool's `pages` option (or the fab-only glob's `*.pdf`).
3. `preview/board/front.png`, `back.png`, `assembly.png`.
4. `preview/3d/top.png`, `bottom.png`. **3D renders are bare boards** — the
   CI workflow's `pcb` devShell uses `kicad-small`, which has no 3D component
   models — so do not flag a part as "missing" from a 3D view; there are
   never any part bodies there.
5. `preview/diff/SUMMARY.txt`, then `netlist.diff` and `bom.diff`, then each
   `*.diff.png` whose SUMMARY count is non-zero.

Never grep an SVG for silkscreen text — `kicad-cli` plots text as vector
strokes, not selectable text, so nothing in an SVG is greppable; silkscreen
review is visual, from the PNGs.

## Phase 6 — Checklist

Work through every item below. Each names its evidence source and how to
report a finding.

**(a) Connector pin order.** Compare each connector's pins in
`preview/netlist.xml` (or the fab-only `*.net.xml`) — `<node ref="J1"
pin="1" pinfunction="…">` per `<net>` — against the repo's documented wiring
tables (ha-carlink: `docs/WIRING.md` and `docs/PCB.md`'s "Connectors"
section; other repos: their equivalent doc named in Conventions). Report a
mismatch as `docs/WIRING.md:<line>` (or the matching doc) vs the pin found.

**(b) Silkscreen.** Every connector, polarity mark, voltage label and
warning label present and legible. Check `board/front.png`, `board/back.png`
(mirrored) and `board/assembly.png`. Report by view name.

**(c) Keepouts and mains/SELV boundaries**, where applicable. Read the PR
diff (`gh pr diff <n>`; on Forgejo, the `.diff` fetched in Phase 1) of
`*.kicad_pcb` and any board generator script for rule-area changes; read any
`.kicad_dru` clearance rules; check creepage across a mains/SELV boundary
visually on `board/front.png`.

**(d) DRC/ERC clean, with no severity downgrades.** This is checked from the
PR *diff*, not the report — a report only shows the current run's severities,
not whether they were quietly loosened to get a clean run:

```bash
gh pr diff <n>
```

(on Forgejo, the `.diff` fetched in Phase 1 instead) filtered to:
- `*.kicad_pro` — look at `rule_severities` under both
  `board.design_settings` and `erc`, and at `drc_exclusions`;
- `*.kicad_dru`;
- the CI scripts (`fab.sh`/`build.sh` or equivalent) — a removed
  `--severity-error` or `--exit-code-violations` flag silently turns a
  failing check into a non-failing one.

Cross-check against the report's own "Exclusions" lines.

**(e) Committed docs SVGs regenerated.** Check the run's "Render previews and
check docs/pcb/" step conclusion (from the `gh run view <id> --json jobs`
pulled in Phase 2), and confirm `docs/pcb/*.svg` appears in the PR's changed
files (`gh pr diff <n> --name-only`) whenever a `*.kicad_sch` or
`*.kicad_pcb` file changed.

**Forgejo:** read `render=<outcome>` from `fab/ci-status.txt` in the
extracted bundle instead of `gh run view --json jobs` — Forgejo's Actions
API has no `/jobs` endpoint. For the changed-files check, reuse the
`.[].filename` list fetched in Phase 1 instead of `gh pr diff <n> --name-only`.

**(f) BOM changes reflected.** Every `+`/`-` line in `preview/diff/bom.diff`
(or, for a fab-only repo, a hand diff of the old vs new `*-bom.csv`) should
be matched against the repo's BOM doc and `docs/shopping/*.yaml` items.
Report a gap as `docs/shopping/<file>.yaml:<line>` or the BOM doc's line.

## Phase 7 — Report

Fixed sections, in this order:

- **Target** — repo, PR, head SHA, run id and URL, artifact name chosen (on
  Forgejo, also the asset file name downloaded).
- **Missing CI outputs** — every expected-but-absent file from the Phase 4
  inventory, stated plainly as a CI gap to fix. Never review around a gap by
  guessing what it would have shown.
- **Checklist** — six verdicts (a)–(f), each with its evidence.
- **Findings** — `path:line` for repo files, view name (e.g. `board/back.png`,
  `diff/board-front.diff.png`) for images.
- **Verdict.**

End by asking whether to post this to the PR. Only run `gh pr comment` or
`gh pr review` on an explicit yes.

**Forgejo:** never `gh pr comment`/`gh pr review` — `gh` must never be
pointed at a Forgejo repo. On an explicit yes, post with
`POST /api/v1/repos/<owner>/<repo>/issues/<n>/comments`:

```bash
curl -fsSH "Authorization: token $CLAWS_FORGEJO_TOKEN" \
  -H "Content-Type: application/json" \
  -d "$(jq -n --arg body "<review text>" '{body: $body}')" \
  "$CLAWS_FORGEJO_BASE_URL/api/v1/repos/<owner>/<repo>/issues/<n>/comments"
```

## Phase 8 — Cleanup

Remove the scratch download directory (`rm -rf "$dir"`) once the review is
written.

## Conventions — what a hardware repo must provide

This is the fixed contract the skill depends on to find a repo's CI outputs.
A repo that has never seen ha-carlink's development history can still adopt
it from this section alone.

- `hardware/<board>/` holding `<project>.kicad_pro`, `.kicad_sch`,
  `.kicad_pcb`, any KiCad lib tables, and any generator script.
- `hardware/<board>/scripts/fab.sh`, `render.sh`, `render-diff.sh` (or
  documented equivalents) writing to `hardware/<board>/fab/` and
  `fab/preview/`.
- A path-filtered `.github/workflows/pcb.yml` (`.forgejo/workflows/pcb.yml`
  on Forgejo) that runs those scripts inside the flake's separate `pcb`
  devShell, on `[self-hosted, linux]`, and uploads `hardware/<board>/fab/`
  as artifact `<project>-fab` with `if: always()` (so a failing run still
  uploads its reports).
- Committed `docs/pcb/schematic.svg`, `docs/pcb/schematic-<sheet>.svg` (one
  per sub-sheet), `docs/pcb/board-front.svg`, `docs/pcb/board-back.svg`.
- A wiring/pinout table doc, and a BOM doc or `docs/shopping/*.yaml`
  manifest.

The full fixed artifact-layout table lives in Phase 4 above — this section
only names the source layout that produces it, not the file list itself.

Reference implementation: ha-carlink's `docs/PCB.md` ("Preview files",
"Regenerating the committed pictures"), `docs/BUILD_AND_CI.md` ("PCB CI"),
and `hardware/pcb/scripts/{fab,render,render-diff}.sh`. ha-carlink is
Forgejo-hosted, so read them per the Forgejo conventions section below, not
with `gh api`. For a GitHub-hosted repo's own reference files, read them
from any session with:

```bash
gh api repos/<owner>/<repo>/contents/<path> --jq .content | base64 -d
```

home-assistant-config's `hardware/heating-controller-pcb/` (artifact
`heating-controller-pcb-fab`, reports under `reports/`) is the **fab-only**
shape — no `preview/` tree — that the Phase 4 glob fallback exists for.
Adopting the full preview/diff convention there is separate, unscoped work;
until then, the skill lists every `preview/` row as missing for that repo
and reviews from the fab-only reports.

## Forgejo conventions

A Forgejo-hosted hardware repo's `pcb` workflow
(`.forgejo/workflows/pcb.yml`) must attach `<project>-fab-<head sha>.tgz` —
the same `fab/` tree as the run artifact, plus `fab/ci-status.txt` recording
each step's outcome — to the PR as an issue asset, deleting any older bundle
from the same PR first. This is what the Forgejo variants above read.
Reference implementation: ha-carlink's `.forgejo/workflows/pcb.yml`.

Reads of a Forgejo-hosted repo's own reference files (docs, scripts) use:

```bash
curl -sH "Authorization: token $CLAWS_FORGEJO_TOKEN" \
  "$CLAWS_FORGEJO_BASE_URL/api/v1/repos/<owner>/<repo>/raw/<path>"
```

never `gh api .../contents/<path>` — `gh` must never be pointed at a
Forgejo repo.
