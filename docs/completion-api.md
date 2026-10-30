# One-shot completion API

`POST /api/completion/<owner>/<name>` runs a single non-interactive LLM
completion for a service Claws manages and returns its text. The service uses
the Claude, Codex and OpenCode subscriptions Claws already logs into, so it
does not bundle an agent CLI or carry its own copy of a login. growth-engine's
social drafter is the first caller (#clw_01M5NF2W61G3G3V8JZ2H6EF1YY).

The code is in `src/completion-api.ts`. The isolated run mode is
`RunClaudeOptions.isolatedCompletion` in `src/claude.ts`.

## Opting a repo in

The calling repo commits the SHA-256 of a bearer token as `completion.tokenSha256`
in its `claws.json` ([repo-config.md](repo-config.md)):

```sh
t=$(openssl rand -hex 32)                         # the token: into the service's SOPS-encrypted Secret only
printf '%s' "$t" | sha256sum | cut -d' ' -f1      # the hash: commit it
```

```json
{ "completion": { "tokenSha256": "<64 lowercase hex characters>" } }
```

- Mint a new token for this key. A hash equal to the repo's `issueFiler` or
  `alertBridge` hash is ignored with a warning, so each token reaches only one
  route family.
- A repo with no valid `completion` entry gets 401 on every request.
- The token works only on its own repo's path. It gets 401 on every other Claws
  route, and no operator session, agent token or other repo's token is accepted here.
- A rotated hash takes effect within about a minute of merging. A token mismatch
  re-reads the cached `claws.json` once, at most once a minute per repo.

## Request

```http
POST /api/completion/St-John-Software/growth-engine
Authorization: Bearer <token>
Content-Type: application/json

{ "prompt": "Draft a Bluesky post about …", "system": "You write short posts.", "provider": "claude", "model": "sonnet" }
```

| Field | Required | Meaning |
|---|---|---|
| `prompt` | yes | Non-empty string. Sent to the CLI on stdin, never in argv. |
| `system` | no | Replaces the CLI's own system prompt. Claude reads it with `--system-prompt-file`; Codex and OpenCode get it as a `<system-instructions>` block before the prompt. |
| `provider` | no | `claude`, `codex` or `opencode`, if the operator has that provider enabled. `pi` is never offered. |
| `model` | no | One of the provider's session models: Claude `fable`, `opus`, `sonnet`, `haiku`; Codex and OpenCode, the ids the dashboard's New Session form lists. A model without a provider is a Claude model. |

## Defaults

There are no new config keys.

- **Provider:** `claude`.
- **Model:** the `sonnet` tier, resolved through `getModel("sonnet", provider)`,
  so it follows the operator's per-provider tier config.
- **Pinning:** a request that names a provider or a model is pinned and never
  falls back. An unpinned request starts on Claude. If Claude is at its usage
  limit, it may fall back across the enabled weighted pool, limited to Claude,
  Codex and OpenCode.

## Response

`200` with `{ "text": "…", "provider": "claude", "model": "sonnet" }`, giving
the provider and model that actually ran. `model` is `null` when the provider's
own default was used.

| Status | When |
|---|---|
| 400 | Invalid JSON, a missing prompt, a wrong field type, or an unknown provider or model. The error names the valid choices. Also returned when the provider's account cannot use the model. |
| 401 | `{"error":"unauthorized"}`: a missing or wrong token, another repo's token, or a repo with no `completion` entry. |
| 413 | `prompt` and `system` together exceed 100,000 characters, or the body exceeds 512 KiB. |
| 429 | The caller already has 2 completions running (`Retry-After: 5`). Also returned when the provider is at its usage limit: a pinned provider, or every provider an unpinned request could use. `Retry-After` is then the breaker's remaining time, or 60 s when that is unknown. |
| 502 | `{"error":"completion failed"}`: any other CLI failure. The error text is never returned. |
| 503 | No provider is eligible, or Claws is shutting down. |
| 504 | The run exceeded 120 s, or the whole request exceeded 145 s (the run plus up to 25 s waiting for memory admission). A timed-out run is never retried. |

## Isolation

Every backend runs with:

- **Working directory:** a fresh, empty `fs.mkdtemp` directory, removed afterwards.
  The system-prompt file is in a separate temporary directory.
- **No tools and no MCP:**
  - Claude: `-p --output-format json --tools "" --strict-mcp-config --disable-slash-commands --no-session-persistence`, with no `--dangerously-skip-permissions`, plus `DISABLE_AUTOUPDATER=1` and `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`.
  - Codex: `exec --json --skip-git-repo-check --ephemeral --ignore-user-config --ignore-rules --sandbox read-only`, with `--disable` for each of `shell_tool`, `unified_exec`, `apps`, `plugins`, `browser_use`, `computer_use`, `in_app_browser` and `image_generation`, and `-c web_search="disabled"`.
  - OpenCode: `OPENCODE_CONFIG_CONTENT={"permission":"deny","tools":{"*":false},"mcp":{}}`, with no `--agent`.
- **An allow-listed environment:** `PATH`, `HOME`, `LANG`, `LC_ALL`, `TZ` and
  `TMPDIR`, plus only the running backend's own login: Claude
  `CLAUDE_CODE_OAUTH_TOKEN` (the chosen account's token, read from the
  database; see [Claude accounts](configuration.md#claude-accounts)), Codex `CODEX_HOME`, OpenCode `OPENROUTER_API_KEY`.
  There are no `CLAWS_*` keys, no GitHub or Forgejo token, no `GIT_*` identity
  or credential helper, and no capability env.
- **Nothing written to disk:** no repository instructions, role document or
  capability guidance, and no prompt capture, output file or verdict file.

The run cannot be network-sandboxed inside the pod, so the CLIs' own flags are
the tool boundary. The empty working directory and allow-listed environment
keep what remains small.

## Limits and usage

- **Admission:** each run takes the auxiliary memory lane (`AUXILIARY_AGENT_ADMISSION_BYTES`).
- **Usage tracking:** each call is a `tasks` row with job `completion-api`, the
  caller as repo, and item `0`. Tokens and cost are written through
  `trackTaskTokens`, so they count toward the per-provider usage views like any
  other run.
- **Shared rate limits:** a usage limit hit here opens the same per-provider
  (and per-Claude-tier) breaker that agent runs use.
- **Concurrency:** at most 2 completions per caller repo, counted in memory in
  the controller. A run that outlives the 145 s deadline keeps its slot until
  its CLI exits.
- **Logs:** a line records the repo, provider, model, status, duration and
  character counts. It never records the prompt, system prompt, output or an
  error's text. In isolated mode the CLI runner logs only the byte counts of
  stdout and stderr.

## Where it runs

The run happens in the controller, which holds the provider logins and the
rate-limit breaker. A `CLAWS_ROLE=web` pod forwards this one route to
`CLAWS_CONTROLLER_URL` with its `Authorization` header, with a 150 s
headers timeout and no dashboard auth, and the controller checks the token.
No other proxied route forwards `Authorization`.
