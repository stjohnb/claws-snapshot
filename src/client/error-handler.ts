// Captures runtime errors from any page and ships them to /api/client-error
// for server-side aggregation. Loaded in <head> via ERROR_HANDLER_SCRIPT so it
// is registered before page CDN scripts can throw. Wire format must match the
// /api/client-error handler in src/server.ts.
(() => {
  const reported: Record<string, true> = {};

  function report(
    fingerprint: string,
    message: string,
    stack: string,
    context: string,
  ): void {
    if (reported[fingerprint]) return;
    reported[fingerprint] = true;
    try {
      navigator.sendBeacon(
        "/api/client-error",
        JSON.stringify({
          fingerprint,
          message,
          stack: stack || "",
          context: context || window.location.pathname,
        }),
      );
    } catch {
      // Never let the error reporter throw — it would loop via window.onerror.
    }
  }

  window.addEventListener("error", (e: ErrorEvent) => {
    const fp =
      (e.filename || "") +
      ":" +
      e.lineno +
      ":" +
      e.colno +
      ":" +
      (e.message || "").slice(0, 80);
    const stack = e.error instanceof Error ? e.error.stack ?? "" : "";
    report(fp, e.message, stack, "window.onerror");
  });

  window.addEventListener("unhandledrejection", (e: PromiseRejectionEvent) => {
    const reason: unknown = e.reason;
    const msg = reason instanceof Error ? reason.message : String(reason);
    const stack = reason instanceof Error ? reason.stack ?? "" : "";
    report("unhandledrejection:" + msg.slice(0, 80), msg, stack, "unhandledrejection");
  });
})();
