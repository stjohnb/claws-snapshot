import { z } from "zod";

/**
 * Browser → server frames on a session terminal WebSocket. Pure (zod only) so
 * any process that serves or proxies a terminal can validate frames the same way.
 */
export const WsMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("input"), data: z.string() }),
  z.object({ type: z.literal("resize"), cols: z.number(), rows: z.number() }),
]);

export type WsMessage = z.infer<typeof WsMessageSchema>;

/** Clamp a client-requested terminal size to 1–500 columns × 1–200 rows. */
export function clampTerminalSize(cols: number, rows: number): { cols: number; rows: number } {
  return {
    cols: Math.max(1, Math.min(500, Math.floor(cols))),
    rows: Math.max(1, Math.min(200, Math.floor(rows))),
  };
}
