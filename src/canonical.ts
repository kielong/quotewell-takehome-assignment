// Canonical JSON serialization: recursive, key-sorted, byte-stable.
//
// Why this matters: we need a stable string identity for a logical record so we
// can (a) dedup / reconcile by canonical body at end of run (the stub stores a
// literal echo `{recordId, ...body, receivedAt}` and does NOT store the
// Idempotency-Key, so dedup must be by body) and (b) hash a body for our own
// bookkeeping. The stub itself re-parses and re-canonicalizes the body
// server-side before hashing, so our wire-byte ordering does not affect the
// stub's per-attempt outcome — but matching its canonical form exactly keeps our
// hashes consistent with the stored rows and is the correct, defensive behavior
// against a real AMS that might hash the raw bytes.
//
// Use this for hashing / dedup ONLY. It intentionally mirrors the stub and so
// emits invalid JSON for `undefined` (e.g. `{"k":undefined}`); the actual
// request payload must be produced with `JSON.stringify` (see http.ts).

export function canonicalStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "undefined";
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalStringify).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const entries = Object.keys(obj)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalStringify(obj[key])}`);
  return `{${entries.join(",")}}`;
}
