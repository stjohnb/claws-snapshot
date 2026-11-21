export class RateLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RateLimitError";
  }
}

/** True for a {@link RateLimitError}, or any error whose message says the rate
 *  limit was exceeded (a wrapped or re-thrown failure). */
export function isRateLimitFailure(err: unknown): boolean {
  if (err instanceof RateLimitError) return true;
  return err instanceof Error && /rate limit exceeded/i.test(err.message);
}
