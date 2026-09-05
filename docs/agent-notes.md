# Agent notes

**Reference.** Read this when you hit an operator/host gotcha that doesn't
belong to one subsystem doc. Durable, hard-won operator and host facts
refined from agent memory stores and re-verified against the current
codebase.

- If a live Claude session comes up without `--dangerously-skip-permissions`, do not assume Claws stopped passing it. The current launch paths in `src/sessions.ts` and `src/claude.ts` still add the flag explicitly. The known failure mode is the Claude CLI self-reexecing after an auto-update and dropping original flags, so diagnose with `/proc/<pid>/cmdline` before changing Claws.
- On the Claws automation host, the `node`/`npm`/`npx` resolved via the default shell PATH are nvm-managed (v22.x) and segfault loading prebuilt native addons (`better-sqlite3` — `new Database(...)` crashes inside N-API module registration, not sqlite3 code itself). This isn't a broken package: `/usr/bin/node` (the same binary that runs the live `claws.service`) loads the identical prebuild fine. If `npm test`/`npm ci` on this repo, on this host, crash or hang on worker exits — especially in `db.test.ts` or anything importing `db.ts` — rerun with the system binaries explicitly (`/usr/bin/npm ci`, `/usr/bin/node node_modules/.bin/vitest run`) rather than reinstalling or rebuilding the native module from source.
- The shared self-hosted macOS Actions runner (woken by `mac-runner-waker` for `bonkus`/`namey`/`TempoStatusBar` jobs) has npm's `ignore-scripts=true` set at the user/global config layer. `npm ci` exits 0 but silently skips every postinstall script across all managed repos that use this runner — there is no error output. A workflow step relying on a postinstall to populate assets must invoke the package's bin explicitly (e.g. `npx <bin>`) instead; diagnose with `npm config get ignore-scripts` in a workflow step.
