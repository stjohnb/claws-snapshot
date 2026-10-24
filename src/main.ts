/**
 * Role dispatcher (#clw_01M5APX7YF3AGWHV1S1WMHJDR6). `CLAWS_ROLE` `all` (the
 * default, one process doing everything) and `controller` run
 * `main-controller.ts`: the scheduler, work queue, WhatsApp gateway, session
 * timers and migrations, plus the dashboard. `web` runs `main-web.ts`: the
 * dashboard, API and session pages only, with no persistent state of its own.
 * See docs/k8s-cutover.md "Web/controller split".
 */
import { CLAWS_ROLE } from "./config.js";
import * as log from "./log.js";
import { VERSION } from "./version.js";

log.info(`claws ${VERSION} starting up (role ${CLAWS_ROLE})`);

if (CLAWS_ROLE === "web") {
  const { startWeb } = await import("./main-web.js");
  await startWeb();
} else {
  await import("./main-controller.js");
}
