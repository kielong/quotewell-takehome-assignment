// Source grounding: validate the model's output against the SOURCE email, not
// just its own shape. This is the real test — the extraction model omits,
// invents, and contradicts the source in 3 of the 4 fixtures, and "what we
// submit is on us, not the model."
//
// Three explainable, per-field decisions (PLAN §4). Every change is recorded as
// a human-auditable {field, from, to, reason, evidence} so a reviewer can see
// exactly what we overrode and which email line justified it:
//
//   E2 (annualRevenue): the model asserts a number the email calls "TBD".
//        Revenue is nullable in the schema → force `null`, log the override.
//   E3 (mailingAddress): the model used the facility address despite an explicit
//        "mail goes to the PO box" instruction → parse the PO box from the email
//        and override. If the PO box can't be parsed, HOLD rather than submit the
//        wrong address.
//   E4 (effectiveDate): the model invented a date the email says is undecided.
//        effectiveDate is REQUIRED and non-nullable → we must not fabricate it;
//        flag/hold for human review instead of submitting.
//
// We deliberately do lightweight phrase grounding (a short "unsupported value"
// signal list co-occurring with the field's topic in the same sentence) rather
// than a second LLM pass — explainable and cheap. NOTES.md calls out that full
// generality would want a grounding/confidence model. We never fabricate a
// required field; for those we hold.

import { normalizeState, normalizeZip } from "./normalize.js";

// A change we MADE to the record, with the email line that justifies it.
export interface Correction {
  field: string;
  from: unknown;
  to: unknown;
  reason: string;
  evidence: string;
}

// A reason to HOLD the record (do not submit) for human review. Produced when a
// required field is unsupported (E4) or a correction we must make can't be made
// safely (E3 fallback). Presence of any flag → the pipeline yields needs_review.
export interface Flag {
  field: string;
  reason: string;
  evidence: string;
}

export interface GroundResult {
  record: Record<string, unknown>;
  corrections: Correction[];
  flags: Flag[];
}

