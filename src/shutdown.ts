let shuttingDown = false;
let startedAt: number | null = null;

/** Idempotent: repeat calls must not reset the recorded start time. */
export function setShuttingDown(): void {
  if (shuttingDown) return;
  shuttingDown = true;
  startedAt = Date.now();
}
export function isShuttingDown(): boolean { return shuttingDown; }
export function shutdownStartedAt(): number | null { return startedAt; }
export function shutdownElapsedMs(): number { return startedAt === null ? 0 : Date.now() - startedAt; }

export class ShutdownError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ShutdownError";
  }
}
