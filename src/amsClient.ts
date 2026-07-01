// Resilient AMS submission — the core of the exercise.
//
// The AMS is hostile by design (RESEARCH §4): a 200 can be fake, a 503/timeout
// may have already persisted, and EVERY record is guaranteed at least one
// persist-then-503 ("F") before it can ever return a 201. So two invariants
// drive this module:
//
//   1. Truth = GET. A 2xx body is never trusted on its own; an id-bearing
//      success is only "confirmed" once GET /records/:id shows the record
//      exists. A 503/timeout is never treated as a failed write.
//   2. Stable identity across retries. We POST the SAME object every attempt
//      (byte-stable body) under ONE stable Idempotency-Key, so the stub's
//      per-(body,attempt) outcome sequence behaves and its key-based dedup
//      collapses the 503-F + 201 pair into a single stored record (no dupes).
//
// Classification per attempt (PLAN §5):
//   201 + plausible string recordId  → GET-confirm → confirmed
//   200                              → trust ONLY if plausible recordId AND
//                                      GET-confirm; else transient → retry
//   429                              → honor Retry-After (sec) + jitter, retry
//   503 / timeout / network          → backoff + full jitter, retry (NO GET-by-id:
//                                      the 503-F body carries no recordId)
//   422 / 400                        → non-retryable; stop + flag (a valid body
//                                      never 422s and an invalid one never persists,
//                                      so no recovery is needed)
//
// Bounds: AMS_MAX_ATTEMPTS + a wall-clock budget so the run always terminates.
// On exhaustion we do NOT give up blindly — a record may have persisted on a
// 503-F we never saw confirmed. Because that response has no recordId, the only
// way to recover it is GET /api/v1/records (the list) matched by canonical body.

import {
  AMS_ATTEMPT_TIMEOUT_MS,
  AMS_BACKOFF_BASE_MS,
  AMS_BACKOFF_CAP_MS,
  AMS_GET_TIMEOUT_MS,
  AMS_MAX_ATTEMPTS,
  AMS_RETRY_AFTER_JITTER_MS,
  AMS_SUBMIT_BUDGET_MS,
} from "./config.js";
import { canonicalStringify } from "./canonical.js";
import { httpRequest } from "./http.js";
import type { ValidatedRecord } from "./validate.js";

// Outcome of submitting one logical record. `status` is the submission verdict;
// the pipeline (Phase 6) folds this into the per-email report alongside the
// grounding corrections/flags.
export interface SubmissionResult {
  status: "confirmed" | "failed";
  recordId: string | null;
  // POST attempts actually made (each advances the stub's outcome sequence).
  attempts: number;
  // Last HTTP status observed, or null if only transport failures occurred.
  lastHttpStatus: number | null;
  // Populated when status === "failed": a human-actionable reason.
  reason: string | null;
  // Non-fatal notes: list-based recovery, or a defensive stored-vs-sent diff
  // (the latter never fires against this echo-only stub, but is cheap insurance).
  warnings: string[];
}

// A record as stored/echoed by the AMS: { recordId, ...submittedBody, receivedAt }.
export interface StoredRecord {
  recordId: string;
  receivedAt?: string;
  [key: string]: unknown;
}

export interface RecordsList {
  count: number;
  records: StoredRecord[];
}

// Stable, debuggable key derived from the email's identity — ONE key per logical
// record, reused on every retry (Stripe/IETF idempotency guidance). Must never be
// a fresh UUID per attempt: that would defeat the stub's dedup and create a
// duplicate row each time a retry reaches the success branch (RESEARCH §5).
export function buildIdempotencyKey(emailId: string): string {
  return `qw-takehome:${emailId}`;
}

// Canonical body of a stored record with the server-added fields removed, so it
// can be matched byte-for-byte against canonicalStringify(submittedRecord). Used
// both for end-of-run list recovery and the defensive diff. Exported for Phase 6
// reconciliation (dedup by canonical body — the key isn't stored on the record).
export function storedRecordCanonicalBody(stored: StoredRecord): string {
  const { recordId: _recordId, receivedAt: _receivedAt, ...body } = stored;
  return canonicalStringify(body);
}

