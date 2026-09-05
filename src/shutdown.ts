let shuttingDown = false;
export function setShuttingDown(): void { shuttingDown = true; }
export function isShuttingDown(): boolean { return shuttingDown; }

export class ShutdownError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ShutdownError";
  }
}
