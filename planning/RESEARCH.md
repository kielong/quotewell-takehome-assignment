# RESEARCH — Email → AMS submission pipeline

> Pre-implementation research for the QuoteWell take-home. Goal: understand the
> problem, the (deliberately hostile) stub, and the data before writing a line of
> pipeline code. No code has been written yet. `PLAN.md` and `PLAN-CHECKLIST.md`
> will live alongside this file in `planning/`.

---

## 1. The objective in one paragraph

For each email in `inbox/`, send the **raw email text** to the extraction
service (`POST /api/v1/extract`), turn the model's **raw text output** into a
schema-valid record, and submit it to the AMS (`POST /api/v1/records`). The AMS
is unreliable on purpose. A run must end with **every logical record either
confirmed-saved in the AMS or clearly reported as failed with actionable detail
— never silently lost, and never duplicated.** We must go through the extraction
service (no hand-transcribing) but we own correctness of what we submit: the
model output may be wrapped in prose/markdown, use formats the AMS rejects, or
confidently assert things the source email does not support. Hard cap: 3 hours.

---

## 2. Environment & toolchain (verified locally)

| Thing | Value |
|---|---|
| OS | macOS (darwin 25.5.0) |
| Node | **v25.9.0** (README requires 18+; we're well above) |
| npm | 11.12.1 |
| npx | 11.12.1 (`tsx` available via `npx tsx`, not yet installed) |
| Git | **Not a git repo** (`git status` → fatal). We may `git init` for our own hygiene; deliverable can be zip or repo. |
| Language required | **TypeScript** |
| Run command target | something like `npx tsx pipeline.ts` or `npm start` |

Native `fetch`, `AbortController`, `AbortSignal.timeout()`, and `crypto`
(`randomUUID`) are all available in Node 25 — **no runtime dependencies needed**
beyond a TS runner (`tsx`). This matters: README says everything runs locally
with just Node, no accounts/keys.

---

## 3. Repository inventory

```
takehome/
├── README.md            # problem statement (the brief)
├── inbox/
│   ├── email_1.txt      # Blue Oak  (GL)
│   ├── email_2.txt      # Pelican Point Seafood (work comp)
│   ├── email_3.txt      # Sundance / High Desert Holdings (commercial property)
│   └── email_4.txt      # Tula Bakery (BOP)
├── stub/
│   ├── server.js        # prebuilt, minified AMS+extract stub — DO NOT MODIFY
│   └── README.md        # "treat like a third-party API you don't control"
└── .idea/               # JetBrains project metadata (ignore)
```

> ⚠️ **Discrepancy to flag:** README §"The task" says *"three messy insurance
> emails"* but there are **four** files (`email_1`..`email_4`), and the stub has
> **four** hardcoded extraction fixtures. Treat all four as in-scope; the "three"
> is likely stale copy. Worth a one-line mention in `NOTES.md`.

---

## 4. The stub, decoded

`stub/server.js` is minified (Hono on Node's http server) but fully readable. It
exposes the two endpoints plus reliable read endpoints. **The stub is
deterministic**: the same request body on the same attempt number always yields
the same outcome; restarting resets all in-memory state. This is what makes a
full run reproducible.

### 4.1 `POST /api/v1/extract` — reliable transport, deterministic output
- Request `{ "email": "<raw text>" }`. Empty/non-string → `422`. Bad JSON → `400`.
- It matches the email text against a **fingerprint** (a substring, specifically
  the contact's email domain) and returns a **hardcoded** raw model string for
  that email. If no fingerprint matches, it returns a polite *"I wasn't able to
  confidently extract…"* refusal string.
- Response: `200 { "model": "qw-extract-1", "output": "<raw model text>" }`.
- **Implication:** extraction is a pure lookup. The "messiness" we must handle is
  baked into those four fixture strings (see §6). We still must call it (no
  shortcutting), but we can know exactly what comes back and design parsing/
  correction around it.

### 4.2 `POST /api/v1/records` — unreliable by design, NOT idempotent

This is the heart of the exercise. Pseudocode of the real logic:

```
body      = JSON.parse(request)                 // 400 on bad JSON
bodyHash  = sha256(canonicalStringify(body))    // stable, key-sorted, recursive
attempt   = ++attemptCountFor[bodyHash]          // increments on EVERY POST of this body
idemKey   = header "Idempotency-Key" (optional)
outcome   = sha256(SEED | bodyHash | attempt | "outcome").readUInt32BE % 100   // 0..99

if outcome <  18:  → 429 rate_limited, header Retry-After = 1..3 (sec)         // ~18%
if outcome <  28:  → sleep STUB_HANG_MS (default 30000ms) then 503             // ~10%
if outcome <  40:  → 200 with a MALFORMED body (record is NOT persisted)       // ~12%
else (>=40):       → run validation:
                       if invalid  → 422 validation_failed { details:[...] }
                       if valid    → persist record (cr), then:
                         if this is the FIRST success for bodyHash → 503 (F)   // persisted but errors!
                         else                                       → 201 accepted (E)
```

Key derived facts:

1. **Outcome is a pure function of `(bodyHash, attempt#)`** with a fixed seed
   (`STUB_SEED = "qw-takehome-v1"`). So for one exact body, retries walk a
   *fixed sequence* of outcomes — attempt 1 → o1, attempt 2 → o2, … The body
   must stay **byte-stable across retries** for this to behave predictably, and
   the hash is over a canonical (key-sorted) stringify so field order doesn't
   matter but values/types do.

2. **For a valid body, you never get a 422** (validation is body-dependent, not
   attempt-dependent). The only failures are transient: 429 / timeout / malformed
   / the one-time 503-after-persist. So a valid body *will* eventually succeed
   under retry. The success branch is ~60% per attempt, so it converges fast.

3. **The "200 ≠ success" trap (outcome 28–39, ~12%).** It returns HTTP 200 with a
   body that is *not* a real confirmation **and does not persist anything**. Three
   variants (chosen by another hash mod 3):
   - **v0:** a truncated JSON string (first ~60% of chars) → **unparseable JSON**.
   - **v1:** `{"status":"accepted","_node":"ams-prod-07"}` → valid JSON but **no `recordId`**.
   - **v2:** `{"recordId":0,"status":true,"receivedAt":1718200000}` → `recordId` is
     `0` (not a real ID/string), `status` is boolean, `receivedAt` is a number.
   → We must **not** trust a 200 by itself. Treat as success only if the body has
     a plausible string `recordId` AND (ideally) a follow-up `GET` confirms it.

4. **The "persisted-but-errored" trap (outcome ≥40, valid, first time → 503 "F").**
   The record **is written to the store**, then the endpoint returns `503`. This
   is the literal embodiment of README's *"a request may persist the record even
   if it then returns an error or times out."* The client sees a 503 and must
   retry; on a later attempt that lands in the success branch again, it returns
   `201` with the **same** record (thanks to the idempotency key — see §5). So:
   **a 503/timeout does not mean the write failed.** Verification via `GET` is the
   only source of truth.
   → **Consequence:** because the body is byte-stable, the "F" gate fires on the
   *first* time **each** logical record reaches the success branch. So **every**
   record is guaranteed at least one 503 (the persist-F) before it can ever see a
   `201`. "503 ≠ failure" is therefore the **normal path for every record**, not a
   rare edge case — which is exactly why the post-success `GET`-confirm step is
   mandatory, not optional.

5. **The timeout trap (outcome 18–27, ~10%).** The server *hangs for 30s*
   (`STUB_HANG_MS`) before returning 503. Naively awaiting wastes 30s per hit.
   Because outcomes are per-attempt deterministic, we can set a **client-side
   timeout (AbortSignal.timeout) well under 30s, abort, and retry** — the next
   attempt has a fresh (likely different) outcome. This is a real latency win and
   a good design talking point. (Caveat: aborting still counts as a consumed
   attempt on the server side, so the outcome sequence advances either way.)

### 4.3 Reliable read/utility endpoints
- `GET /api/v1/records/:id` — reliable. Returns the saved record or `404`. **Our
  source of truth for confirmation.**
- `GET /api/v1/records` — reliable. `{ count, records:[...] }`. Use at end of run
  to assert **no duplicates** and that everything we think we saved is present.
- `GET /healthz` — reliable `{ ok:true }`. Good for a pre-flight check.

> **`recordId` format:** persisted records get `AMS-<10 uppercase hex>` (derived
> from `sha256(bodyHash + ":" + perBodyCounter)`). Useful to know for log/verify
> keying. The "real ID looks like a non-empty string starting with `AMS-`" shape
> is also a handy sniff test for the fake-200 bodies (whose `recordId` is missing,
> `0`, or in a truncated/unparseable blob).
> **No silent corruption in this stub:** a persisted record is a *literal echo* of
> the submitted body — `{ recordId, ...body, receivedAt }`. The stub never mutates
> stored fields. So the "compare stored vs sent to catch corruption" step (§9.8) is
> purely defensive/forward-looking here; it will never actually fire against this
> stub. Our real confirmation signal is simply that the record **exists** via `GET`.

---

## 5. Idempotency mechanics (must get this exactly right)

- Send a stable **`Idempotency-Key` header**, unique per *logical record*
  (one per email), the **same** across all retries of that record.
- Server behavior:
  - On a successful persist with a key present, it stores `key → recordId`.
  - A repeat request with a **known key** returns the **original `recordId`**
    instead of creating a new row. This is what makes the 503-then-201 dance
    safe.
  - **Scope caveat:** dedup only kicks in *inside the success branch* — the key
    lookup lives in the persist function (`cr()`), reached only when
    `outcome ≥ 40` **and** the body validates. A retry that draws a transient
    outcome (429 / timeout / malformed-200) still returns that error; a known key
    does **not** short-circuit those. So "known key ⇒ always returns the record"
    is wrong — it only returns the record once a retry actually lands in success.
- **Without a key**, every time a request reaches the success branch it creates a
  **brand-new record** (a fresh `recordId` from an internal per-body counter).
  Because our retries will hit the success branch ≥2 times (once for the 503-F,
  once for the 201), **omitting the key would create duplicates.** So the key is
  mandatory, not optional, for this stub.
- Recommended key: deterministic and stable, e.g. a UUIDv5/hash derived from the
  email identity (or just `"email_3"`), **not** `randomUUID()` per attempt.
  Industry guidance (Stripe, IETF `idempotency-key-header` draft) says one key
  per logical operation, reused across retries — exactly our need.

> Subtlety: the server's *outcome* depends on the **body hash**, while *dedup*
> depends on the **idempotency key**. Keep BOTH stable per record: same canonical
> body bytes + same key on every retry.

---

## 6. The data: extraction fixtures vs. source emails (the correctness traps)

The stub returns these exact outputs per email. Below, each is cross-checked
against the source email and the AMS schema (§7) to enumerate what we must
detect/correct/flag. **This is where "what you submit is on you, not the model"
bites.**

### Email 1 — Blue Oak (GL) · fixture wrapped in prose + ```json fence
Model output (abridged): `insuredName:"Blue Oak Industries LLC"`,
`dba:"Blue Oak Manufacturing"`, address `4180 Commerce Park Dr, Suite B, Waco,
state:"Tex.", zip:"76712"`, `lineOfBusiness:"general liability"`,
`effectiveDate:"07/01/2026"`, `annualRevenue:"$4.2M"`,
`contactEmail:"maria@blueoakmfg.com"`.

| Field | Issue | Correct value | Why |
|---|---|---|---|
| (wrapper) | Output is prose + a markdown ```json fence | strip to raw JSON | AMS needs clean JSON |
| state | `"Tex."` | `"TX"` | schema wants 2-letter USPS code |
| lineOfBusiness | `"general liability"` | `"general_liability"` | must match enum |
| effectiveDate | `"07/01/2026"` (MM/DD/YYYY) | `"2026-07-01"` | schema wants `YYYY-MM-DD` |
| annualRevenue | `"$4.2M"` (string) | `4200000` (number) | schema wants number |
| revenue value | model used $4.2M | **correct** | email thread *corrects* 3.8 → 4.2 in the latest message; model picked the corrected one ✓ |

### Email 2 — Pelican Point Seafood (work comp) · clean JSON fixture
Model output: all fields well-formed JSON; `lineOfBusiness:"workers_compensation"`,
`effectiveDate:"2026-07-01"`, **`annualRevenue:850000`**,
`contactEmail:"curtis@pelicanpointseafood.com"`, `dba:null`.

| Field | Issue | Correct value | Why |
|---|---|---|---|
| **annualRevenue** | model asserts **`850000`** | **`null`** | 🚩 **Hallucination.** Email explicitly says *"revenue is TBD… don't hold the submission for it."* README: *"Use `null` if genuinely not stated — do not guess."* The model invented a number the source does not support. **Must override to null.** |
| effectiveDate | `"2026-07-01"` | OK (`first of next month`; email dated Jun 3 → Jul 1) | plausible & supported |

This is the cleanest *transport* but the sharpest *semantic* trap.

### Email 3 — Sundance / High Desert Holdings (commercial property) · clean JSON
Model output: `insuredName:"High Desert Holdings LLC"`, `dba:"Sundance Storage"`,
address **`880 Frontage Rd, Bend, OR 97701`**, `lineOfBusiness:"commercial_property"`,
`effectiveDate:"8/15/26"`, `annualRevenue:950000`,
`contactEmail:"gary.hudd@sundancestorage.com"`.

| Field | Issue | Correct value | Why |
|---|---|---|---|
| **mailingAddress** | model used the **facility** address `880 Frontage Rd … 97701` | **PO Box 1142, Bend, OR 97709** | 🚩 Email *explicitly instructs*: mailing address must be the PO box; "mail sent to the facility just sits in the office." Model contradicted an explicit instruction. Note zip also changes 97701 → 97709. |
| effectiveDate | `"8/15/26"` (M/D/YY) | `"2026-08-15"` | format + 2-digit year → 2026 |
| contactEmail | `gary.hudd@sundancestorage.com` | OK | email warns *not* the old gmail; model picked correctly ✓ |
| revenue | `950000` | OK | email "around $950k/yr" |

> ⚠️ Correcting the mailing address requires reading the **email**, not just
> reformatting the model output. This is the case that proves we must validate
> model output *against source*, not merely normalize it. (Open question for
> PLAN: how far do we go — do we re-parse the email ourselves, or just special-
> case/flag? See §9.)

### Email 4 — Tula Bakery (BOP) · clean JSON
Model output: `insuredName:"Tula Bakery LLC"`, `dba:"Tula's"`, address
`614 Larkin St, San Francisco, CA 94109`, `lineOfBusiness:"bop"`,
**`effectiveDate:"2026-07-01"`**, `annualRevenue:"$1.2M"`,
`contactEmail:"sofia@tulabakery.com"`.

| Field | Issue | Correct value | Why |
|---|---|---|---|
| annualRevenue | `"$1.2M"` (string) | `1200000` (number) | format conversion |
| **effectiveDate** | model asserts **`2026-07-01`** | **NOT DERIVABLE** | 🚩 **Hallucination of a *required* field.** Email: *"I'll get you the requested effective date once the owner confirms it with her lender… hasn't locked it in yet."* The source supports **no** date. But the schema **requires** `effectiveDate` and offers **no null option**. → This record **cannot be honestly submitted**. The right outcome is to **flag/hold it as "failed — needs human input (effectiveDate unknown)"**, which satisfies README's "clearly reported as failed with enough info to act on." |

> Email 4 is the deliberate "you cannot make a clean record" case and is a strong
> candidate for the Loom's *"decision I'm unsure about"* (submit a placeholder &
> flag, vs. refuse to submit). Email 2's revenue→null is a strong *"confident"*
> decision.

### 6.1 Cross-email pattern summary
- **Format normalization needed:** state name→USPS (`Tex.`→`TX`), LOB
  spaces→underscores (`general liability`→`general_liability`), dates
  (`MM/DD/YYYY`, `M/D/YY`)→`YYYY-MM-DD`, currency strings (`$4.2M`, `$1.2M`)→numbers.
- **Output envelope:** one fixture is prose-wrapped with a markdown fence; others
  are bare JSON. Parser must robustly extract the JSON object from arbitrary text.
- **Hallucinations / source contradictions (the real test):**
  - E2: invented `annualRevenue` where email says TBD → must be `null`.
  - E3: used wrong (facility) mailing address despite explicit PO-box instruction.
  - E4: invented a required `effectiveDate` the email says is undecided → flag/hold.

---

## 7. AMS record schema & server-side validation (from stub `ur()`)

Submit JSON with these fields; the stub validates exactly as follows:

| Field | Type | Server rule (from stub) |
|---|---|---|
| `insuredName` | string | required, non-empty |
| `dba` | string \| null | if present, must be string or null |
| `mailingAddress` | object | required `{street, city, state, zip}` |
| `mailingAddress.street` | string | required, non-empty |
| `mailingAddress.city` | string | required, non-empty |
| `mailingAddress.state` | string | required, **2-letter USPS code** in the 50 states + DC set |
| `mailingAddress.zip` | string | required, matches `^\d{5}$` (5-digit **string**) |
| `lineOfBusiness` | string | one of `general_liability`, `commercial_property`, `workers_compensation`, `commercial_auto`, `bop` |
| `effectiveDate` | string | matches `^\d{4}-\d{2}-\d{2}$` (no null allowed) |
| `annualRevenue` | number \| null | number, or `null` if unknown (do **not** guess) |
| `contactEmail` | string | matches `^[^\s@]+@[^\s@]+\.[^\s@]+$` |

Notes:
- `zip` must be a **string** of exactly 5 digits. The validator does **not**
  coerce — it requires `typeof === "string"` (via the shared
  `s = n => typeof n == "string" && n.trim().length > 0` check). So the **number**
  `76712` is **rejected** with a 422; sending zip as a string is *required*, not
  just hygiene. (Same applies to every `s()`-checked string field: `insuredName`,
  `city`, `state`, `street`, `lineOfBusiness`, `effectiveDate`, `contactEmail`.)
- **`annualRevenue` must be *present*** as either a `number` or `null` — it cannot
  be **omitted**. `ur()` flags it whenever it isn't `null` and isn't a number, and
  `undefined` (a missing key) trips that. So for E2/E4 we must send
  `annualRevenue: null` explicitly; dropping the key fails validation. (`dba` is
  the *only* field that may be omitted entirely.)
- Validating **client-side against this same ruleset before submitting** lets us
  catch problems early, attach reasons, and avoid wasting AMS attempts. The 422
  path from the server should essentially never trigger if we pre-validate.

---

## 8. Risks, edge cases & "gotchas" checklist

- [ ] **Trust no 200.** Confirm via body shape + `GET /records/:id`.
- [ ] **Trust no 503/timeout as "failed write."** The record may have persisted
      (503-F case). Always reconcile via `GET` and/or idempotent retry.
- [ ] **Idempotency-Key mandatory + stable** per email; same key every retry.
- [ ] **Body must be byte-stable** across retries (canonical JSON) so the
      deterministic outcome sequence behaves and dedup works.
- [ ] **Respect `Retry-After`** on 429 (value is seconds, 1–3 here); add small jitter.
- [ ] **Client timeout < 30s** with `AbortSignal.timeout()` to escape the hang;
      then retry. Don't let one record stall the whole run for 30s repeatedly.
- [ ] **Bounded retries + total time budget** (3-hour cap; per-record max attempts,
      e.g. ~8–12) so the run always terminates with a clear per-record verdict.
- [ ] **Never retry a true 422 or 400** blindly — both are *our* bugs, not
      transient. A `422` is a data/validation bug; a `400` means we sent malformed
      JSON. Treat both as non-retryable "stop + flag," not loop. (For valid bodies
      neither should happen, but guard anyway.)
- [ ] **End-of-run reconciliation:** `GET /api/v1/records`, assert count == #saved
      and no duplicate `recordId`s / no duplicate logical records.
- [ ] **Per-record outcome report** (machine + human readable): confirmed
      (recordId) or failed (reason, last status, attempts). Never silent loss.
- [ ] **email_4 effectiveDate** and **email_2 revenue** decisions documented.
- [ ] **README says 3 emails, there are 4** — handle all four; note it.

---

## 9. Open questions / decisions to settle in PLAN.md

1. **How to detect hallucinations/contradictions programmatically vs. by hand?**
   - Pure normalization (formats) is mechanical and general.
   - Detecting E2 (revenue) and E4 (date) ideally generalizes: e.g., re-derive
     "is this value actually supported by the email text?" Cheap heuristic:
     check whether the email contains tokens like "TBD", "don't have", "hasn't
     locked", "once … confirms" near the relevant field, and if so force
     `null`/flag. Full generality would need a second LLM pass / grounding check —
     out of scope for 3h. **Decision needed:** general heuristic vs. targeted
     rules vs. a "confidence/grounding" cross-check. Lean: lightweight,
     explainable per-field validation + a short list of "unsupported value"
     signals, and *flag rather than fabricate* for required fields.
2. **E4 (`effectiveDate` unknown but required):** submit with a flag/hold, or
   refuse to submit and report as a clear failure? Lean: **do not submit**; report
   as `needs_review: effectiveDate not stated in source`. (Confirm this reading.)
3. **E3 mailing address:** auto-correct from the email (parse PO box), or flag for
   review? Auto-correcting requires email parsing logic. Lean: correct it *and*
   log that we overrode the model, with the source line as evidence.
4. **Idempotency key derivation:** human-stable (`"email_3"` / sha of normalized
   payload). Lean: derive from email identity so it's stable and debuggable.
5. **Client timeout value** for the hang (e.g., 3–5s) and **backoff policy**
   (honor Retry-After; otherwise exp backoff + full jitter, cap ~5–10s, max ~8–12
   attempts/record).
6. **Output artifacts:** a per-run JSON report + console summary; how to surface
   failures for a human to act on.
7. **Structure:** single `pipeline.ts` is acceptable per README; consider small
   modules (extractClient, normalize, validate, amsClient/retry, report) for
   readability without over-engineering. Time-box.
8. **Verification depth:** always `GET /records/:id` after a claimed success. The
   primary signal is simply that the record *exists* (and matches our recordId);
   comparing stored fields to what we sent is defensive only — this stub echoes
   the body verbatim and never corrupts it (see §4.3), so the comparison is
   forward-looking insurance, not a trap this stub actually springs.

---

## 10. External best-practice references (for the retry/idempotency design)

Consulted current (2026) guidance to ground the resilience design; all of it
aligns with what the stub forces us to do:

- **Retry only transient failures** — 429 and 5xx/408/network errors; never retry
  other 4xx (e.g. a real 422). Cap attempts (≈5 is typical; we'll allow a few more
  given ~40% transient-failure rate) and enforce a total time budget.
- **Honor `Retry-After`** (numeric seconds) on 429/503, and **add jitter even
  when honoring it** to avoid synchronized retry storms; otherwise use
  **exponential backoff with full jitter** (`delay = random(0, min(cap, base·2^n))`).
  ⚠️ **In this stub, only the `429` carries a `Retry-After` header.** Both 503
  paths (the 30s-hang timeout and the persist-then-503 "F" case) send **no**
  `Retry-After` — so for 503/timeout we fall back to backoff+jitter, not a header.
- **Idempotency keys are the prerequisite for safely retrying POSTs.** One key per
  *logical operation*, reused across retries (Stripe-style; IETF
  `idempotency-key-header` draft, Oct 2025). Server returns the original result for
  a known key — exactly the stub's contract.
- **Node `fetch` has no built-in timeout**; use `AbortSignal.timeout(ms)` per
  attempt (timeout fresh each attempt, retry on the outside) to escape the
  30s hang. Distinguish `TimeoutError`/`AbortError` from real responses.

Sources: code-talk "API Design Guide: Request Retries" (2026); digitalapplied
"API Error Handling and Resilience: 2026 Reference Guide"; sujeet.pro
"Exponential Backoff and Retry Strategy"; thelinuxcode "HTTP Retry-After Header";
tasukehub "Designing fetch Timeouts and Retries in Node.js"; solid-web "JavaScript
Fetch API patterns"; MDN/RFC 9110 §10.2.3 (Retry-After).

---

## 11. Proposed pipeline shape (to be detailed in PLAN.md)

```
for each email in inbox/ (sorted):
  1. read raw text
  2. POST /extract  → raw model string
  3. parse: extract JSON object from arbitrary prose/markdown
  4. normalize: state→USPS, LOB enum, dates→ISO, currency→number, zip→5-digit string
  5. ground-check vs source email:
       - force null where email says "unknown/TBD" (E2 revenue)
       - correct/override where email contradicts model (E3 address)
       - flag & hold where a REQUIRED field is unsupported (E4 date)
  6. validate against §7 schema (client-side); if invalid & unfixable → report failed
  7. submit with retry:
       - stable Idempotency-Key + byte-stable canonical body
       - AbortSignal.timeout per attempt; honor Retry-After; backoff+jitter
       - classify response: 201(verify) / 200(verify, likely fake) / 429(retry) / 503-or-timeout(retry) / 422-or-400(stop+flag)
       - on apparent success → GET /records/:id to CONFIRM
  8. record per-email verdict
finally:
  - GET /api/v1/records → reconcile count, assert no duplicates
  - print/emit human + machine summary: confirmed (ids) vs failed (reasons)
```

---

### TL;DR of what makes this hard (and what graders are watching)
1. **A 200 can be fake; a 503/timeout can have already saved.** Truth = `GET`.
2. **Idempotency key + stable body** are the only way retries don't duplicate.
3. **The model lies/omits/contradicts the source** in 3 of 4 emails — normalize
   formats, but more importantly *don't fabricate* (null/flag), and *correct
   against the email* where it contradicts (PO box). One record (E4) honestly
   can't be completed → report it as actionable-failed, don't fake a date.