export async function submitRecord(
  record: ValidatedRecord,
  idempotencyKey: string,
  opts: { signal?: AbortSignal } = {},
): Promise<SubmissionResult> {
  const { signal } = opts;
  // Built ONCE and reused: the same object is posted every attempt (byte-stable
  // body) and the same canonical string is used for list-recovery / diffing.
  const canonicalBody = canonicalStringify(record);
  const warnings: string[] = [];
  const deadline = Date.now() + AMS_SUBMIT_BUDGET_MS;

  let attempts = 0;
  let lastHttpStatus: number | null = null;
  // Counts only backoff-eligible failures, so 429s (which honor Retry-After)
  // don't inflate the 503/timeout exponential backoff.
  let backoffN = 0;
  // Why the retry loop ended, for the final failure reason if unrecovered.
  let exitReason = "exhausted retries";

  while (attempts < AMS_MAX_ATTEMPTS) {
    if (signal?.aborted) {
      exitReason = "submission aborted (run budget exhausted)";
      break;
    }
    if (Date.now() >= deadline) {
      exitReason = "per-record wall-clock budget exhausted";
      break;
    }

    attempts++;
    const outcome = await httpRequest({
      method: "POST",
      path: "/api/v1/records",
      body: record,
      headers: { "Idempotency-Key": idempotencyKey },
      timeoutMs: AMS_ATTEMPT_TIMEOUT_MS,
      ...(signal ? { signal } : {}),
    });

    // Transport-level failures: timeout (escaped the 30s hang), external abort,
    // or network error. A timeout/network error is transient — backoff + retry.
    // An external abort means the run budget fired — stop and try to recover.
    if (outcome.kind !== "response") {
      if (outcome.kind === "aborted") {
        exitReason = "submission aborted (run budget exhausted)";
        break;
      }
      await backoff(backoffN++, deadline, signal);
      continue;
    }

    lastHttpStatus = outcome.status;
    const status = outcome.status;

    // --- Non-retryable: our bug, never persisted for a valid body. Stop + flag.
    if (status === 422 || status === 400) {
      return {
        status: "failed",
        recordId: null,
        attempts,
        lastHttpStatus: status,
        reason: describeNonRetryable(status, outcome.bodyText),
        warnings,
      };
    }

    // --- Rate limited: honor Retry-After (seconds) + jitter, then retry.
    if (status === 429) {
      await delayForRetryAfter(outcome.headers.get("Retry-After"), deadline, signal);
      continue;
    }

    // --- Transient server errors: backoff + full jitter, retry. We do NOT
    // GET-by-id here: the 503 (incl. the persist-then-503 "F") carries no
    // recordId, so there is nothing to confirm; recovery is via keyed retry → 201.
    if (status === 503 || (status >= 500 && status <= 599)) {
      await backoff(backoffN++, deadline, signal);
      continue;
    }

    // --- Apparent success that gives us an id (201, or a plausible-id 200):
    // confirm via GET before claiming success. Existence is the only truth.
    if (status === 201 || status === 200) {
      const recordId = extractRecordId(outcome.bodyText);
      if (recordId !== null) {
        const confirm = await fetchRecordById(recordId, signal);
        if (confirm.kind === "found") {
          diffStoredVsSent(confirm.record, canonicalBody, warnings);
          return {
            status: "confirmed",
            recordId,
            attempts,
            lastHttpStatus: status,
            reason: null,
            warnings,
          };
        }
        // Couldn't confirm (404 / GET error): the body was fake or not yet
        // visible. Treat as transient and retry rather than trusting the 2xx.
      }
      // A 200 with no plausible recordId is the documented fake-200 trap; a 201
      // without one is anomalous. Either way it's unconfirmed → retry. No backoff
      // counter bump: this wasn't a server-signalled transient.
      await backoff(backoffN++, deadline, signal);
      continue;
    }

    // --- Any other status: treat conservatively as a stop-and-flag.
    return {
      status: "failed",
      recordId: null,
      attempts,
      lastHttpStatus: status,
      reason: `AMS returned unexpected HTTP ${status}: ${truncate(outcome.bodyText, 200)}`,
      warnings,
    };
  }

  // Retries exhausted / budget hit / aborted. The record may have persisted on a
  // 503-F we never confirmed; its recordId never came back, so the ONLY way to
  // find it is the records list, matched by canonical body.
  //
  // Deliberately run recovery WITHOUT the external signal: if we exited because
  // that signal aborted (run-wide budget), threading it into this GET would abort
  // it instantly and misreport a genuinely-persisted record as `failed`. The list
  // endpoint is reliable and already bounded by AMS_GET_TIMEOUT_MS, so it's safe
  // to give recovery its own short, independent budget here.
  const recoveredId = await recoverByCanonicalBody(canonicalBody);
  if (recoveredId !== null) {
    warnings.push(
      "recovered via end-of-run records list — record had persisted (likely on a 503 after write) but was never confirmed via 201",
    );
    return {
      status: "confirmed",
      recordId: recoveredId,
      attempts,
      lastHttpStatus,
      reason: null,
      warnings,
    };
  }

  return {
    status: "failed",
    recordId: null,
    attempts,
    lastHttpStatus,
    reason:
      lastHttpStatus !== null
        ? `${exitReason} after ${attempts} attempt(s); last HTTP status ${lastHttpStatus}`
        : `${exitReason} after ${attempts} attempt(s); no HTTP response received (transport failures)`,
    warnings,
  };
}

