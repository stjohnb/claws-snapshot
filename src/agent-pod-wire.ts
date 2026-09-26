// JSON encoding for the agent-pod ops API (`POST /agent-pods/:rowId/ops/:op`):
// both ends serialise args and results with it, so the few `db.ts` functions
// that take a `Date`, return a `Map`, or take an `undefined` argument before a
// defaulted one survive the round trip. Pure — imported by the pod's
// `db-remote.ts`, so it must not import `db.js` or anything that does.

const TAG = "__clawsWire";

interface Tagged {
  [TAG]: "map" | "date" | "undefined";
  v?: unknown;
}

function isTagged(value: unknown): value is Tagged {
  return typeof value === "object" && value !== null && TAG in value && Object.keys(value).length <= 2;
}

/** `JSON.stringify` that keeps `Map`, `Date` and `undefined` array elements. */
export function encodeWire(value: unknown): string {
  return JSON.stringify(value, function (this: Record<string, unknown>, key, v: unknown) {
    // `Date#toJSON` has already run by the time the replacer sees `v`; the holder still has the Date.
    const raw = this[key];
    if (raw instanceof Date) return { [TAG]: "date", v: raw.toISOString() };
    if (v instanceof Map) return { [TAG]: "map", v: [...v.entries()] };
    if (v === undefined && Array.isArray(this)) return { [TAG]: "undefined" };
    return v;
  });
}

/** The inverse of {@link encodeWire}. */
export function decodeWire(text: string): unknown {
  return JSON.parse(text, (_key, v: unknown) => {
    if (!isTagged(v)) return v;
    switch (v[TAG]) {
      case "date": return new Date(String(v.v));
      case "map": return new Map(v.v as Array<[unknown, unknown]>);
      case "undefined": return undefined;
      default: return v;
    }
  });
}
