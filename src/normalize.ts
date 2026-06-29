// Mechanical format normalization: turn the model's loose values into the exact
// shapes the AMS validator (RESEARCH §7) requires, without changing meaning.
//
// Scope is intentionally narrow — this layer ONLY reshapes formats it recognizes
// (state codes, the LOB enum, dates, currency, zip). It is deliberately NOT the
// place for source-grounding decisions (E2 revenue→null, E3 PO-box override, E4
// hold) — that is Phase 3 (ground.ts). Each normalizer is total and defensive:
// if a value isn't in a shape it understands, it is returned UNCHANGED so the
// client-side validator (Phase 4) can flag it, rather than guessing and hiding a
// real problem.

// Full state/territory names + common AP-style abbreviations → 2-letter USPS.
// Keys are normalized (lowercased, periods/extra spaces stripped) before lookup,
// so "Tex.", "tex", and "Texas" all resolve to "TX".
const STATE_CODES = [
  "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "FL", "GA",
  "HI", "ID", "IL", "IN", "IA", "KS", "KY", "LA", "ME", "MD",
  "MA", "MI", "MN", "MS", "MO", "MT", "NE", "NV", "NH", "NJ",
  "NM", "NY", "NC", "ND", "OH", "OK", "OR", "PA", "RI", "SC",
  "SD", "TN", "TX", "UT", "VT", "VA", "WA", "WV", "WI", "WY", "DC",
] as const;

const STATE_NAMES: Record<string, string> = {
  alabama: "AL", alaska: "AK", arizona: "AZ", arkansas: "AR",
  california: "CA", colorado: "CO", connecticut: "CT", delaware: "DE",
  florida: "FL", georgia: "GA", hawaii: "HI", idaho: "ID", illinois: "IL",
  indiana: "IN", iowa: "IA", kansas: "KS", kentucky: "KY", louisiana: "LA",
  maine: "ME", maryland: "MD", massachusetts: "MA", michigan: "MI",
  minnesota: "MN", mississippi: "MS", missouri: "MO", montana: "MT",
  nebraska: "NE", nevada: "NV", "new hampshire": "NH", "new jersey": "NJ",
  "new mexico": "NM", "new york": "NY", "north carolina": "NC",
  "north dakota": "ND", ohio: "OH", oklahoma: "OK", oregon: "OR",
  pennsylvania: "PA", "rhode island": "RI", "south carolina": "SC",
  "south dakota": "SD", tennessee: "TN", texas: "TX", utah: "UT",
  vermont: "VT", virginia: "VA", washington: "WA", "west virginia": "WV",
  wisconsin: "WI", wyoming: "WY", "district of columbia": "DC",
};

// Common newspaper/abbreviated forms (after period/space stripping) → USPS.
const STATE_ABBREVS: Record<string, string> = {
  ala: "AL", ariz: "AZ", ark: "AR", calif: "CA", cal: "CA", colo: "CO",
  conn: "CT", del: "DE", fla: "FL", flor: "FL", ill: "IL", ind: "IN",
  kan: "KS", kans: "KS", ken: "KY", la: "LA", mass: "MA", mich: "MI",
  minn: "MN", miss: "MS", mont: "MT", neb: "NE", nebr: "NE", nev: "NV",
  okla: "OK", ore: "OR", oreg: "OR", penn: "PA", penna: "PA", tenn: "TN",
  tex: "TX", wash: "WA", wis: "WI", wisc: "WI", wyo: "WY",
};

const STATE_LOOKUP: Record<string, string> = (() => {
  const map: Record<string, string> = {};
  for (const code of STATE_CODES) map[code.toLowerCase()] = code;
  for (const [name, code] of Object.entries(STATE_NAMES)) map[name] = code;
  for (const [abbrev, code] of Object.entries(STATE_ABBREVS)) map[abbrev] = code;
  return map;
})();

export function normalizeState(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const key = value.toLowerCase().replace(/\./g, "").replace(/\s+/g, " ").trim();
  return STATE_LOOKUP[key] ?? value;
}