// GET /api/v1/records/:id — reliable. 200 → found, 404 → absent, anything else
// (or a transport failure) → error so the caller retries the POST.
type FetchByIdResult =
  | { kind: "found"; record: StoredRecord }
  | { kind: "absent" }
  | { kind: "error" };

async function fetchRecordById(
  id: string,
  signal: AbortSignal | undefined,
): Promise<FetchByIdResult> {
  const outcome = await httpRequest({
    method: "GET",
    path: `/api/v1/records/${encodeURIComponent(id)}`,
    timeoutMs: AMS_GET_TIMEOUT_MS,
    ...(signal ? { signal } : {}),
  });
  if (outcome.kind !== "response") return { kind: "error" };
  if (outcome.status === 404) return { kind: "absent" };
  if (outcome.status !== 200) return { kind: "error" };

  let parsed: unknown;
  try {
    parsed = JSON.parse(outcome.bodyText);
  } catch {
    return { kind: "error" };
  }
  if (!isPlainObject(parsed) || typeof parsed.recordId !== "string") {
    return { kind: "error" };
  }
  return { kind: "found", record: parsed as StoredRecord };
}

// GET /api/v1/records — reliable list. Returns null on any failure so callers
// degrade gracefully (recovery simply fails → record reported as failed).
export async function listRecords(signal?: AbortSignal): Promise<RecordsList | null> {
  const outcome = await httpRequest({
    method: "GET",
    path: "/api/v1/records",
    timeoutMs: AMS_GET_TIMEOUT_MS,
    ...(signal ? { signal } : {}),
  });
  if (outcome.kind !== "response" || outcome.status !== 200) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(outcome.bodyText);
  } catch {
    return null;
  }
  if (!isPlainObject(parsed) || !Array.isArray(parsed.records)) return null;
  const records = parsed.records.filter(
    (r): r is StoredRecord => isPlainObject(r) && typeof r.recordId === "string",
  );
  const count = typeof parsed.count === "number" ? parsed.count : records.length;
  return { count, records };
}

