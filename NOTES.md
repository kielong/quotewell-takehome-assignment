# NOTES

## How to run

```bash
node stub/server.js   # terminal 1: AMS + extraction stub on :8472 (do not modify)
npm start             # terminal 2: run the pipeline (≙ npx tsx src/pipeline.ts)
```

No runtime deps (Node 18+ native `fetch`/`crypto`/`AbortSignal`). Against a
freshly-restarted stub: **3 confirmed + 1 needs_review, 0 duplicates,
reconciliation PASS**.

## Key decisions

- **Truth = `GET`.** A `2xx` body is never trusted on its own; a record is only `confirmed` once `GET /records/:id` shows it exists, and a `503`/timeout is never read as a failure because the write may have persisted anyway.
- **Safe retries.** Every attempt for one email reuses a single stable `Idempotency-Key` and one byte-stable canonical body, so retrying through a hang or a fake-`200` collapses back to one record instead of creating duplicates.
- **Ground against the source, don't just reformat.** Lightweight per-field rules catch where the model contradicts, invents, or omits vs. the email, with every override logged as `{field, from, to, reason, evidence}` for a human to audit.
- **E2 revenue → `null`.** The model emits a number the email calls TBD; revenue is nullable, so the honest move is to null it and log the override rather than pass along a guessed figure.
- **E3 address → PO box.** The email insists mail goes to the PO box, not the facility, so I parse the PO box out of the email and override the model's facility address (falling back to hold if it won't parse).
- **E4 effectiveDate → hold.** The model invents a date the email says is undecided, and effectiveDate is required and non-nullable, so I refuse to fabricate it and flag `needs_review` instead.
- **Four emails, not three.** README prose says "three" but `inbox/` has four, so I assumed the count was stale and handled all four rather than silently dropping one.

## What I cut (3h box)

- **Second LLM grounding/confidence pass** (the truly general solution) in favor of a small, explainable phrase list that's cheap and dependency-free.
- **Unit tests**, verified instead by running all four real extraction outputs end-to-end and checking the corrections/verdicts against the expected outcomes.
- **Fancy console output**, keeping the report minimal and machine-readable (`run-report.json`) plus a plain summary table.

## With more time

- **Replace phrase-grounding with a confidence-scored pass** and route low-confidence fields to a real human-review queue instead of a hard hold.
- **Property-test `normalize` and `parse`** across generated inputs (dates/currency/state/zip, and prose/fenced/bare/refusal extraction shapes).
- **Scope reconciliation to the records this run touched** so it works against a real, shared AMS (see below).

## Wouldn't ship as-is

- **Reconciliation assumes a freshly-reset, single-tenant stub** — it checks `stored == confirmed` and "no orphans" against the *entire* store, which is the strict "never silently lost" signal I want here but would flag every pre-existing record as an orphan against a real shared AMS.
- **The grounding phrase list is hand-tuned to these fixtures** — co-occurrence is sentence-scoped and topic matching is substring (not word-boundary), which generalizes okay but a real inbox needs a maintained lexicon or a model plus a smarter, abbreviation-aware segmenter.
- **`validate.ts` deliberately mirrors the server's shape-only checks** — so like the AMS it accepts a well-formed-but-nonsense date (`2026-13-45`) and non-finite numbers; matching the server is intentional (stricter would reject bodies it accepts), but a hardened version would add real date/number validation.

## Loom

https://www.loom.com/share/164b5f6fd5a84362ae979c0772b56d10

- **Confident: truth = `GET` + stable idempotency key** — the only definition of success that survives this API, since a body-trusting pipeline would silently lose a persist-then-`503` or duplicate on retry, which is exactly the failure being tested.
- **Unsure: E4 hold vs. placeholder** — I refuse to fabricate a required field so I hold it, but the counter-argument is that a held record nobody actions can be worse than a flagged-but-submitted one, making it partly an org/process call.
