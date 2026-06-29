# PLAN — Email → AMS submission pipeline

> Implementation plan derived from `RESEARCH.md`. Goal: a TypeScript pipeline
> that, for every email in `inbox/`, extracts → corrects → submits to the AMS,
> and ends with **every logical record either confirmed-saved or clearly reported
> as failed with actionable detail — never silently lost, never duplicated.**
> Hard cap: 3 hours. Bias toward correctness + resilience over polish.

---

## 1. Guiding principles (what graders are watching)

1. **Truth = `GET`.** A `200`/`201` body is not proof; a `503`/timeout is not
   proof of failure. The only source of truth that a record exists is
   `GET /api/v1/records/:id`.
2. **Idempotency key + byte-stable canonical body** are the *only* things that
   keep retries from creating duplicates. Both must be stable per logical record
   across all attempts.
3. **Don't fabricate.** The model lies/omits/contradicts the source in 3 of 4
   emails. Normalize formats, but for unsupported values either `null` them (when
   the schema allows) or **flag and hold** (when a required field is unsupported).
   Correct against the email where it contradicts (E3 PO box).
4. **Always terminate with a verdict.** Bounded retries + total time budget;
   every record ends `confirmed` (with `recordId`) or `failed`/`needs_review`
   (with reason, last status, attempt count).

---

## 2. Architecture & file layout

Single runnable entry point, small internal modules for readability (per README,
a single script is acceptable; we keep modules small and time-boxed).

```
takehome/
├── src/
│   ├── pipeline.ts        # orchestrator: loop over emails → verdict → report
│   ├── extractClient.ts   # POST /extract (reliable)
│   ├── parse.ts           # pull a JSON object out of arbitrary prose/markdown
│   ├── normalize.ts       # format fixes: state, LOB, date, currency, zip
│   ├── ground.ts          # source-grounding: null/override/flag vs email text
│   ├── validate.ts        # client-side mirror of the AMS schema (§7 of RESEARCH)
│   ├── amsClient.ts       # POST /records with retry/backoff/timeout + GET verify
│   ├── canonical.ts       # canonical (key-sorted) JSON stringify for body+hash
│   └── report.ts          # build + emit JSON + human-readable summary
├── package.json           # "start": "tsx src/pipeline.ts", devDep: tsx, typescript
├── tsconfig.json
└── run-report.json        # generated per run (machine-readable verdicts)
```

Run command: `npm start` (≙ `npx tsx src/pipeline.ts`). No runtime deps — Node 18+
native `fetch`, `AbortController`, `AbortSignal.timeout`, `crypto.randomUUID`.

---

## 3. Per-email pipeline (the happy path + corrections)

For each `inbox/email_*.txt`, sorted by filename:

1. **Read** raw email text.
2. **Extract** — `POST /api/v1/extract` with `{email}` → raw model `output`
   string. (Reliable transport; still mandatory — no hand-transcribing.)
