// Shared constants for the Email -> AMS pipeline.

// Base URL of the local AMS + extraction stub (see stub/server.js).
export const BASE_URL = "http://localhost:8472";

// Generous timeout for the reliable extraction transport.
export const EXTRACT_TIMEOUT_MS = 10_000;

// Per-attempt timeout for AMS submission. Kept well under the stub's 30s hang
// (STUB_HANG_MS) so a hung attempt is aborted and retried instead of blocking.
export const AMS_ATTEMPT_TIMEOUT_MS = 4_000;

// Timeout for the reliable GET endpoints (confirm-by-id, end-of-run list). These
// never hang like the POST path, so a shorter budget is plenty.
export const AMS_GET_TIMEOUT_MS = 5_000;

// Per-record cap on POST attempts. Every outcome (429 / 30s-hang / fake-200 /
// the guaranteed persist-then-503) consumes one server-side attempt, and each
// record needs at least TWO success-branch hits — the mandatory 503-after-persist
// ("F"), then a 201 ("E") — so we budget well above the bare minimum.
export const AMS_MAX_ATTEMPTS = 12;

// Wall-clock budget for a single record's submission. A hard stop so one record
// can never stall the whole run, even if it draws transients every attempt.
export const AMS_SUBMIT_BUDGET_MS = 60_000;

// Exponential backoff with FULL jitter: delay = random(0, min(cap, base·2^n)).
// Used for 503 / timeout / network retries (these carry no Retry-After here).
export const AMS_BACKOFF_BASE_MS = 250;
export const AMS_BACKOFF_CAP_MS = 5_000;

// Extra jitter added on top of a server-provided Retry-After (429) so retries
// don't resynchronize into a thundering herd.
export const AMS_RETRY_AFTER_JITTER_MS = 250;
