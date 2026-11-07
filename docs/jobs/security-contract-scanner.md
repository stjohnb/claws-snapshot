# security-contract-scanner

**Deep dive.** Read this when you're changing the scanner that asks every repo
to declare a security policy, or its drift checks. For the contract itself, read
[../security-contract.md](../security-contract.md); for Claws' own policy,
[../security.md](../security.md).

Product requirements: [product/operations-and-safety.md](../product/operations-and-safety.md)

**Source**: `src/jobs/security-contract-scanner.ts`, rules in `src/security-contract.ts`,
drift checks in `src/security-drift.ts`, follow-up issue in `src/contract-drift.ts`
**Trigger**: Via `scanner-dispatcher` (daily schedule)

Every managed repo declares its security policy: what it ships and runs, how
dependency and image vulnerabilities are found, where accepted findings live
(`.vex/`), how secrets reach the code, how the supply chain is pinned, what is
exposed and how it authenticates, and its Known gaps. This scanner files one
issue in every repo whose policy is missing or incomplete, and one follow-up
issue in every repo whose policy lists unaccepted gaps or disagrees with its
code.

## Scope

All monitored repos, Claws included. No repo is exempt by type: compliance is
judged on the policy text alone, and workflows are never parsed to decide it.
`detectRepoKind` (container service, infra, static site, CLI or library,
firmware or hardware, config-only) only picks the guidance shown in the issue.

## Declare pass

The scanner reads `SECURITY_DOC_PATHS` in order and stops at the first doc whose
policy meets every rule (`missingSecurityRules` empty):

1. `docs/security.md` — the whole file is the policy.
2. `AGENTS.md` — the best section under a heading naming security
   (`findSecuritySection`).

Each of the seven `###` subsections (Scope, Dependency and image
vulnerabilities, Accepted findings, Secrets, Supply chain, Exposure and
authentication, Known gaps) must be present, non-empty and placeholder-free,
and match its keyword rule or say it does not apply with a reason; Known gaps
needs list items or `None.`. `no-placeholders` fails while any
`TODO(security):` line remains. The table is in
[the contract doc](../security-contract.md#rules).

When a rule fails it files one issue:

- Title `chore: declare this repo's security policy` (frozen — it is the
  dedupe key). No labels; a human reviews each plan.
- The body lists the detected repo kind, the incomplete policy doc (or that
  none exists), any accepted doc that exists with no `## Security` heading, the
  missing subsections, the `SECURITY_GUIDANCE` bullets for the repo's kind, the
  starter template in a four-backtick fence, the contract link and the `/jobs`
  disable note. When a policy already exists, a **Check the policy against the
  code** paragraph says it is not a rewrite.
- Only open issues are deduplicated, so a repo that later regresses gets a
  fresh one.

## Known-gaps follow-up

After the declare pass the scanner reads each repo's policy (the whole
`docs/security.md`, else the security section of `AGENTS.md`), parses its Known
gaps with `parseKnownGaps` (the observability grammar: one gap per top-level
list item, accepted when it starts `Accepted:`) and runs the
[drift checks](#drift-checks). With one or more unaccepted gaps or drift items
it files one native issue through `refreshFollowUpIssue`
(`src/contract-drift.ts`):

- Title `chore: close this repo's known security gaps`, dedupe key
  `security-known-gaps`, source `automation`, unapproved.
- The body lists **Unaccepted gaps** and **Drift: the policy says X, the code
  shows Y**, each drift item with its `file:line`, and asks to fix the code, or
  correct the policy and list the shortfall under Known gaps.
- While it is open, the scan rewrites its body in place when either list
  changes.
- When the newest keyed issue closed as not planned, it is never re-filed.
  After a close as completed it is re-filed only while gaps or drift remain.
- No gaps (or only accepted ones) and no drift files nothing.
- A failure for one repo is reported as `security-contract-scanner:known-gaps`
  and does not stop the others.

## Drift checks

`detectSecurityDrift(repoDir, policyText)` (`src/security-drift.ts`) runs four
`DriftRule`s through `runDriftRules`. Each fires only on a claim the policy
makes, reads only the repo, and is recomputed every scan, never stored:

| Rule | Fires when the policy… | Drift |
|---|---|---|
| `image-gate` | claims an image push (`policyClaimsImagePublish`) | a `.forgejo/workflows/*.y*ml` line pushing an image (`docker push`, `podman push`, `buildah push`, `--push`, `push: true`) with no `trivy`, `grype` or `scripts/ci/*scan*.sh` line earlier in the same file |
| `undeclared-image` | says the repo publishes no container image | any workflow line pushing an image; a bare registry hostname is not a push, because it may be a pull |
| `sha-pinning` | claims in its Supply chain subsection that actions are SHA-pinned (`pinned to a commit SHA`, `SHA-pinned`, …) | a `uses:` not ending in `@<40 hex>`; `./` and `docker://` values are exempt |
| `vex` | (always) | a `.vex/*.json` that is not valid JSON or fails `validateVexDocument` |

Full-line YAML comments are ignored, so a comment never counts as a push or a
scan. The file-order check can pass a scan placed in an unrelated job; the PR
reviewer's Security checklist item covers that. Every finding is keyed by its
file, so a Known gaps item, accepted or not, that names the file in backticks
suppresses it (`suppressListed`). `src/security-drift.test.ts` asserts Claws'
own policy shows no drift.

## Observability

One `info` line per repo, `drift check finished`, carries `repo`, `gaps` and
`drift` counts; `refreshFollowUpIssue` logs one `info` line when it files,
updates or skips the follow-up. Failures go through `reportError`. The scanner
adds no route, DB query or metric.

## Opting out

List `security-contract-scanner` in the repo's `claws.json` `disabledJobs`
(the `/jobs` matrix shows it on the `scanner-dispatcher` cell) rather than
closing the issue; an open issue
with the frozen title is otherwise re-filed on the next daily scan.
