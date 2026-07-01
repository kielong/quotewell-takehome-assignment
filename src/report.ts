// Reporting & reconciliation (PLAN §6).
//
// Two artifacts close out a run:
//   1. A per-email VERDICT for every inbox email — confirmed / failed /
//      needs_review — carrying the recordId, attempt count, last HTTP status,
//      and the human-auditable corrections/flags from grounding. These are
//      written to run-report.json (machine-readable) and printed as a console
//      summary table.
//   2. A RECONCILIATION pass against GET /api/v1/records: the AMS's own view of
//      what persisted. We assert the stored count matches the records we claim
//      to have confirmed, that there are no duplicate recordIds, and — because
//      the idempotency key is NOT stored on the record — no duplicate LOGICAL
//      records (dedup by canonical body). This is what proves the retry/idempotency
//      machinery didn't silently create or lose a record.

import { writeFile } from "node:fs/promises";
import type { Correction, Flag } from "./ground.js";
import type { RecordsList } from "./amsClient.js";
import { storedRecordCanonicalBody } from "./amsClient.js";

// The terminal state of one logical record (one inbox email):
//   confirmed    — exists in the AMS, verified by GET; carries a recordId.
//   needs_review — held on purpose (e.g. E4: a required field the source doesn't
//                  support); never submitted. Actionable, not a system failure.
//   failed       — could not be confirmed despite the resilience machinery, or a
//                  non-retryable rejection; carries a reason + last status.
export type VerdictStatus = "confirmed" | "needs_review" | "failed";

export interface Verdict {
  email: string;
  status: VerdictStatus;
  recordId: string | null;
  // POST attempts made against the AMS (0 when we held/failed before submitting).
  attempts: number;
  lastHttpStatus: number | null;
  // Human-auditable overrides we applied vs. the model's output (grounding).
  corrections: Correction[];
  // Reasons we held the record for review (needs_review), if any.
  flags: Flag[];
  // Actionable detail for a non-confirmed verdict (null when confirmed).
  reason: string | null;
  // Non-fatal notes (e.g. list-based recovery of a 503-F persist).
  warnings: string[];
}

// One reconciliation assertion and whether it held.
export interface ReconciliationCheck {
  name: string;
  pass: boolean;
  detail: string;
}

export interface ReconciliationResult {
  pass: boolean;
  checks: ReconciliationCheck[];
  // The recordId of any stored row not matched to a confirmed verdict — an
  // orphan that persisted but we never claimed (should be empty).
  orphanRecordIds: string[];
}

export interface RunReport {
  generatedAt: string;
  totals: {
    total: number;
    confirmed: number;
    needsReview: number;
    failed: number;
  };
  verdicts: Verdict[];
  reconciliation: ReconciliationResult;
}

