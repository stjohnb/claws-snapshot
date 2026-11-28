// Ending a session from the browser: the sessions list's End control and the
// session page's chat view (#clw_01M7FCQ16J027F7RXC9YX5NYT6) share the same
// `POST /sessions/:id/kill` route. Ending asks for no confirmation
// (#clw_01M7JNKFA7NWKCJ8ZEE7VYE0J3).

/** `ended` on success, otherwise `{ error }` with the response text. */
export type EndSessionResult = "ended" | { error: string };

/**
 * POST `/sessions/<id>/kill`. The route redirects (303) to `/sessions`;
 * `fetch` follows it, so success is an ok final status and anything else is a
 * failure carrying the response text.
 */
export async function endSession(id: string): Promise<EndSessionResult> {
  const res = await fetch("/sessions/" + encodeURIComponent(id) + "/kill", { method: "POST" });
  if (!res.ok) return { error: await res.text() };
  return "ended";
}
