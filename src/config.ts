// Shared constants for the Email -> AMS pipeline.

// Base URL of the local AMS + extraction stub (see stub/server.js).
export const BASE_URL = "http://localhost:8472";

// Generous timeout for the reliable extraction transport.
export const EXTRACT_TIMEOUT_MS = 10_000;

// Per-attempt timeout for AMS submission. Kept well under the stub's 30s hang
// (STUB_HANG_MS) so a hung attempt is aborted and retried instead of blocking.
export const AMS_ATTEMPT_TIMEOUT_MS = 4_000;