// End-of-run-for-this-record recovery: find a stored record whose canonical body
// equals what we submitted, returning its recordId. This catches a write that
// persisted on a 503-F but never surfaced a 201.
async function recoverByCanonicalBody(
  canonicalBody: string,
  signal?: AbortSignal,
): Promise<string | null> {
  const list = await listRecords(signal);
  if (list === null) return null;
  for (const stored of list.records) {
    if (storedRecordCanonicalBody(stored) === canonicalBody) return stored.recordId;
  }
  return null;
}

// Defensive only: this stub echoes the submitted body verbatim, so a confirmed
// record's canonical body always equals what we sent. If a real AMS ever mutated
// a field, this surfaces it as a warning. It never fires against this stub.
function diffStoredVsSent(
  stored: StoredRecord,
  sentCanonicalBody: string,
  warnings: string[],
): void {
  const storedBody = storedRecordCanonicalBody(stored);
  if (storedBody !== sentCanonicalBody) {
    warnings.push(
      `stored record differs from submitted body (stored=${truncate(storedBody, 160)} sent=${truncate(sentCanonicalBody, 160)})`,
    );
  }
}

// Pull a plausible recordId from a 2xx body. "Plausible" = a non-empty string;
// this rejects every fake-200 variant (truncated/unparseable JSON, a body with
// no recordId, and the recordId:0 numeric case). The subsequent GET is what
// actually proves the record exists.
function extractRecordId(bodyText: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return null;
  }
  if (!isPlainObject(parsed)) return null;
  const { recordId } = parsed;
  if (typeof recordId === "string" && recordId.trim().length > 0) return recordId;
  return null;
}

function describeNonRetryable(status: number, bodyText: string): string {
  if (status === 422) {
    const details = extractValidationDetails(bodyText);
    const suffix = details.length > 0 ? `: ${details.join("; ")}` : "";
    return `AMS rejected the record as invalid (422)${suffix} — non-retryable; needs data correction`;
  }
  return `AMS rejected the request as malformed (400): ${truncate(bodyText, 200)} — non-retryable`;
}

function extractValidationDetails(bodyText: string): string[] {
  try {
    const parsed: unknown = JSON.parse(bodyText);
    if (isPlainObject(parsed) && Array.isArray(parsed.details)) {
      return parsed.details.filter((d): d is string => typeof d === "string");
    }
  } catch {
    // fall through
  }
  return [];
}

// Sleep honoring a Retry-After header (integer seconds here) plus a little
// jitter. Falls back to standard backoff when the header is missing/unparseable.
async function delayForRetryAfter(
  headerValue: string | null,
  deadline: number,
  signal: AbortSignal | undefined,
): Promise<void> {
  const seconds = headerValue !== null ? Number.parseInt(headerValue, 10) : NaN;
  if (Number.isFinite(seconds) && seconds >= 0) {
    const ms = seconds * 1000 + Math.random() * AMS_RETRY_AFTER_JITTER_MS;
    await sleepBounded(ms, deadline, signal);
    return;
  }
  await backoff(0, deadline, signal);
}

// Exponential backoff with FULL jitter: random(0, min(cap, base·2^n)).
async function backoff(
  n: number,
  deadline: number,
  signal: AbortSignal | undefined,
): Promise<void> {
  const ceiling = Math.min(AMS_BACKOFF_CAP_MS, AMS_BACKOFF_BASE_MS * 2 ** n);
  await sleepBounded(Math.random() * ceiling, deadline, signal);
}

// Sleep, but never past the per-record deadline (so a long backoff can't blow
// the wall-clock budget) and wake immediately if the external signal aborts.
function sleepBounded(
  ms: number,
  deadline: number,
  signal: AbortSignal | undefined,
): Promise<void> {
  const remaining = deadline - Date.now();
  const clamped = Math.max(0, Math.min(ms, remaining));
  return new Promise<void>((resolve) => {
    if (clamped <= 0 || signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(finish, clamped);
    const onAbort = (): void => finish();
    function finish(): void {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
