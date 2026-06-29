# Take-home: Email → AMS submission pipeline

## The task

You're given three messy insurance emails (`inbox/`). For each one:

1. Send the raw email text to the extraction service (`POST /api/v1/extract`) — an LLM-backed endpoint that returns the model's raw text output.
2. Turn that output into a valid record and submit it to the AMS API (`POST /api/v1/records`).
3. Confirm each record was actually accepted.

Write your solution in **TypeScript**. Structure it however you like — a single script is fine. Everything runs locally; no API keys, no network access needed.

Your pipeline must go through the extraction service — don't hand-transcribe the emails into payloads. But the extraction output is **raw model text**: it may be wrapped in prose or markdown, use formats the AMS rejects, or confidently state things the source email does not support. What you submit is on you, not the model. Detecting, correcting, or flagging its mistakes programmatically is part of the task.

## The catch

The AMS API is unreliable **by design**, the way real carrier/AMS integrations are:

- It rate-limits (`429` with a `Retry-After` header).
- It sometimes hangs for a long time before failing with a `5xx`.
- Responses are not always well-formed. A `200` does not necessarily mean what you think it means.

Your job is to make submission reliable anyway. A run of your pipeline should end with every record either **confirmed in the AMS** or **clearly reported as failed with enough information to act on** — never silently lost.

The stub is deterministic: the same request body on the same attempt number always produces the same outcome. Restarting the stub resets its state, so your full run is reproducible.

## API reference

Base URL: `http://localhost:8472`

**`POST /api/v1/extract`** — the extraction service. Reliable transport, deterministic output.

- Request: `{"email": "<raw email text>"}`
- Response: `200 {"model": "qw-extract-1", "output": "<raw model text>"}`

**`POST /api/v1/records`** — the AMS. Unreliable by design, and **not idempotent**: a request may persist the record even if it then returns an error or times out. To make retries safe, send an `Idempotency-Key` header (any stable string that's unique per logical record) — the AMS returns the original record for a repeated key instead of creating a duplicate. Without a key, every accepted write creates a new record. Submit JSON:

| Field | Type | Notes |
|---|---|---|
| `insuredName` | string | Legal entity name |
| `dba` | string \| null | "Doing business as" name, if any |
| `mailingAddress` | object | `{street, city, state, zip}` — state is a 2-letter USPS code, zip is 5 digits |
| `lineOfBusiness` | string | One of: `general_liability`, `commercial_property`, `workers_compensation`, `commercial_auto`, `bop` |
| `effectiveDate` | string | `YYYY-MM-DD` |
| `annualRevenue` | number \| null | USD. Use `null` if genuinely not stated — do not guess |
| `contactEmail` | string | |

Responses:

- `201` `{recordId, status: "accepted", receivedAt}` — record saved.
- `422` `{error: "validation_failed", details: [...]}` — fix and resubmit.
- `429` with `Retry-After` header — you're being rate-limited.
- `400` / `503` — what they usually mean.
- `GET /api/v1/records/:id` is reliable and returns the saved record, or `404`.
- `GET /api/v1/records` is reliable and lists everything currently saved (use it to check your run didn't create duplicates).
- `GET /healthz` is reliable.

The emails are imperfect source material: information may be corrected mid-thread, ambiguous, or missing. Treat the model's output accordingly.

## Setup

```bash
node stub/server.js   # both endpoints on http://localhost:8472 — prebuilt, no install, do not modify it
```

That's the whole setup. Requires Node 18+. No API keys, no accounts, no cost.

## Ground rules

- **Time cap: 2–3 hours. Stop at 3. We mean it.** We're not looking for polish or completeness — we'd rather see what you prioritize under a real constraint than how nice you can make it over a weekend.
- **Use AI tools.** Claude, Cursor, Codex, whatever you actually work with. We use them every day and we want to see how you do. This isn't a gotcha. You should still understand and be able to defend every line.
- We're grading whether your pipeline survives an unreliable API and an ambiguous model output without losing data — not framework choice or test coverage.
- Don't modify the stub.

## Deliverables

1. Your TypeScript source plus a one-line command to run it (e.g. `npm start` or `npx tsx pipeline.ts`).
2. **`NOTES.md`** (~5 minutes, half our signal): what you'd do with more time, what you cut, and anything you wouldn't ship as-is.
3. **A 3–5 minute Loom** walking us through one decision you're confident about and one you're unsure about. This matters as much as the code.

Zip it up or send a repo link to the email that sent you this.
