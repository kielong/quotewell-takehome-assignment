// Pull a JSON record out of the extraction model's raw text output.
//
// The model returns arbitrary prose: one fixture wraps the JSON in a chatty
// sentence plus a ```json markdown fence, others are bare JSON, and an
// unrecognized email yields a plain-English refusal with no JSON at all. We
// can't trust the envelope, so we scan for the first balanced `{…}` object and
// JSON.parse it. We deliberately do NOT special-case the fence: a fence's
// backticks live outside the braces, so brace-balancing handles fenced, bare,
// and prose-wrapped output uniformly.
//
// Returns a result object rather than throwing so the pipeline can map a
// no-JSON output (the refusal string) to a `failed: unparseable_extraction`
// verdict without exception plumbing.

export interface ParseSuccess {
  ok: true;
  record: Record<string, unknown>;
}

export interface ParseFailure {
  ok: false;
  reason: string;
}

export type ParseResult = ParseSuccess | ParseFailure;

export function parseExtraction(raw: string): ParseResult {
  for (const candidate of jsonObjectCandidates(raw)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      // Not valid JSON (e.g. a truncated/garbage brace run) — try the next `{`.
      continue;
    }
    if (isPlainObject(parsed)) {
      return { ok: true, record: parsed };
    }
    // A bare array/number/string isn't a record; keep scanning for an object.
  }
  return { ok: false, reason: "no_json_object_found" };
}

// Yields every balanced `{…}` substring, in source order, starting at each `{`.
// The first one that parses to an object is the record; later starts are tried
// only if earlier ones fail to parse.
function* jsonObjectCandidates(text: string): Generator<string> {
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== "{") continue;
    const end = matchBalancedObject(text, i);
    if (end !== -1) yield text.slice(i, end + 1);
  }
}

// Given a `{` at `start`, return the index of its matching `}` (accounting for
// nesting and brace characters inside string literals), or -1 if unbalanced.
function matchBalancedObject(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === "{") {
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
