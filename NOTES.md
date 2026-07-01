# NOTES

What I'd do with more time, what I deliberately traded off, and what I would
**not** ship as-is.

## How to run

```bash
node stub/server.js   # terminal 1: AMS + extraction stub on :8472 (do not modify)
npm start             # terminal 2: run the pipeline (≙ npx tsx src/pipeline.ts)
```

`npm start` processes every `inbox/email_*.txt` in filename order, prints a
summary table + per-email corrections/flags, writes the machine-readable
`run-report.json`, and ends with a reconciliation PASS/FAIL line. No runtime
dependencies (Node 18+ native `fetch`/`crypto`/`AbortSignal`); `tsx` +
`typescript` are the only devDeps. Against a freshly-restarted stub the expected
result is **3 confirmed + 1 needs_review, 0 duplicates, reconciliation PASS**.

---

## "Three emails" vs four

The README says "three messy insurance emails," but `inbox/` contains **four**
(`email_1`–`email_4`). All four are handled. I assumed the count in the prose
was stale, not that one email should be ignored.

---

## Grounding (Phase 3) — the decisions and their tradeoffs

The real test isn't reformatting the model's output; it's catching where the
model contradicts, invents, or omits relative to the **source email**. I do
**lightweight, explainable, per-field grounding** rather than a second LLM pass:
a short list of "unsupported value" signal phrases (`tbd`, `hasn't locked`,
`once … confirms`, `deciding between`, …) that must **co-occur in the same
sentence** as the field's topic. Every change is logged as an auditable
`{field, from, to, reason, evidence}` carrying the source sentence.

Per-field decisions:

- **E2 revenue → `null`.** Revenue is nullable in the schema and the email says
  it's TBD, so I correct it to `null` and log the override. *Confident
  decision.*
- **E3 mailing address → PO box.** The email explicitly says mail must go to the
  PO box, not the facility; I parse `PO Box …, City, ST zip` from the email and
  override. If the PO box can't be parsed, I **hold** (`needs_review`) rather
  than submit the wrong address.
- **E4 effectiveDate → hold.** The model invented a date the email says is
  undecided. `effectiveDate` is required and non-nullable, so I refuse to
  fabricate it and flag `needs_review` instead. *The decision I'm least sure
  about* — holding vs. submitting with a placeholder/best-guess is a judgment
  call; I chose "never fabricate a required field."

### Deliberate tradeoffs (intentional, but you should know they're choices)

1. **Asymmetric default on revenue (false-`null` over false-value).** The
   revenue topic list is broad (`revenue`, `financ`) so an email like "I don't
   have the financials" will null revenue even if the number legitimately came
   from elsewhere. This is the conservative "don't guess" bias on a nullable
   field — chosen on purpose, but it is a choice, not a free lunch.

2. **Co-occurrence is sentence-scoped.** If a field's topic and its
   "unsupported" signal land in *different* sentences, nothing fires. This is
   what keeps E4's revenue (`$1.2M`) intact while only its `effectiveDate` is
   held — but it means a contradiction split across sentences would be missed.
   Real generality wants a grounding/confidence model, which is out of scope for
   a 3-hour, dependency-free build.

3. **Topic matching is substring, not word-boundary.** `includes("effective")`
   would also match "ineffective", etc. No fixture triggers it; I'd switch to
   `\b…\b` if hardening.

### Would not ship as-is

- **`splitSentences` breaks on abbreviation periods.** A source written
  `P.O. Box 1142` fragments the sentence at `P.O.`. Parsing still succeeds (the
  PO-box regex is period-tolerant), so this only degrades the *evidence string*,
  not correctness — but it's the kind of thing that bites a real, messier inbox.
- **Phrase list is hand-tuned to these fixtures.** It generalizes reasonably,
  but a production version needs a maintained lexicon (or a model) plus tests
  over a real corpus, not four emails.

## Validation (Phase 4) — a deliberately faithful mirror

`validate.ts` is a client-side copy of the AMS server's own validator (`ur()` in
the stub). Running it *before* submitting lets us catch a bad record locally,
attach field-level reasons to the verdict, and skip wasting AMS attempts; for a
valid body the server's 422 path should then never fire. It is intentionally an
**independent** copy of the schema (its own USPS set, LOB enum, and regexes)
rather than reusing the normalizer's tables — it is the contract against the AMS,
so it must assert the AMS's rules in their own right.

