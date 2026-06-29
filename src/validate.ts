// Client-side validation: a faithful mirror of the AMS server's own validator
// (RESEARCH §7, stub `ur()`). Running this BEFORE submitting lets us catch a bad
// record locally, attach field-level reasons to the verdict, and skip wasting
// AMS attempts — for a valid body the server's 422 path should then never fire.
//
// This is deliberately an INDEPENDENT copy of the schema (its own USPS set, LOB
// enum, and regexes) rather than reusing the normalizer's tables: it is the
// client-side contract against the AMS, so it must assert the AMS's rules in
// their own right, not whatever the normalizer happens to recognize.
//
// The checks mirror the stub field-for-field, including its quirks:
//   - `dba` is the only omittable field (undefined | null | string all pass).
//   - `annualRevenue` must be PRESENT as a number or explicit null — a missing
//     key (undefined) fails, so E2/E4 must send `annualRevenue: null`, not drop
//     it (RESEARCH §7).
//   - if `mailingAddress` isn't an object, only that single error is reported
//     (the street/city/state/zip sub-checks are skipped), matching `ur()`.

// 50 states + DC, the exact USPS set the AMS accepts (stub `lr`).
const USPS_STATES: ReadonlySet<string> = new Set(
  "AL AK AZ AR CA CO CT DE FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY DC".split(
    " ",
  ),
);

// Allowed lineOfBusiness enum (stub `yt`).
const LINES_OF_BUSINESS: ReadonlySet<string> = new Set([
  "general_liability",
  "commercial_property",
  "workers_compensation",
  "commercial_auto",
  "bop",
]);

const ZIP_RE = /^\d{5}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// The shape the AMS accepts. `validate` narrows an arbitrary record to this on
// success so downstream code (the AMS client) gets a typed, submittable body.
export interface ValidatedRecord {
  insuredName: string;
  dba?: string | null;
  mailingAddress: {
    street: string;
    city: string;
    state: string;
    zip: string;
  };
  lineOfBusiness: string;
  effectiveDate: string;
  annualRevenue: number | null;
  contactEmail: string;
}

// One failed schema rule, keyed by field for the human-readable verdict report.
export interface ValidationError {
  field: string;
  message: string;
}

export type ValidationResult =
  | { ok: true; record: ValidatedRecord }
  | { ok: false; errors: ValidationError[] };

// Mirrors the stub's `s = n => typeof n == "string" && n.trim().length > 0`.
function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function validateRecord(record: Record<string, unknown>): ValidationResult {
  const errors: ValidationError[] = [];

  if (!isNonEmptyString(record.insuredName)) {
    errors.push({ field: "insuredName", message: "required non-empty string" });
  }

  // dba is the only omittable field: undefined or null or string are all fine.
  if (record.dba !== undefined && record.dba !== null && typeof record.dba !== "string") {
    errors.push({ field: "dba", message: "must be a string or null" });
  }

  validateMailingAddress(record.mailingAddress, errors);

  if (!isNonEmptyString(record.lineOfBusiness) || !LINES_OF_BUSINESS.has(record.lineOfBusiness)) {
    errors.push({
      field: "lineOfBusiness",
      message: `must be one of ${[...LINES_OF_BUSINESS].join(", ")}`,
    });
  }

  if (!isNonEmptyString(record.effectiveDate) || !DATE_RE.test(record.effectiveDate)) {
    errors.push({ field: "effectiveDate", message: "required date string YYYY-MM-DD" });
  }

  // Must be present and either a number or explicit null; a missing key fails
  // (mirrors the stub — omitting it is not allowed).
  if (record.annualRevenue !== null && typeof record.annualRevenue !== "number") {
    errors.push({
      field: "annualRevenue",
      message: "must be a number (USD) or null if unknown (must not be omitted)",
    });
  }

  if (!isNonEmptyString(record.contactEmail) || !EMAIL_RE.test(record.contactEmail)) {
    errors.push({ field: "contactEmail", message: "required valid email address" });
  }

  if (errors.length > 0) return { ok: false, errors };
  // All rules passed, so the record conforms to ValidatedRecord.
  return { ok: true, record: record as unknown as ValidatedRecord };
}

// If mailingAddress isn't an object, report only that (sub-checks skipped),
// matching the stub's single-error early branch. We mirror `ur()` exactly:
// its guard is `!r || typeof r != "object"`, so an *array* (typeof "object",
// not null) is treated as an object and falls through to the sub-checks — which
// then fail on the missing street/city/state/zip. We intentionally do NOT
// special-case arrays, to stay byte-for-byte faithful to the server's behavior.
function validateMailingAddress(value: unknown, errors: ValidationError[]): void {
  if (value === null || typeof value !== "object") {
    errors.push({
      field: "mailingAddress",
      message: "required object { street, city, state, zip }",
    });
    return;
  }

  const addr = value as Record<string, unknown>;

  if (!isNonEmptyString(addr.street)) {
    errors.push({ field: "mailingAddress.street", message: "required non-empty string" });
  }
  if (!isNonEmptyString(addr.city)) {
    errors.push({ field: "mailingAddress.city", message: "required non-empty string" });
  }
  if (!isNonEmptyString(addr.state) || !USPS_STATES.has(addr.state)) {
    errors.push({
      field: "mailingAddress.state",
      message: 'required 2-letter USPS code (e.g. "TX")',
    });
  }
  if (!isNonEmptyString(addr.zip) || !ZIP_RE.test(addr.zip)) {
    errors.push({ field: "mailingAddress.zip", message: "required 5-digit string" });
  }
}
