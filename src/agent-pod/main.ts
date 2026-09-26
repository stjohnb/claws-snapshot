import fs from "node:fs";
import module from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { LAUNCH_SPEC_KEY, WORKLOAD_HOME, WORKLOAD_SECRET_DIR } from "../k8s/workload.js";
import * as log from "../session-pod/log.js";
import { createDbRedirectResolve } from "./db-redirect.js";

// Agent pod runtime (#clw_01M34R5RECDPPXVXBJZS1DA6C1), entry
// `dist/agent-pod/main.js`: runs one claimed work-queue row outside the
// service, so a Claws restart no longer kills it. `deploy/container-entrypoint.sh`
// execs this when `CLAWS_AGENT_POD_ROW` is set, after it has rebuilt HOME.
//
// Writes the launch spec's files (`~/.claws/config.json`) before anything
// reads them, so it must never import `config.js`,
// `log.js`, `db.js` or anything that pulls them in at top level; `./run.js`
// is imported only once the files are in place, and only after the resolve
// hook that turns every `db.js` import into `db-remote.js` (the pod has no
// database, only the service's agent-pod ops API). Importing this module has
// no side effects.

export const AGENT_LAUNCH_SPEC_PATH = path.join(WORKLOAD_SECRET_DIR, LAUNCH_SPEC_KEY);

export const AgentLaunchSpecSchema = z.object({
  rowId: z.number().int().positive(),
  runId: z.string().min(1),
  /** Files written inside HOME before the service modules load. */
  files: z.array(z.object({
    path: z.string(),
    content: z.string(),
    mode: z.number().int().optional(),
  })).default([]),
});

export type AgentLaunchSpec = z.infer<typeof AgentLaunchSpecSchema>;

export function loadAgentLaunchSpec(file = AGENT_LAUNCH_SPEC_PATH): AgentLaunchSpec {
  return AgentLaunchSpecSchema.parse(JSON.parse(fs.readFileSync(file, "utf8")));
}

/** `p` resolved against `home`; throws if it lands outside it. */
export function resolveInHome(home: string, p: string): string {
  const root = path.resolve(home);
  const resolved = path.resolve(root, p);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new Error(`path escapes HOME: ${p}`);
  }
  return resolved;
}

/** Write the launch spec's files inside `home`, at 0600 unless the spec says otherwise. */
export function writeLaunchFiles(home: string, files: AgentLaunchSpec["files"]): void {
  for (const file of files) {
    const target = resolveInHome(home, file.path);
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    const mode = file.mode ?? 0o600;
    fs.writeFileSync(target, file.content, { mode });
    // writeFileSync keeps an existing file's mode; the spec's mode must win.
    fs.chmodSync(target, mode);
  }
}

export async function main(): Promise<void> {
  let spec: AgentLaunchSpec;
  try {
    spec = loadAgentLaunchSpec();
    writeLaunchFiles(process.env["HOME"] || WORKLOAD_HOME, spec.files);
  } catch (err) {
    // A JSON syntax error message quotes the input, so only zod's (structural) message is printed.
    log.error(`Agent pod setup failed: ${err instanceof z.ZodError ? err.message : err instanceof SyntaxError ? "launch spec is not valid JSON" : err instanceof Error ? err.message : "unknown error"}`);
    process.exit(1);
  }

  let runWorkRow: (rowId: number, runId: string) => Promise<never>;
  try {
    module.registerHooks({
      resolve: createDbRedirectResolve(import.meta.resolve("../db.js"), import.meta.resolve("../db-remote.js")),
    });
    ({ runWorkRow } = await import("./run.js"));
  } catch (err) {
    log.error("Agent pod could not load the Claws service modules", err);
    process.exit(1);
  }
  log.info(`Running work row ${spec.rowId} (run ${spec.runId})`);
  try {
    await runWorkRow(spec.rowId, spec.runId);
  } catch (err) {
    // runRow records its own failures; this is the boot (ops API, handlers) failing.
    log.error(`Agent pod failed to run work row ${spec.rowId}`, err);
    process.exit(1);
  }
}

function isEntryPoint(): boolean {
  const script = process.argv[1];
  if (!script) return false;
  try {
    return import.meta.url === pathToFileURL(fs.realpathSync(script)).href;
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  void main();
}
