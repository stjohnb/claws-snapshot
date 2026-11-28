/** What a route registered by `registerRoutes` (src/server.ts) reads from `createServer`: the controller client, the process role, the controller URL and the proxy headers timeout. */
import type { ControllerClient } from "../../controller-client.js";
import type * as config from "../../config.js";

export interface RouteContext {
  controller: ControllerClient;
  role: config.ClawsRole;
  controllerUrl: string;
  proxyHeadersTimeoutMs: number;
}
