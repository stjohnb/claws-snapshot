# Agent notes

**Reference.** Read this when you hit an operator/host gotcha that doesn't
belong to one subsystem doc. Durable, hard-won operator and host facts
refined from agent memory stores and re-verified against the current
codebase.

- If a live Claude session comes up without `--dangerously-skip-permissions`, do not assume Claws stopped passing it. The current launch paths in `src/sessions.ts` and `src/claude.ts` still add the flag explicitly. The known failure mode is the Claude CLI self-reexecing after an auto-update and dropping original flags, so diagnose with `/proc/<pid>/cmdline` before changing Claws.
- The shared self-hosted macOS Actions runner (woken by `mac-runner-waker` for `bonkus`/`namey`/`TempoStatusBar` jobs) has npm's `ignore-scripts=true` set at the user/global config layer. `npm ci` exits 0 but silently skips every postinstall script across all managed repos that use this runner — there is no error output. A workflow step relying on a postinstall to populate assets must invoke the package's bin explicitly (e.g. `npx <bin>`) instead; diagnose with `npm config get ignore-scripts` in a workflow step.
- npm 11.20+ (the agent image's npm) skips a dependency's install scripts unless `package.json` `allowScripts` approves the package, and only warns "install scripts not yet covered by allowScripts". Claws approves better-sqlite3, node-pty, esbuild, @parcel/watcher, protobufjs and baileys by name (`npm install-scripts approve --no-allow-scripts-pin <pkg>`, after `npm ci` so the package is installed) so Renovate bumps keep native builds on; older npm, such as CI's devShell npm, ignores the field. Separately, `src/test-env-scrub.ts` (vitest `setupFiles`) deletes the pod's `CLAWS_*` (except `CLAWS_TEST_PGLITE`), `CLAUDE_CODE_*`, `GIT_CONFIG_*`, `GH_TOKEN`, `GITHUB_TOKEN` and `KUBECONFIG` before each test file, so a test that needs one sets it itself.
