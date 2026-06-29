# PLAN-CHECKLIST — implementation tracker

> Phased task list for the Email → AMS pipeline. Check items as completed.
> Source of design detail: `PLAN.md` (and `RESEARCH.md`). Keep the run under 3h.

---

## Phase 0 — Scaffold & preflight
- [x] Confirm Node 18+ and stub runs: `node stub/server.js` → `GET /healthz` ok
- [x] `package.json` with `"start": "tsx src/pipeline.ts"`; devDeps `tsx`, `typescript`
- [x] `tsconfig.json` (strict, ESNext/NodeNext)
- [x] `src/` directory created; no runtime deps (native `fetch`/`crypto`/`AbortSignal`)
- [x] `.gitignore` (node_modules, run-report.json optional) — repo hygiene

## Phase 1 — HTTP foundations
- [ ] Base URL constant `http://localhost:8472`
- [ ] `extractClient.ts`: `POST /api/v1/extract` `{email}` → `output` string
- [ ] Shared fetch helper with `AbortSignal.timeout` + error classification
      (TimeoutError/AbortError vs HTTP status vs network)
- [ ] `canonical.ts`: recursive key-sorted JSON stringify (byte-stable body)

## Phase 2 — Parse & normalize (mechanical correctness)
- [ ] `parse.ts`: extract first balanced `{…}` JSON from prose/markdown fence;
      handle bare JSON; return `null`/error on refusal string
- [ ] `normalize.ts`:
  - [ ] `state` → 2-letter USPS (`Tex.` → `TX`; full names + abbrevs map)
  - [ ] `lineOfBusiness` → enum (lowercase, spaces/hyphens → `_`)
  - [ ] `effectiveDate` → `YYYY-MM-DD` (`MM/DD/YYYY`, `M/D/YY`; 2-digit year → 20YY)
  - [ ] `annualRevenue` currency string → number (`$4.2M`→4200000, K/M/B, commas)
  - [ ] `zip` → 5-digit **string**

## Phase 3 — Grounding vs source email (the real test)
- [ ] `ground.ts`: "unsupported value" signal phrase list (tbd, hasn't locked, once…confirms, deciding between, don't have)
- [ ] **E2**: revenue asserted but email says TBD → force `annualRevenue: null` (+log override)
- [ ] **E3**: detect PO-box instruction, parse `PO Box …` address → override `mailingAddress` (+log override + evidence); fallback `needs_review` if parse fails
- [ ] **E4**: effectiveDate asserted but email says undecided → **flag/hold, do not submit** (`needs_review`)
- [ ] Every override records `{field, from, to, reason, evidence}`

## Phase 4 — Client-side validation (mirror AMS schema, RESEARCH §7)
- [ ] `validate.ts`: required/non-empty strings; `dba` string|null; address object
- [ ] `state` in 50+DC USPS set; `zip` `^\d{5}$` string; `effectiveDate` regex; LOB enum
- [ ] `annualRevenue` number **or** explicit `null` (must be present, not omitted)
- [ ] `contactEmail` regex; invalid+unfixable → `failed`/`needs_review` (skip submit)

## Phase 5 — Resilient submission (core)
- [ ] `amsClient.ts`: build canonical body once; stable `Idempotency-Key` per email
- [ ] Per-attempt `AbortSignal.timeout(~4s)` to escape 30s hang
- [ ] Response classification:
  - [ ] `201` + plausible string `recordId` → verify
  - [ ] `200` → trust only with plausible string `recordId` + GET confirm; otherwise **retry** (transient — never success/failure)
  - [ ] `429` → honor `Retry-After` (sec) + jitter, retry
  - [ ] `503`/timeout/abort → backoff + full jitter (no Retry-After), retry. **No GET-by-id here** (503-F returns no recordId); recovered via keyed retry → `201` + end-of-run list match
  - [ ] `422` → stop + flag (non-retryable)
  - [ ] `400` → stop + flag (non-retryable)
- [ ] Backoff: `random(0, min(5s, base·2^n))`; honor Retry-After when present
- [ ] Bounds: `maxAttempts ≈ 10–12` + wall-clock budget (every outcome consumes an attempt; need 2 success-branch hits per record); on exhaustion → **`GET /api/v1/records` list + match by canonical body** before declaring `failed` (recovers a 503-F persist)
- [ ] **GET `/records/:id` confirm** on every id-bearing success (`201` / plausible-id `200`); existence = truth
- [ ] (Defensive) stored-vs-sent field diff (won't fire on this stub)

## Phase 6 — Orchestration, report, reconciliation
- [ ] `pipeline.ts`: loop emails sorted by filename → per-email verdict object
- [ ] `report.ts`: write `run-report.json` (machine) + console summary table
- [ ] Verdict fields: `email, status, recordId, attempts, lastHttpStatus, corrections, flags`
- [ ] Reconcile: `GET /api/v1/records` → `count == #confirmed`, no duplicate recordIds, no duplicate logical records **(dedup by canonical body — key isn't stored on the record)**; also recovers any 503-F persist never confirmed via `201` → PASS/FAIL line

## Phase 7 — Verify the run (acceptance)
- [ ] Restart stub, `npm start` → expected: 3 confirmed + 1 needs_review, 0 dups
- [ ] E1 confirmed (Tex→TX, LOB, date, $4.2M, prose/fence stripped)
- [ ] E2 confirmed with `annualRevenue: null`
- [ ] E3 confirmed with PO Box 1142, Bend, OR 97709
- [ ] E4 `needs_review: effectiveDate not stated in source` (not submitted)
- [ ] **Run twice without restart → record count unchanged (no duplicates)**
- [ ] Reconciliation PASS

## Phase 8 — Deliverables
- [ ] One-line run command verified (`npm start`)
- [ ] `NOTES.md`: what cut, what to do with more time, "3 vs 4 emails" note, grounding limits, things not to ship as-is
- [ ] (Optional, if time) light unit tests for `normalize`/`parse`
- [ ] Loom talking points noted: confident decision (E2 → null), unsure decision (E4 hold vs placeholder)

---

### Do-not-cut invariants (must hold at all times)
- GET-confirm before claiming success
- Stable Idempotency-Key + byte-stable canonical body per record
- Bounded retries + wall-clock budget (run always terminates with a verdict)
- Never fabricate a required field; flag/hold instead (E4)
- Every record ends confirmed or clearly-failed — never silently lost