3. **Parse** — extract the first balanced `{…}` JSON object from arbitrary text
   (handles E1's prose + ```json fence; pass-through for bare JSON). If no JSON
   object is found (e.g. the refusal string), → `failed: unparseable_extraction`.
4. **Normalize** formats (mechanical, general):
   - `state`: full/abbrev/with-period → 2-letter USPS (`Tex.` → `TX`). Lookup map.
   - `lineOfBusiness`: lowercase, spaces/hyphens → underscores, validate against
     enum (`general liability` → `general_liability`).
   - `effectiveDate`: parse `MM/DD/YYYY`, `M/D/YY`, etc. → `YYYY-MM-DD`
     (2-digit year → 20YY).
   - `annualRevenue`: currency string → number (`$4.2M` → `4200000`,
     `$1.2M` → `1200000`); strip `$`, commas; expand `K`/`M`/`B` suffixes.
   - `zip`: coerce to a **5-digit string** (the validator requires `typeof string`).
5. **Ground-check against source email** (the real test — see §4 below).
6. **Validate** client-side against the AMS schema (§7 of RESEARCH). If invalid
   and unfixable → `failed`/`needs_review` with field-level reasons; skip submit.
7. **Submit with retry** (see §5). Build canonical body once; derive stable
   idempotency key once.
8. **Confirm** via `GET /api/v1/records/:id`. Only a record that exists counts as
   `confirmed`.
9. Record the per-email **verdict** + any corrections/flags applied.

After the loop:

10. **Reconcile** — `GET /api/v1/records`, assert `count == #confirmed`, assert no
    duplicate `recordId`s and no duplicate logical records.
11. **Emit report** — `run-report.json` + console summary.

---

## 4. Grounding strategy (resolves RESEARCH §9 open questions)

We do **lightweight, explainable, per-field source grounding** — targeted rules
expressed generally, not a second LLM pass (out of scope for 3h). Every override
is logged with the email evidence line so a human can audit it.

| Case | Signal in email | Action | Verdict effect |
|---|---|---|---|
| **E2 revenue** | model asserts a number; email contains "TBD" / "revenue is TBD" / "don't hold … for it" near revenue | **force `annualRevenue: null`** | still submittable; log override |
| **E4 effectiveDate** | model asserts a date; email says "hasn't locked it in" / "once the owner confirms" / "get you the … date once" | **flag & hold — do NOT submit** | `needs_review: effectiveDate not stated in source` |
| **E3 mailingAddress** | email gives both a facility address and an explicit "mail goes to the PO box / make sure the mailing address is the po box" | **override address to the PO Box** (parse `PO Box \d+`, city/state/zip from the same instruction) | submittable; log override |

Implementation approach for E2/E4 (generalizable, cheap):
- Maintain a small list of **"unsupported value" signal phrases** (`tbd`,
  `to be determined`, `don't have`, `hasn't locked`, `once … confirms`,
  `deciding between`). If such a phrase co-occurs with the field's topic and the
  model still emitted a concrete value, treat the value as **unsupported**.
- If the field is **nullable** (`annualRevenue`) → set `null`.
- If the field is **required & non-nullable** (`effectiveDate`) → **flag/hold**,
  never fabricate.

E3 is the case proving we must validate *against source*, not just reformat. We
auto-correct (parse the PO Box from the email) and log that we overrode the model,
attaching the source line. If parsing the PO Box ever fails, fall back to
`needs_review` rather than submitting the wrong (facility) address.

> These rules are intentionally explainable and per-field. `NOTES.md` will call
> out that full generality would need a grounding/confidence LLM pass.

---

## 5. Resilience: retry, timeout, idempotency (the core of the exercise)

`amsClient.submit(record, idempotencyKey)`:

- **Canonical body**: `canonical.ts` produces a key-sorted, recursive JSON string;
  the same record always serializes to the same bytes → the stub's deterministic
  per-attempt outcome sequence behaves and we never accidentally change the body
  hash mid-retry.
- **Idempotency-Key header**: derived from email identity (e.g. `email_2`) or a
  hash of the normalized payload — **stable**, reused on every retry. NOT
  `randomUUID()` per attempt (that would create duplicates).
- **Per-attempt timeout**: `AbortSignal.timeout(~4000ms)` so we escape the 30s
  hang fast and retry (a consumed attempt advances the stub's outcome sequence,
  which is fine/desirable).
- **Response classification**:
  | Outcome | Meaning | Action |
  |---|---|---|
  | `201` + plausible string `recordId` | likely real success | **verify via GET**, then confirmed |
  | `200` | suspicious (fake-200 trap: truncated / missing recordId / `recordId:0`) | trust **only** if body has a plausible string `recordId` AND `GET /records/:id` confirms it; otherwise it's a transient → **retry** (never treat as success or failure) |
  | `429` + `Retry-After` | rate limited | wait `Retry-After` seconds + small jitter, retry |
  | `503` / timeout / `AbortError` | transient **or** persisted-then-503 ("F") | backoff + full jitter (no `Retry-After` here), retry. **Note:** the 503-F body carries **no `recordId`**, so we cannot GET-by-id here; the persisted write (if any) is returned by a later `201` via the idempotency key, and is caught by end-of-run list reconciliation (see Bounds) |
  | `422` | our validation bug (should not happen post-pre-validate) | **stop + flag**, non-retryable |
  | `400` | malformed JSON (our bug) | **stop + flag**, non-retryable |
- **Backoff**: honor `Retry-After` on 429; otherwise exponential backoff with full
  jitter `delay = random(0, min(cap≈5s, base·2^n))`.
- **Bounds**: per-record `maxAttempts ≈ 10–12`; overall wall-clock budget guard so
  the run always terminates. Note every outcome (429 / hang / fake-200 / 503-F)
  consumes a server-side attempt, and each record needs **two** success-branch hits
  (one 503-F persist, then one 201) — so budget for ~3–4 useful attempts plus
  transients. On exhaustion → `failed` with last status + attempts, but **first do a
  final `GET /api/v1/records` (list) and match by canonical body** — the record may
  have persisted on a 503-F that we never saw confirmed. We **cannot** GET-by-id on
  exhaustion because a 503-F never returns the `recordId`; the list endpoint is the
  only way to recover it.
- **Confirm-before-claim**: every apparent success that *gives us an id* (`201`, or
  a plausible-`recordId` `200`) funnels through `GET /records/:id`. Because every
  record is guaranteed ≥1 persist-then-503 before any `201`, and the 503-F response
  has no id, the recovery path for an id-less persist is the keyed retry → eventual
  `201`, backstopped by the list-based reconciliation above.

> Note (from RESEARCH §4.3): this stub echoes the body verbatim and never corrupts
> stored fields, so confirmation = "record exists with our recordId". A
> field-by-field stored-vs-sent diff is implemented as cheap defensive insurance
> but won't fire against this stub.

---

## 6. Reporting & reconciliation

Per-record verdict object:

```jsonc
{
  "email": "email_3",
  "status": "confirmed",            // confirmed | failed | needs_review
  "recordId": "AMS-XXXXXXXXXX",     // when confirmed
  "attempts": 3,
  "lastHttpStatus": 201,
  "corrections": [                   // human-auditable overrides
    {"field": "mailingAddress", "from": "880 Frontage Rd…97701",
     "to": "PO Box 1142…97709", "reason": "email: mail goes to the po box",
     "evidence": "all mail goes to the owners po box: PO Box 1142…"}
  ],
  "flags": []                        // e.g. needs_review reason for E4
}
```

- Write `run-report.json` (machine-readable) + print a console summary table:
  total, confirmed (with ids), failed/needs_review (with reasons + attempts).
- **Reconciliation**: `GET /api/v1/records` → assert `count == #confirmed`,
  no duplicate `recordId`s, no duplicate logical records. Note the idempotency key
  is **not stored** on the record, so dedup must be **by canonical body** (the
  stored row is a literal echo `{recordId, ...body, receivedAt}`), not by key.
  This list also recovers any record that persisted on a 503-F but was never
  confirmed via a `201`. Report a reconciliation PASS/FAIL line.

---

## 7. Expected per-email outcomes (acceptance criteria for the run)

| Email | LOB | Key corrections | Expected verdict |
|---|---|---|---|
| email_1 Blue Oak | GL | strip prose/fence; `Tex.`→`TX`; `general liability`→`general_liability`; `07/01/2026`→`2026-07-01`; `$4.2M`→`4200000` (corrected revenue ✓) | **confirmed** |
| email_2 Pelican Point | work comp | clean JSON; **revenue 850000 → `null`** (TBD) | **confirmed** |
| email_3 Sundance | commercial property | **address → PO Box 1142, Bend, OR 97709**; `8/15/26`→`2026-08-15` | **confirmed** |
| email_4 Tula Bakery | bop | `$1.2M`→`1200000`; **effectiveDate hallucinated, source has none** | **needs_review** (not submitted) |

A successful run: 3 confirmed (with real `AMS-` ids verified via GET), 1
needs_review with a clear actionable reason, 0 duplicates, reconciliation PASS.

---

## 8. Test / verification approach (time-boxed)

1. **Manual end-to-end**: start stub, `npm start`, read the summary + GET-confirm.
2. **Idempotency proof**: run twice without restarting the stub → record count
   must stay the same (no duplicates) — proves stable key + body.
3. **Spot-check corrections**: confirm E2 revenue is `null`, E3 address is the PO
   box, E4 is held with a reason in the report.
4. Light unit coverage only if time remains: `normalize` (date/currency/state),
   `parse` (prose+fence). Tests are explicitly not what's being graded.

---

## 9. Time budget (≤ 3h)

| Block | Target |
|---|---|
| Scaffold (package.json, tsconfig, extractClient, http helpers) | ~20m |
| parse + normalize + validate | ~35m |
| ground (E2/E3/E4 rules) | ~30m |
| amsClient: retry/backoff/timeout/idempotency + GET verify | ~45m |
| pipeline orchestration + report + reconciliation | ~25m |
| run, debug, NOTES.md | ~25m |
| **buffer** | rest |

Cut first if short on time: unit tests, stored-vs-sent diff, fancy console
formatting. Never cut: GET-confirm, idempotency key, bounded retries, the E2/E4/E3
grounding decisions.

---

## 10. Decisions locked (from RESEARCH §9)

1. Grounding: **targeted, explainable per-field rules + "unsupported value" signal
   phrases**; flag rather than fabricate for required fields.
2. E4: **do not submit**; report `needs_review: effectiveDate not stated in source`.
3. E3: **auto-correct to the PO box** and log the override with source evidence;
   fall back to `needs_review` if PO-box parsing fails.
4. Idempotency key: **derive from email identity** (stable, debuggable).
5. Timeout ~4s; honor `Retry-After` on 429; else exp backoff + full jitter
   (cap ~5s); `maxAttempts ≈ 10–12` + wall-clock budget.
6. Artifacts: `run-report.json` + console summary.
7. Structure: small modules under `src/`, single `npm start` entry.
8. Verification: `GET /records/:id` confirms any success that returns an id; the
   503-F path returns **no** id, so the id-less persist is recovered by the keyed
   retry → `201`, and backstopped by an end-of-run `GET /api/v1/records` list match
   (by canonical body). Existence is the confirmation signal.

Also note in `NOTES.md`: README says "three" emails, there are **four** — all
handled.
