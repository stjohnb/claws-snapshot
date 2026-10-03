// Globals published by one client bundle and consumed by another.
declare global {
  interface Window {
    /** Installed by src/client/auth-watch.ts — probes /api/auth/status and
     *  triggers OIDC re-login if the session lapsed. Absent if that bundle
     *  did not run, so always call it optionally. */
    clawsAuthCheck?: () => void;
    /** Chart.js v4 UMD global, loaded from /static/chart.js (src/resources/chartjs.ts).
     *  Untyped: the library is vendored, not an npm dependency. Absent if that
     *  script did not load, so always guard before use. */
    // eslint-disable-next-line
    Chart?: any;
  }
}
export {};