// Cross-check our claimed verdicts against the AMS's authoritative record list.
// Pure (no I/O): the caller fetches the list and passes it in, so this stays
// trivially testable and the failure of the GET itself is handled upstream.
export function reconcile(
  verdicts: Verdict[],
  list: RecordsList | null,
): ReconciliationResult {
  const confirmed = verdicts.filter((v) => v.status === "confirmed");

  // A null list means GET /api/v1/records itself failed — we can't reconcile,
  // so we fail loudly rather than declaring a hollow PASS.
  if (list === null) {
    return {
      pass: false,
      orphanRecordIds: [],
      checks: [
        {
          name: "records list reachable",
          pass: false,
          detail: "GET /api/v1/records failed; cannot verify persisted state",
        },
      ],
    };
  }

  const checks: ReconciliationCheck[] = [];

  // 1) Stored count matches what we claim to have confirmed. Using the actual
  // number of returned rows (not the server's `count` field) as ground truth,
  // and reporting both if they ever disagree.
  const storedCount = list.records.length;
  const countDetail =
    list.count === storedCount
      ? `stored=${storedCount}, confirmed=${confirmed.length}`
      : `stored=${storedCount} (server count=${list.count}), confirmed=${confirmed.length}`;
  checks.push({
    name: "stored count == confirmed count",
    pass: storedCount === confirmed.length,
    detail: countDetail,
  });

  // 2) No duplicate recordIds in the AMS.
  const idCounts = new Map<string, number>();
  for (const rec of list.records) {
    idCounts.set(rec.recordId, (idCounts.get(rec.recordId) ?? 0) + 1);
  }
  const dupIds = [...idCounts.entries()].filter(([, n]) => n > 1).map(([id]) => id);
  checks.push({
    name: "no duplicate recordIds",
    pass: dupIds.length === 0,
    detail: dupIds.length === 0 ? "all recordIds unique" : `duplicates: ${dupIds.join(", ")}`,
  });

  // 3) No duplicate LOGICAL records. The idempotency key isn't stored on the row,
  // so two submissions of the same payload would show up as two rows with an
  // identical canonical body — that's what we detect here.
  const bodyToIds = new Map<string, string[]>();
  for (const rec of list.records) {
    const body = storedRecordCanonicalBody(rec);
    const ids = bodyToIds.get(body) ?? [];
    ids.push(rec.recordId);
    bodyToIds.set(body, ids);
  }
  const dupBodies = [...bodyToIds.values()].filter((ids) => ids.length > 1);
  checks.push({
    name: "no duplicate logical records (by canonical body)",
    pass: dupBodies.length === 0,
    detail:
      dupBodies.length === 0
        ? "every stored record is logically unique"
        : `duplicate bodies across recordIds: ${dupBodies.map((ids) => ids.join("=")).join("; ")}`,
  });

  // 4) Every confirmed verdict's recordId actually exists in the list (the GET
  // /records/:id confirm happened earlier, but this guards against drift), and
  // surface any stored row we never claimed as a confirmed verdict (orphan —
  // e.g. a 503-F persist that recovery somehow missed).
  const storedIds = new Set(list.records.map((r) => r.recordId));
  const missingConfirmed = confirmed
    .map((v) => v.recordId)
    .filter((id): id is string => id !== null && !storedIds.has(id));
  checks.push({
    name: "all confirmed records present in AMS",
    pass: missingConfirmed.length === 0,
    detail:
      missingConfirmed.length === 0
        ? "every confirmed recordId is in the AMS list"
        : `missing from AMS: ${missingConfirmed.join(", ")}`,
  });

  const confirmedIds = new Set(
    confirmed.map((v) => v.recordId).filter((id): id is string => id !== null),
  );
  const orphanRecordIds = list.records
    .map((r) => r.recordId)
    .filter((id) => !confirmedIds.has(id));
  checks.push({
    name: "no orphan records",
    pass: orphanRecordIds.length === 0,
    detail:
      orphanRecordIds.length === 0
        ? "no unclaimed records in the AMS"
        : `unclaimed stored records: ${orphanRecordIds.join(", ")}`,
  });

  return {
    pass: checks.every((c) => c.pass),
    checks,
    orphanRecordIds,
  };
}

// Assemble the machine-readable report object from the run's verdicts + result.
export function buildReport(
  verdicts: Verdict[],
  reconciliation: ReconciliationResult,
): RunReport {
  return {
    generatedAt: new Date().toISOString(),
    totals: {
      total: verdicts.length,
      confirmed: verdicts.filter((v) => v.status === "confirmed").length,
      needsReview: verdicts.filter((v) => v.status === "needs_review").length,
      failed: verdicts.filter((v) => v.status === "failed").length,
    },
    verdicts,
    reconciliation,
  };
}

