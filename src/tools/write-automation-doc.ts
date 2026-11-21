#!/usr/bin/env tsx
/**
 * Regenerate docs/claws-automation.md from CLAWS_AUTOMATION_DOC. Run
 * `npm run docs:automation` after editing the constant in
 * src/resources/claws-info.ts; claws-info.test.ts requires a byte match.
 *
 * Uses console.*, not src/log.ts: this is a developer tool, not the service.
 */
import fs from "node:fs";
import {
  CLAWS_AUTOMATION_DOC,
  CLAWS_AUTOMATION_DOC_PATH,
} from "../resources/claws-info.js";

const target = new URL(`../../${CLAWS_AUTOMATION_DOC_PATH}`, import.meta.url);
let current: string | null = null;
try {
  current = fs.readFileSync(target, "utf8");
} catch {
  current = null;
}
if (current === CLAWS_AUTOMATION_DOC) {
  console.log(`${CLAWS_AUTOMATION_DOC_PATH} already up to date`);
} else {
  fs.writeFileSync(target, CLAWS_AUTOMATION_DOC, "utf8");
  console.log(`wrote ${CLAWS_AUTOMATION_DOC_PATH}`);
}
process.exit(0);