// lineOfBusiness → enum slug: lowercase, spaces/hyphens collapsed to "_".
// ("general liability" → "general_liability"; already-slugged values pass
// through). Enum membership itself is checked later by the validator.
export function normalizeLineOfBusiness(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const slug = value.trim().toLowerCase().replace(/[\s-]+/g, "_");
  return slug === "" ? value : slug;
}

// effectiveDate → "YYYY-MM-DD". Handles already-ISO input, plus slash/dot/dash
// separated US-style M/D/Y(Y) and MM/DD/YYYY. 2-digit years map to 20YY.
export function normalizeEffectiveDate(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const s = value.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;

  const m = s.match(/^(\d{1,4})[/.-](\d{1,2})[/.-](\d{1,4})$/);
  if (!m) return value;
  const [, first, second, third] = m;
  if (first === undefined || second === undefined || third === undefined) {
    return value;
  }

  // Year-first (rare, e.g. "2026.07.01") vs the common month-first US form.
  let year: string;
  let month: string;
  let day: string;
  if (first.length === 4) {
    year = first;
    month = second;
    day = third;
  } else {
    month = first;
    day = second;
    year = third;
  }

  if (year.length === 2) year = `20${year}`;
  if (year.length !== 4) return value;

  return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
}

// annualRevenue currency string → number. Strips "$" and commas, expands a
// trailing K/M/B magnitude suffix ("$4.2M" → 4200000). Numbers pass through;
// note this does NOT invent a value — unsupported revenue is nulled in Phase 3.
// The result is rounded to whole dollars: `base * multiplier` is not exact in
// IEEE-754 for many decimals (e.g. "$1.005M" → 1004999.9999999999), and revenue
// is tracked as integer USD, so we round rather than persist a float artifact.
export function normalizeAnnualRevenue(value: unknown): unknown {
  if (typeof value === "number") return value;
  if (typeof value !== "string") return value;

  const m = value.trim().match(/^\$?\s*([\d,]*\.?\d+)\s*([kmb])?$/i);
  if (!m) return value;
  const digits = m[1];
  if (digits === undefined) return value;

  const base = Number(digits.replace(/,/g, ""));
  if (!Number.isFinite(base)) return value;

  const suffix = m[2]?.toLowerCase();
  const multiplier =
    suffix === "k" ? 1e3 : suffix === "m" ? 1e6 : suffix === "b" ? 1e9 : 1;
  return Math.round(base * multiplier);
}

// zip → 5-digit string. Coerces numbers (restoring leading zeros), and trims
// ZIP+4 to its first 5 digits. The validator requires typeof === "string".
export function normalizeZip(value: unknown): unknown {
  let digits: string;
  if (typeof value === "number" && Number.isFinite(value)) {
    digits = String(Math.trunc(Math.abs(value)));
  } else if (typeof value === "string") {
    const m = value.match(/\d+/);
    if (!m) return value;
    digits = m[0];
  } else {
    return value;
  }

  if (digits.length > 5) digits = digits.slice(0, 5);
  return digits.padStart(5, "0");
}

// Apply all field normalizers to a parsed record, returning a new object
// (input is not mutated). Unknown/extra fields are preserved untouched.
export function normalizeRecord(
  record: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...record };

  if ("lineOfBusiness" in out) {
    out.lineOfBusiness = normalizeLineOfBusiness(out.lineOfBusiness);
  }
  if ("effectiveDate" in out) {
    out.effectiveDate = normalizeEffectiveDate(out.effectiveDate);
  }
  if ("annualRevenue" in out) {
    out.annualRevenue = normalizeAnnualRevenue(out.annualRevenue);
  }

  const address = out.mailingAddress;
  if (address !== null && typeof address === "object" && !Array.isArray(address)) {
    const addr: Record<string, unknown> = { ...(address as Record<string, unknown>) };
    if ("state" in addr) addr.state = normalizeState(addr.state);
    if ("zip" in addr) addr.zip = normalizeZip(addr.zip);
    out.mailingAddress = addr;
  }

  return out;
}
