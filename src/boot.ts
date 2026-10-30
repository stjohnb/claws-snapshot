/**
 * Service entry point. Materialises the operator config from the database into
 * `~/.claws/config.json` before `main.ts` (and through it `config.ts`, which
 * reads that file synchronously at import) loads. See `src/config-store.ts`.
 */
import { materialiseConfig } from "./config-store.js";
import * as logCore from "./log-core.js";

try {
  // Read straight from the env: `config.ts` (which validates CLAWS_ROLE) must
  // not load before the file exists. The web tier never creates the store.
  await materialiseConfig({ readOnly: (process.env["CLAWS_ROLE"] ?? "").trim() === "web" });
} catch (err) {
  logCore.error("[boot] Failed to materialise config from the database", err);
  process.exit(1);
}
await import("./main.js");
