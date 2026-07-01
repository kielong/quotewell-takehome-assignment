// Orchestrator for the Email → AMS pipeline (PLAN §3, Phase 6).
//
// For every email in inbox/ (processed in deterministic filename order) we run
// the full chain — extract → parse → normalize → ground → validate → submit →
// confirm — and fold the outcome into a single per-email VERDICT. After the loop
// we reconcile our claimed verdicts against the AMS's own record list, write
// run-report.json, and print a console summary.
//
// The guiding invariant (README / PLAN §1): the run ALWAYS terminates with a
// verdict for every email. A record is either `confirmed` (exists in the AMS,
// GET-verified), deliberately `needs_review` (held — e.g. a required field the
// source doesn't support), or `failed` (with an actionable reason + last status).
// Nothing is ever silently lost.

import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  buildIdempotencyKey,
  listRecords,
  submitRecord,
} from "./amsClient.js";
import { extract, ExtractError } from "./extractClient.js";
import { groundRecord } from "./ground.js";
import { normalizeRecord } from "./normalize.js";
import { parseExtraction } from "./parse.js";
import {
  buildReport,
  printSummary,
  reconcile,
  writeReport,
  type Verdict,
} from "./report.js";
import { validateRecord } from "./validate.js";

const INBOX_DIR = new URL("../inbox/", import.meta.url);
const REPORT_URL = new URL("../run-report.json", import.meta.url);

// Overall wall-clock budget for the whole submission phase. Each record already
// has its own per-record budget + attempt cap (config.ts); this is a final
// backstop so even a pathological run can't hang forever. Recovery GETs inside
// submitRecord intentionally ignore this signal, so a record that persisted is
// still recovered after the budget fires.
const RUN_SUBMIT_BUDGET_MS = 5 * 60_000;

async function main(): Promise<void> {
  const emails = await loadInbox();
  if (emails.length === 0) {
    console.error(`No email_*.txt files found in ${fileURLToPath(INBOX_DIR)}`);
    process.exitCode = 1;
    return;
  }

  console.log(`Processing ${emails.length} email(s) from inbox…`);

  const runSignal = AbortSignal.timeout(RUN_SUBMIT_BUDGET_MS);
  const verdicts: Verdict[] = [];
  for (const email of emails) {
    console.log(`\n→ ${email.id}`);
    verdicts.push(await processEmail(email, runSignal));
  }

  // Reconcile against the AMS's authoritative list. Run without the run signal:
  // even if the budget fired mid-run, the list endpoint is reliable and we still
  // want a truthful end-of-run reconciliation.
  const list = await listRecords();
  const reconciliation = reconcile(verdicts, list);
  const report = buildReport(verdicts, reconciliation);

  await writeReport(report, fileURLToPath(REPORT_URL));
  printSummary(report, fileURLToPath(REPORT_URL));

  // Non-zero exit if anything failed or reconciliation didn't pass. A
  // needs_review (deliberate hold) is an expected, acceptable outcome.
  if (report.totals.failed > 0 || !reconciliation.pass) {
    process.exitCode = 1;
  }
}

interface InboxEmail {
  id: string;
  path: string;
  text: string;
}

// Read every inbox/email_*.txt, sorted by filename (numeric-aware so email_2
// sorts before email_10). Deterministic order keeps the run reproducible.
async function loadInbox(): Promise<InboxEmail[]> {
  let entries: string[];
  try {
    entries = await readdir(INBOX_DIR);
  } catch (err) {
    throw new Error(
      `could not read inbox at ${fileURLToPath(INBOX_DIR)}: ${(err as Error).message}`,
    );
  }

  const files = entries
    .filter((name) => /^email_.*\.txt$/i.test(name))
    .sort((a, b) => a.localeCompare(b, "en", { numeric: true }));

  const emails: InboxEmail[] = [];
  for (const name of files) {
    const url = new URL(name, INBOX_DIR);
    const text = await readFile(url, "utf8");
    emails.push({ id: name.replace(/\.txt$/i, ""), path: fileURLToPath(url), text });
  }
  return emails;
}

// Run the full per-email chain and produce its verdict. Each stage can short
// the record to a terminal verdict (failed / needs_review) before submission;
// only a fully grounded, schema-valid record is actually sent to the AMS.
async function processEmail(email: InboxEmail, runSignal: AbortSignal): Promise<Verdict> {
  // 1) Extract via the (reliable) extraction service. A transport/HTTP failure
  // here is a hard failure for this email — there's nothing to submit.
  let output: string;
  try {
    output = await extract(email.text);
  } catch (err) {
    const reason =
      err instanceof ExtractError ? err.message : `unexpected extraction error: ${String(err)}`;
    return baseVerdict(email, "failed", { reason });
  }

  // 2) Parse a JSON record out of the raw model text. No object (e.g. the
  // refusal string) → unparseable.
  const parsed = parseExtraction(output);
  if (!parsed.ok) {
    return baseVerdict(email, "failed", {
      reason: `unparseable_extraction: ${parsed.reason}`,
    });
  }

  // 3) Mechanical format normalization (state/LOB/date/currency/zip).
  const normalized = normalizeRecord(parsed.record);

  // 4) Source grounding vs. the email: corrections we apply (E2 revenue→null,
  // E3 PO-box override) and flags that force a hold (E4 unsupported date).
  const grounded = groundRecord(normalized, email.text);

  // A grounding flag means a required field is unsupported / a needed correction
  // couldn't be made safely → HOLD for human review; do not submit.
  if (grounded.flags.length > 0) {
    return baseVerdict(email, "needs_review", {
      corrections: grounded.corrections,
      flags: grounded.flags,
      reason: grounded.flags.map((f) => `${f.field}: ${f.reason}`).join("; "),
    });
  }

  // 5) Client-side validation mirroring the AMS schema. If we can't produce a
  // valid record, report it as failed with field-level reasons; never submit a
  // body we expect the server to 422.
  const validation = validateRecord(grounded.record);
  if (!validation.ok) {
    const reason = validation.errors.map((e) => `${e.field}: ${e.message}`).join("; ");
    return baseVerdict(email, "failed", {
      corrections: grounded.corrections,
      reason: `validation_failed: ${reason}`,
    });
  }

  // 6) Submit with the resilient AMS client: stable idempotency key, byte-stable
  // body, bounded retries/backoff, GET-confirm before claiming success.
  const idempotencyKey = buildIdempotencyKey(email.id);
  const result = await submitRecord(validation.record, idempotencyKey, { signal: runSignal });

  return {
    email: email.id,
    status: result.status === "confirmed" ? "confirmed" : "failed",
    recordId: result.recordId,
    attempts: result.attempts,
    lastHttpStatus: result.lastHttpStatus,
    corrections: grounded.corrections,
    flags: [],
    reason: result.reason,
    warnings: result.warnings,
  };
}

// Construct a verdict for a record that short-circuited before (or instead of)
// submission. Defaults cover the "no AMS call was made" case.
function baseVerdict(
  email: InboxEmail,
  status: Verdict["status"],
  fields: Partial<Pick<Verdict, "recordId" | "attempts" | "lastHttpStatus" | "corrections" | "flags" | "reason" | "warnings">>,
): Verdict {
  return {
    email: email.id,
    status,
    recordId: fields.recordId ?? null,
    attempts: fields.attempts ?? 0,
    lastHttpStatus: fields.lastHttpStatus ?? null,
    corrections: fields.corrections ?? [],
    flags: fields.flags ?? [],
    reason: fields.reason ?? null,
    warnings: fields.warnings ?? [],
  };
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
