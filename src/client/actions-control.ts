// Forgejo Actions controls on the dashboard (#clw_01M7X2XQESHRXWHA4Z59EXWT7Y):
// the repo page's CI queue Cancel buttons, its Workflows list and the
// disabled-workflow banner's Disable / Enable buttons (src/pages/repo.ts).
// Endpoints and their JSON shapes are parsed by src/server.ts — keep in sync:
//   POST /queue/cancel-run       {repo, run}               → {ok, cancelled, already_finished, failed} | {error}
//   POST /queue/workflow-enabled {repo, workflow, enabled} → {ok, workflow, enabled, disabled_workflows} | {error}
// Each button carries `data-actions-control` ("cancel-run" or "workflow") and
// its parameters as data attributes; a click is handled by delegation, so
// re-rendered markup needs no re-binding.

interface CancelResult {
  error?: string;
  cancelled?: unknown[];
  already_finished?: unknown[];
  failed?: Array<{ error?: string }>;
}

/** Show `message` in the nearest `.actions-control-status` line, or clear it. */
function showStatus(btn: HTMLElement, message: string | null): void {
  const scope = btn.closest("[data-actions-control-scope]");
  const status = scope?.querySelector<HTMLElement>(".actions-control-status");
  if (!status) return;
  status.textContent = message ?? "";
  status.hidden = message === null;
}

async function post(url: string, body: unknown): Promise<CancelResult> {
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return (await r.json()) as CancelResult;
}

function fail(btn: HTMLButtonElement, original: string, message: string): void {
  btn.textContent = "Error";
  showStatus(btn, message);
  setTimeout(() => {
    btn.textContent = original;
    btn.disabled = false;
    btn.removeAttribute("aria-busy");
    btn.style.minWidth = "";
  }, 3000);
}

async function cancelRun(btn: HTMLButtonElement): Promise<void> {
  const repo = btn.dataset.repo ?? "";
  const run = Number(btn.dataset.run);
  if (!window.confirm(`Cancel run ${run} on ${repo}?`)) return;
  const original = btn.textContent ?? "Cancel";
  start(btn, "Cancelling…");
  try {
    const data = await post("/queue/cancel-run", { repo, run });
    if (data.error) return fail(btn, original, data.error);
    if (data.failed && data.failed.length > 0) return fail(btn, original, data.failed[0]?.error ?? "Cancel failed");
    btn.textContent = (data.cancelled?.length ?? 0) > 0 ? "Cancelled" : "Already finished";
    btn.removeAttribute("aria-busy");
    showStatus(btn, null);
  } catch (err) {
    fail(btn, original, err instanceof Error ? err.message : String(err));
  }
}

async function toggleWorkflow(btn: HTMLButtonElement): Promise<void> {
  const repo = btn.dataset.repo ?? "";
  const workflow = btn.dataset.workflow ?? "";
  const enabled = btn.dataset.enabled === "true";
  const verb = enabled ? "Enable" : "Disable";
  if (!window.confirm(`${verb} workflow ${workflow} on ${repo}?`)) return;
  const original = btn.textContent ?? verb;
  start(btn, enabled ? "Enabling…" : "Disabling…");
  try {
    const data = await post("/queue/workflow-enabled", { repo, workflow, enabled });
    if (data.error) return fail(btn, original, data.error);
    window.location.reload();
  } catch (err) {
    fail(btn, original, err instanceof Error ? err.message : String(err));
  }
}

/** Hold the button's width and mark it busy while its request runs. */
function start(btn: HTMLButtonElement, label: string): void {
  btn.style.minWidth = `${btn.getBoundingClientRect().width}px`;
  btn.disabled = true;
  btn.setAttribute("aria-busy", "true");
  btn.textContent = label;
}

document.addEventListener("click", (ev) => {
  const btn = (ev.target as Element | null)?.closest<HTMLButtonElement>("button[data-actions-control]");
  if (!btn || btn.disabled) return;
  ev.preventDefault();
  if (btn.dataset.actionsControl === "cancel-run") void cancelRun(btn);
  else if (btn.dataset.actionsControl === "workflow") void toggleWorkflow(btn);
});