// "Unsupported value" signal phrases: when one of these co-occurs with a field's
// topic in the same sentence, a concrete value the model emitted for that field
// is treated as unsupported by the source. Tested against lowercased text;
// apostrophe variants (' / ’) and "n't"/" not" forms are both covered.
const UNSUPPORTED_SIGNALS: RegExp[] = [
  /\btbd\b/,
  /to be determined/,
  /do(?:n['’]?t| not) have/,
  /has(?:n['’]?t| not) locked/,
  /not locked in/,
  /locked it in( yet)?/,
  /once\b[^.!?]*\bconfirm/,
  /deciding between/,
  /\bundecided\b/,
  /not (?:yet )?(?:decided|determined|confirmed|sure)/,
];

const EVIDENCE_MAX = 300;

export function groundRecord(
  record: Record<string, unknown>,
  emailText: string,
): GroundResult {
  const out: Record<string, unknown> = { ...record };
  const corrections: Correction[] = [];
  const flags: Flag[] = [];

  groundRevenue(out, emailText, corrections);
  groundMailingAddress(out, emailText, corrections, flags);
  groundEffectiveDate(out, emailText, flags);

  return { record: out, corrections, flags };
}

// E2 — revenue asserted by the model but called "TBD"/unavailable in the email.
// Revenue is nullable, so we can correct it: force null and log the override.
// Only fires when the model actually emitted a concrete number (nothing to
// override otherwise).
function groundRevenue(
  out: Record<string, unknown>,
  emailText: string,
  corrections: Correction[],
): void {
  if (typeof out.annualRevenue !== "number") return;

  const evidence = findUnsupportedEvidence(emailText, ["revenue", "financ"]);
  if (evidence === null) return;

  corrections.push({
    field: "annualRevenue",
    from: out.annualRevenue,
    to: null,
    reason: "email states revenue is unavailable/TBD; do not guess a value",
    evidence,
  });
  out.annualRevenue = null;
}

// E4 — effectiveDate asserted by the model but the email says it's undecided.
// effectiveDate is REQUIRED and the schema allows no null, so we cannot honestly
// fill it. Flag/hold for human review rather than fabricating a date. We leave
// the value in place (for the reviewer to see what the model guessed) but the
// flag makes the pipeline skip submission.
function groundEffectiveDate(
  out: Record<string, unknown>,
  emailText: string,
  flags: Flag[],
): void {
  if (typeof out.effectiveDate !== "string" || out.effectiveDate.trim() === "") {
    return;
  }

  const evidence = findUnsupportedEvidence(emailText, ["effective date", "effective"]);
  if (evidence === null) return;

  flags.push({
    field: "effectiveDate",
    reason: "effectiveDate not stated in source; required field cannot be fabricated",
    evidence,
  });
}

// E3 — the email explicitly instructs that the mailing address is a PO box, but
// the model used the facility address. Parse the PO box from the email and
// override. If the instruction is present but the PO-box address can't be
// parsed, HOLD (needs_review) rather than submit the wrong (facility) address.
function groundMailingAddress(
  out: Record<string, unknown>,
  emailText: string,
  corrections: Correction[],
  flags: Flag[],
): void {
  const lower = emailText.toLowerCase();
  const hasPoBox = /\bp\.?\s*o\.?\s*box\b/.test(lower);
  const hasMailingContext = /\bmail(?:ing)?\b/.test(lower);
  if (!hasPoBox || !hasMailingContext) return;

  const evidence =
    findSentenceContaining(emailText, "po box") ?? findSentenceContaining(emailText, "p.o");

  const parsed = parsePoBoxAddress(emailText);
  if (parsed === null) {
    flags.push({
      field: "mailingAddress",
      reason:
        "email instructs the mailing address is a PO box, but the PO-box address could not be parsed",
      evidence: evidence ?? "(PO box instruction detected; address unparseable)",
    });
    return;
  }

  const before = formatAddress(out.mailingAddress);
  const after = formatAddress(parsed);
  if (before === after) return; // model already used the PO box; nothing to do.

  corrections.push({
    field: "mailingAddress",
    from: before,
    to: after,
    reason: "email instructs the mailing address must be the PO box, not the facility",
    evidence: evidence ?? after,
  });
  out.mailingAddress = parsed;
}

interface Address {
  street: string;
  city: string;
  state: string;
  zip: string;
}

// Parse a "PO Box <n>, City, ST 12345" address out of arbitrary email text.
// State/zip are run back through the shared normalizers so a full state name or
// odd zip formatting still lands as the validator expects.
function parsePoBoxAddress(text: string): Address | null {
  const m = text.match(
    /\bp\.?\s*o\.?\s*box\s+(\d+)\s*,\s*([^,]+?)\s*,\s*([A-Za-z][A-Za-z. ]*?)\s+(\d{5})(?:-\d{4})?\b/i,
  );
  if (!m) return null;
  const [, box, city, stateRaw, zipRaw] = m;
  if (box === undefined || city === undefined || stateRaw === undefined || zipRaw === undefined) {
    return null;
  }

  const state = normalizeState(stateRaw.trim());
  const zip = normalizeZip(zipRaw);
  if (typeof state !== "string" || typeof zip !== "string") return null;

  return {
    street: `PO Box ${box}`,
    city: city.trim(),
    state,
    zip,
  };
}

// Compact, human-readable address for correction logs ("from"/"to").
function formatAddress(value: unknown): string {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return JSON.stringify(value ?? null);
  }
  const a = value as Record<string, unknown>;
  const parts = [a.street, a.city].filter((p) => typeof p === "string" && p.trim() !== "");
  const tail = [a.state, a.zip].filter((p) => typeof p === "string" && p.trim() !== "").join(" ");
  if (tail !== "") parts.push(tail);
  return parts.length > 0 ? parts.join(", ") : JSON.stringify(a);
}

// Return a sentence where a field topic co-occurs with an "unsupported value"
// signal, or null. Same-sentence co-occurrence keeps the match tight (avoids
// flagging an unrelated "TBD" elsewhere in the thread). `topics` are tried in
// priority order so the most on-point evidence is preferred (e.g. the sentence
// naming "revenue" over a looser "financials" mention).
function findUnsupportedEvidence(text: string, topics: string[]): string | null {
  const sentences = splitSentences(text);
  for (const topic of topics) {
    for (const sentence of sentences) {
      const lower = sentence.toLowerCase();
      if (lower.includes(topic) && UNSUPPORTED_SIGNALS.some((re) => re.test(lower))) {
        return clip(sentence);
      }
    }
  }
  return null;
}

function findSentenceContaining(text: string, needle: string): string | null {
  const lowerNeedle = needle.toLowerCase();
  for (const sentence of splitSentences(text)) {
    if (sentence.toLowerCase().includes(lowerNeedle)) return clip(sentence);
  }
  return null;
}

// Collapse whitespace (emails are hard-wrapped) and split into sentences. Good
// enough for grounding evidence; we don't need linguistic precision.
function splitSentences(text: string): string[] {
  return text
    .replace(/\s+/g, " ")
    .trim()
    .split(/(?<=[.!?])\s+/)
    .filter((s) => s.length > 0);
}

function clip(s: string): string {
  return s.length > EVIDENCE_MAX ? `${s.slice(0, EVIDENCE_MAX - 1)}…` : s;
}