// Persist run-report.json next to the project root (machine-readable artifact).
export async function writeReport(report: RunReport, path: string): Promise<void> {
  await writeFile(path, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}

// Human-readable console summary: a per-email table, the corrections/flags that
// justify each non-trivial verdict, and the reconciliation PASS/FAIL block.
export function printSummary(report: RunReport, reportPath: string): void {
  const { totals, verdicts, reconciliation } = report;

  console.log("");
  console.log("════════════════════════════════════════════════════════════");
  console.log(" RUN SUMMARY");
  console.log("════════════════════════════════════════════════════════════");

  const rows = verdicts.map((v) => ({
    email: v.email,
    status: statusLabel(v.status),
    recordId: v.recordId ?? "—",
    attempts: String(v.attempts),
    http: v.lastHttpStatus === null ? "—" : String(v.lastHttpStatus),
  }));
  printTable(rows);

  console.log("");
  console.log(
    ` Totals: ${totals.total} email(s) → ${totals.confirmed} confirmed, ` +
      `${totals.needsReview} needs_review, ${totals.failed} failed`,
  );

  // Per-email detail: corrections (overrides), flags (holds), failure reasons,
  // and any recovery warnings — the actionable narrative behind each verdict.
  for (const v of verdicts) {
    const lines = verdictDetailLines(v);
    if (lines.length === 0) continue;
    console.log("");
    console.log(` ${v.email} [${statusLabel(v.status)}]`);
    for (const line of lines) console.log(`   ${line}`);
  }

  console.log("");
  console.log("────────────────────────────────────────────────────────────");
  console.log(` RECONCILIATION: ${reconciliation.pass ? "PASS" : "FAIL"}`);
  console.log("────────────────────────────────────────────────────────────");
  for (const check of reconciliation.checks) {
    console.log(`   [${check.pass ? "✓" : "✗"}] ${check.name} (${check.detail})`);
  }

  console.log("");
  console.log(` Full report written to ${reportPath}`);
  console.log("");
}

function verdictDetailLines(v: Verdict): string[] {
  const lines: string[] = [];
  for (const c of v.corrections) {
    lines.push(
      `correction: ${c.field}: ${formatValue(c.from)} → ${formatValue(c.to)} — ${c.reason}`,
    );
    lines.push(`  evidence: "${c.evidence}"`);
  }
  for (const f of v.flags) {
    lines.push(`flag: ${f.field}: ${f.reason}`);
    lines.push(`  evidence: "${f.evidence}"`);
  }
  if (v.reason !== null) lines.push(`reason: ${v.reason}`);
  for (const w of v.warnings) lines.push(`note: ${w}`);
  return lines;
}

function statusLabel(status: VerdictStatus): string {
  switch (status) {
    case "confirmed":
      return "CONFIRMED";
    case "needs_review":
      return "NEEDS_REVIEW";
    case "failed":
      return "FAILED";
  }
}

function formatValue(value: unknown): string {
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

interface TableRow {
  email: string;
  status: string;
  recordId: string;
  attempts: string;
  http: string;
}

// Minimal fixed-column table; no dependency, just padded columns.
function printTable(rows: TableRow[]): void {
  const headers: TableRow = {
    email: "EMAIL",
    status: "STATUS",
    recordId: "RECORD ID",
    attempts: "ATTEMPTS",
    http: "LAST HTTP",
  };
  const all = [headers, ...rows];
  const widths = {
    email: maxWidth(all, "email"),
    status: maxWidth(all, "status"),
    recordId: maxWidth(all, "recordId"),
    attempts: maxWidth(all, "attempts"),
    http: maxWidth(all, "http"),
  };
  const render = (r: TableRow): string =>
    ` ${pad(r.email, widths.email)}  ${pad(r.status, widths.status)}  ` +
    `${pad(r.recordId, widths.recordId)}  ${pad(r.attempts, widths.attempts)}  ` +
    `${pad(r.http, widths.http)}`;

  console.log("");
  console.log(render(headers));
  console.log(
    ` ${"─".repeat(widths.email)}  ${"─".repeat(widths.status)}  ` +
      `${"─".repeat(widths.recordId)}  ${"─".repeat(widths.attempts)}  ` +
      `${"─".repeat(widths.http)}`,
  );
  for (const r of rows) console.log(render(r));
}

function maxWidth(rows: TableRow[], key: keyof TableRow): number {
  return rows.reduce((max, r) => Math.max(max, r[key].length), 0);
}

function pad(text: string, width: number): string {
  return text.padEnd(width, " ");
}
