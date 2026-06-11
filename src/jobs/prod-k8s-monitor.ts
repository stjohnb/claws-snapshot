import {
  PROD_K8S_MONITOR_ENABLED,
  PROD_K8S_KUBECONFIG_PATH,
  PROD_K8S_IGNORED_NODES,
  PROD_K8S_REPO,
} from "../config.js";
import * as log from "../log.js";
import { runK8sMonitor, setDisabledStatus } from "./k3s-monitor.js";

export async function run(): Promise<void> {
  if (!PROD_K8S_MONITOR_ENABLED) {
    setDisabledStatus("prod-k8s-monitor", PROD_K8S_REPO, PROD_K8S_KUBECONFIG_PATH || undefined);
    log.info("[prod-k8s-monitor] Disabled — skipping");
    return;
  }
  await runK8sMonitor({
    repo: PROD_K8S_REPO,
    kubeconfigPath: PROD_K8S_KUBECONFIG_PATH,
    ignoredNodes: PROD_K8S_IGNORED_NODES,
    logPrefix: "prod-k8s-monitor",
    tailLines: 100,
  });
}