Two choices worth calling out:

- **Arrays as `mailingAddress` are treated as objects, on purpose.** The stub's
  guard is `!r || typeof r != "object"`, and `typeof [] === "object"`, so an
  array falls through to the street/city/state/zip sub-checks (which then fail).
  My first pass special-cased arrays into the single "required object" error,
  which is arguably cleaner but is a *deviation* from a module whose whole job is
  to be a faithful mirror. I removed the special-case so the behavior matches
  `ur()` byte-for-byte. (No real input produces an array here either way.)
- **Format-only checks mirror the server.** Like `ur()`, the date and email
  regexes are shape-only — `effectiveDate` accepts a well-formed-but-nonsense
  date like `2026-13-45`, and the email regex is permissive. Validating
  *stricter* than the server would reject bodies the AMS actually accepts, so
  matching the stub is the correct call, not an oversight.

### Would not ship as-is

- **`NaN`/`Infinity` pass `annualRevenue` (defensive-only gap).** `typeof NaN
  === "number"`, so both `ur()` and this validator accept it. It doesn't break
  anything in this pipeline because `normalize.ts` guards every numeric coercion
  with `Number.isFinite`, and even if one slipped through, `JSON.stringify(NaN)`
  → `null`, which is itself a valid `annualRevenue`. But it means a "validated"
  record could in principle serialize to a body that differs from what was
  validated; a hardened validator would reject non-finite numbers explicitly.
- **Validation short-circuits submission by design.** `validate.ts` returns
  `{ ok, errors }` with field-level reasons; the pipeline runs it *after*
  normalize/ground and *before* submit, so an invalid-and-unfixable record is
  reported as `needs_review`/`failed` with those reasons and never wastes an AMS
  attempt. On the four fixtures every submitted body validates locally, so the
  server's 422 path never fires — which is the intended outcome, not an untested
  branch.

## Submission & reconciliation (Phases 5–6)

Submission is built around two invariants: **truth = `GET`** (a `2xx` body is
never trusted on its own; an id-bearing success is only `confirmed` once
`GET /records/:id` shows it exists, and a `503`/timeout is never read as a failed
write), and **stable identity across retries** (the same byte-stable canonical
body under one stable `Idempotency-Key`, so the stub's dedup collapses the
guaranteed persist-then-`503` + later `201` into a single stored row). The run
always terminates with a verdict per email — `confirmed`, `needs_review` (a
deliberate hold, e.g. E4), or `failed` (with a reason + last status) — bounded by
a per-record attempt cap, a per-record wall-clock budget, and a whole-run budget.

### Reconciliation assumes a single run against a freshly-reset AMS

This is the caveat I most want a reviewer to see. End-of-run reconciliation
(`reconcile()` in `report.ts`) asserts, against `GET /api/v1/records`:

1. `stored count == confirmed count`,
2. no duplicate `recordId`s,
3. no duplicate **logical** records (dedup by canonical body, since the
   idempotency key isn't stored on the row), and
4. no **orphans** — every stored row maps to a verdict we claimed as
   `confirmed`.

Checks (1) and (4) implicitly assume the AMS contains **only this run's
records** — i.e. a freshly-reset stub. That holds for every graded scenario,
including "run twice without restarting the stub" (the stable key + body keep the
count pinned at 3, so a second run still reconciles cleanly). It's also
deliberately strict in a useful way: a held `needs_review` or a `failed` record
that *actually* persisted would surface as an orphan → reconciliation **FAIL**,
which is exactly the "never silently lost" signal we want.

**But it would be wrong against a real, shared, persistent AMS:** every
pre-existing record would be flagged as an orphan and blow up the count check,
producing a spurious FAIL. The correct general design is to **scope
reconciliation to the set of recordIds / canonical bodies this run actually
touched**, rather than treating the entire store as if this run produced it. I'd
make that change before pointing this at anything but the take-home stub. (PLAN
§6's `count == #confirmed` wording matches the current behavior, so this is a
known limitation, not a deviation.)

### Smaller notes

- **Recovery vs. audit are different layers.** A `503`-after-persist returns no
  `recordId`, so it can't be confirmed by id. The *recovery* of such a write is
  the keyed retry → eventual `201`, backstopped on attempt-exhaustion by a
  list-match on canonical body (in `amsClient.submitRecord`). Reconciliation does
  **not** heal a missed persist — it only *audits*, surfacing one as an orphan.
- **Dedup-by-body has a theoretical false-positive.** Two distinct emails that
  normalized to byte-identical bodies would look like a duplicate logical record.
  Impossible with these fixtures (distinct insureds); the idempotency key would be
  the more correct dedup dimension if the AMS stored it, which it doesn't.
- **`run-report.json` is non-deterministic by one field.** `generatedAt` is a
  wall-clock timestamp, so byte-diffing reports across runs is noisy. Intentional
  for a report artifact; I'd drop or freeze it if reports were ever diffed in CI.
- **Attempt counts in the report depend on stub state, not just the record.** The
  committed `run-report.json` is captured from a **freshly-restarted** stub, where
  every body must draw its guaranteed persist-then-`503` before a `201` — so the
  attempt counts are `email_1=4, email_2=4, email_3=2`. A *second* run without
  restarting the stub shows lower counts (e.g. `1/3/1`), because the records are
  already persisted and the stable key + body short-circuit straight to a
  confirmable `201`. Both are correct and both reconcile at count `3`; the number
  just isn't a fixed property of a record.
- **Mechanical normalizations aren't in `corrections[]` — only grounding overrides
  are.** `corrections[]` records where I overrode the *model* against the *source
  email* (E2 revenue→`null`, E3 address→PO box). E1's mechanical reformats
  (`Tex.`→`TX`, `general liability`→`general_liability`, `07/01/2026`→`2026-07-01`,
  `$4.2M`→`4200000`, prose/fence stripping) are deliberately **not** logged as
  corrections — they're format coercions, not judgment calls against the source, so
  a clean E1 shows an empty `corrections[]`. The evidence that normalization worked
  is the confirmed record itself (verifiable via `GET /records/:id`). If richer
  observability were wanted, I'd emit a separate `normalizations[]`/audit trail
  rather than conflating the two; I kept them distinct because "we changed the
  model's claim" and "we reformatted a value" are different trust stories.

---

## What I cut (time-boxed at 3h)

- Second LLM grounding/confidence pass (the "correct" general solution).
- Unit tests beyond spot-checking; I verified grounding by running all four real
  extraction outputs through `normalize → ground` and asserting the §7 outcomes.
- Fancy console formatting; the report stays minimal and machine-readable.

---

## With more time

- Replace phrase-grounding with a confidence-scored grounding pass and a
  human-review queue for low-confidence fields.
- Property-test `normalize` (dates/currency/state/zip) and `parse` (prose +
  fenced + bare + refusal) against generated inputs.
- Word-boundary topic matching and a smarter sentence segmenter (abbreviation-
  aware) for tighter, cleaner evidence.

---

## Loom talking points

Two decisions to walk through on camera — one I'm confident about, one I'm not.

- **Confident: E2 revenue → `null`.** The model emitted a concrete revenue number,
  but the source email says it's TBD. `annualRevenue` is nullable in the schema,
  and the README is explicit — "use `null` if genuinely not stated, do not guess."
  So the right move is unambiguous: force `null`, log the override with the source
  sentence as evidence, and still submit. No fabrication, no dropped field, fully
  auditable. This is the clean case where grounding-against-source clearly beats
  trusting the model.

- **Unsure: E4 effectiveDate → hold vs. placeholder.** Same signal (model invented
  a value the email says is undecided), but `effectiveDate` is **required and
  non-nullable** — I can't `null` it. The judgment call: submit with a
  best-guess/placeholder date to keep the record flowing, or **hold** the record
  as `needs_review` and refuse to fabricate a required field. I chose to hold,
  because a wrong effective date on an insurance record has real downstream
  consequences (coverage windows, billing) and "never fabricate a required field"
  is the safer default. The counter-argument I'd raise: in some workflows a held
  record that nobody actions is *worse* than a flagged-but-submitted one, so the
  right answer is partly an org/process question, not purely a code one — which is
  exactly why it's the decision I'm least certain about.
