// Renewal decision process manager (F036). After CheckInSubmitted it:
//   1. builds the RuleInput from the patient / prescribed order / renewal history,
//   2. consults the AI gate (isAiPathAllowed AND isAiPathPermitted) BEFORE any LLM call,
//   3. runs the fail-closed extraction with an INJECTED client (real client only via env),
//   4. runs the deterministic rules (evaluateEligibility) plus a pipeline order-integrity check,
//   5. records the result through the review aggregate (RecordEvaluation) in ONE audited append.
// It never emits RenewalApproved: AUTO_ELIGIBLE awaits a clinician until autonomy modes (F059).
// The LLM result is data handed to the rules; it can only add escalation signals.
import type { Sql } from "postgres";
import { isAiPathPermitted } from "@/ai/ai-path-gate";
import { runRiskExtraction, toRulesAiResult, type RunRiskDeps } from "@/ai/fail-closed";
import { detectInjection } from "@/ai/injection";
import { detectTripwire } from "@/ai/tripwire";
import type { RiskTextInput } from "@/ai/types";
import type { VerifiedSignal } from "@/ai/verify-quotes";
import type { Db } from "@/infra/event-store/types";
import { handleCommand, loadStream } from "../aggregate-handler";
import { parseEvent, type DomainEvent } from "../events";
import { rxStreamId } from "../patient/patient";
import {
  buildRuleInput,
  checkOrderIntegrity,
  COUNTER_CHECK,
  counterResult,
  countRenewalsSinceLastVisit,
  integrityResult,
  MEDICATION_IDENTITY_MISMATCH,
  ORDER_INTEGRITY_CHECK,
  ORDER_NOT_FOUND,
  priorPhq9TotalFrom,
  type HistoryFacts,
  type PositionedEvent,
  type PrescribedOrder,
} from "../renewal/decision";
import { renewalStreamId } from "../renewal/renewal";
import { reviewAggregate, type AiRecord, type RecordEvaluation } from "../renewal/review";
import { evaluateEligibility, isAiPathAllowed, type AiResult } from "../rules";

export const DEFAULT_REFILL_LIMIT = 2;
export const REFILL_COUNT_UNKNOWN = "REFILL_COUNT_UNKNOWN";
const SYSTEM_ACTOR = "system:decision-pipeline";

export interface PipelineDeps {
  /** Injected AI deps. Tests pass a recorded client; production uses riskDepsFromEnv(). */
  ai: RunRiskDeps;
  /** Injected clock (monitoring-interval maths only). */
  now?: () => Date;
  /** Config REFILL_LIMIT; the rules never read env. */
  refillLimit?: number;
}

export type PipelineResult =
  | { status: "evaluated"; outcome: string; events: string[] }
  | { status: "already_evaluated" }
  | { status: "not_ready"; reason: string };

type CheckInFact = PositionedEvent<{ renewalId: string; phq9: readonly number[] }>;

/**
 * Reads (never writes) the history the refill counter needs. A schema-invalid event of a kind the
 * counter reads makes the counter UNKNOWN (reported in `unreliable`, check P02): it is never
 * skipped silently, because skipping could under-count.
 */
async function loadHistory(
  sql: Db,
  patientId: string,
): Promise<HistoryFacts & { checkIns: CheckInFact[]; unreliable: string[] }> {
  const unreliable: string[] = [];
  const read = async (type: string, where: string, param: unknown) => {
    const rows = await sql.unsafe<{ global_position: string; type: string; data: unknown }[]>(
      `SELECT global_position, type, data FROM events WHERE type = $1 AND ${where}
       ORDER BY global_position ASC`,
      [type, param] as never[],
    );
    const out: { position: bigint; event: DomainEvent }[] = [];
    for (const r of rows) {
      try {
        out.push({
          position: BigInt(r.global_position),
          event: parseEvent({ type: r.type, data: r.data }),
        });
      } catch {
        unreliable.push(`${type} at position ${r.global_position} is schema-invalid`);
      }
    }
    return out;
  };

  const requests: HistoryFacts["requests"] = [];
  for (const r of await read("RenewalRequested", `data->>'patientId' = $2`, patientId)) {
    if (r.event.type === "RenewalRequested") {
      requests.push({ position: r.position, data: r.event.data });
    }
  }
  const renewalIds = requests.map((r) => r.data.renewalId);
  const approvals: HistoryFacts["approvals"] = [];
  const denials: NonNullable<HistoryFacts["denials"]> = [];
  const checkIns: CheckInFact[] = [];
  if (renewalIds.length > 0) {
    const byRenewal = `data->>'renewalId' = ANY($2::text[])`;
    for (const r of await read("RenewalApproved", byRenewal, renewalIds)) {
      if (r.event.type === "RenewalApproved") {
        approvals.push({ position: r.position, data: r.event.data });
      }
    }
    for (const r of await read("RenewalDenied", byRenewal, renewalIds)) {
      if (r.event.type === "RenewalDenied") {
        denials.push({ position: r.position, data: { renewalId: r.event.data.renewalId } });
      }
    }
    for (const r of await read("CheckInSubmitted", byRenewal, renewalIds)) {
      if (r.event.type === "CheckInSubmitted") {
        checkIns.push({
          position: r.position,
          data: { renewalId: r.event.data.renewalId, phq9: r.event.data.phq9 },
        });
      }
    }
  }
  const visitsBooked: HistoryFacts["visitsBooked"] = [];
  for (const r of await read("VisitBooked", `data->>'patientId' = $2`, patientId)) {
    if (r.event.type === "VisitBooked") {
      visitsBooked.push({ position: r.position, data: r.event.data });
    }
  }
  const notesSigned: HistoryFacts["notesSigned"] = [];
  const visitIds = visitsBooked.map((v) => v.data.visitId);
  if (visitIds.length > 0) {
    for (const r of await read("VisitNoteSigned", `data->>'visitId' = ANY($2::text[])`, visitIds)) {
      if (r.event.type === "VisitNoteSigned") {
        notesSigned.push({ position: r.position, data: r.event.data });
      }
    }
  }
  return { requests, approvals, visitsBooked, notesSigned, checkIns, denials, unreliable };
}

function toAiRecord(
  r: Awaited<ReturnType<typeof runRiskExtraction>>,
  model: string | undefined,
  latencyMs: number,
): AiRecord {
  const m = model && model.trim() !== "" ? model : "unset";
  return r.status === "ok"
    ? { status: "ok", signals: r.signals, model: m, latencyMs }
    : { status: "failed", reason: r.reason, signals: r.localSignals ?? [], model: m, latencyMs };
}

/**
 * Evaluates one renewal whose check-in has been submitted. Idempotent: a renewal that already has
 * an evaluation is left untouched (no duplicate events, no second LLM call). The final append goes
 * through handleCommand: expectedVersion from the loaded stream, one reload-and-retry on conflict,
 * and the aggregate itself decides nothing when the renewal was evaluated in the meantime.
 */
export async function evaluateRenewal(
  sql: Sql,
  renewalId: string,
  deps: PipelineDeps,
): Promise<PipelineResult> {
  const now = (deps.now ?? (() => new Date()))();
  const stream = await loadStream(sql, renewalStreamId(renewalId));
  const requested = stream.events.find((e) => e.type === "RenewalRequested");
  const checkIn = stream.events.find((e) => e.type === "CheckInSubmitted");
  if (!requested || requested.type !== "RenewalRequested") {
    return { status: "not_ready", reason: "renewal not requested" };
  }
  if (!checkIn || checkIn.type !== "CheckInSubmitted") {
    return { status: "not_ready", reason: "check-in not submitted" };
  }
  if (stream.events.some((e) => e.type === "EligibilityEvaluated")) {
    return { status: "already_evaluated" };
  }
  const { patientId, prescriptionId } = requested.data;
  const identityVerified = stream.events.some((e) => e.type === "IdentityVerified");

  // The prescribed order is the ONE structured source for medication name, dose and schedule.
  let order: PrescribedOrder | null = null;
  const rx = await loadStream(sql, rxStreamId(prescriptionId));
  const prescribed = rx.events.find((e) => e.type === "MedicationPrescribed");
  if (prescribed && prescribed.type === "MedicationPrescribed") order = prescribed.data;

  const history = await loadHistory(sql, patientId);
  const integrity = checkOrderIntegrity(order, { patientId, prescriptionId });
  const baseInput = buildRuleInput({
    renewalId,
    identityVerified,
    order,
    checkIn: checkIn.data,
    renewalsSinceLastVisit: countRenewalsSinceLastVisit(
      history,
      patientId,
      prescriptionId,
      renewalId,
    ),
    refillLimit: deps.refillLimit ?? DEFAULT_REFILL_LIMIT,
    priorPhq9Total: priorPhq9TotalFrom(history.checkIns, renewalId),
    now,
  });

  // AI gate FIRST. Controlled / unknown / unidentified medications, and any renewal whose order
  // fails the integrity check, never reach the LLM client.
  const text: RiskTextInput = {
    freeText: checkIn.data.freeText,
    sideEffects: checkIn.data.sideEffects.join("; "),
  };
  // Local tripwire + injection scan: pure deterministic code (not an LLM) that only ADDS escalation signals. It runs
  // even when the AI path is blocked, so a safety phrase is never lost behind an admin REJECT.
  let localSignals: VerifiedSignal[] = [];
  const extraEscalationCodes: string[] = [];
  try {
    localSignals = [...detectTripwire(text), ...detectInjection(text)];
  } catch {
    extraEscalationCodes.push("LOCAL_SAFETY_SCAN_FAILED");
  }

  let ai: AiRecord;
  let rulesAi: AiResult;
  const gateOpen = integrity.ok && isAiPathAllowed(baseInput) && isAiPathPermitted(baseInput);
  if (!gateOpen) {
    ai = {
      status: "not_attempted",
      reason: integrity.ok ? "ai_path_blocked" : "order_integrity",
      signals: localSignals,
    };
    rulesAi = { status: "failed" };
  } else {
    const started = Date.now();
    try {
      const result = await runRiskExtraction(baseInput, text, deps.ai);
      ai = toAiRecord(result, deps.ai.model, Date.now() - started);
      rulesAi = toRulesAiResult(result);
    } catch {
      // runRiskExtraction never throws; if it ever does, fail closed.
      ai = {
        status: "failed",
        reason: "llm_error",
        signals: localSignals,
        model: deps.ai.model ?? "unset",
        latencyMs: 0,
      };
      rulesAi = { status: "failed" };
    }
  }

  const rules = evaluateEligibility({ ...baseInput, ai: rulesAi });
  const counter = counterResult(history);
  const results = [...rules.results, integrityResult(integrity), counter];
  // A blocked AI path is not an "LLM failure": say what actually happened.
  const reasonCodes: string[] = rules.reasonCodes.flatMap((c) =>
    ai.status === "not_attempted" && c === "LLM_FAILURE" ? ["AI_PATH_BLOCKED"] : [c],
  );
  // The rules' outcome is kept as is (a REJECT stays a REJECT). Pipeline-level problems are
  // separate facts (failed P01/P02 results + reason codes) that force an ESCALATION.
  let outcome: RecordEvaluation["evaluation"]["outcome"] = rules.outcome.type;
  let reason: string | undefined;
  if (!integrity.ok) {
    reasonCodes.push(order === null ? ORDER_NOT_FOUND : MEDICATION_IDENTITY_MISMATCH);
  }
  if (!counter.passed) reasonCodes.push(REFILL_COUNT_UNKNOWN);
  if ((!integrity.ok || !counter.passed) && outcome !== "REJECT") outcome = "ESCALATE";
  if (rules.outcome.type === "REJECT") {
    reason = `Not eligible for renewal (${rules.outcome.reason})`;
  } else if (outcome === "FOLLOW_UP_REQUIRED" && rules.outcome.type === "FOLLOW_UP_REQUIRED") {
    reason = `A follow-up visit is required before renewal (${rules.outcome.reason})`;
  }

  const command: RecordEvaluation = {
    type: "RecordEvaluation",
    renewalId,
    patientId,
    ai,
    evaluation: {
      outcome,
      results,
      reasonCodes: [...new Set(reasonCodes)],
      ...(reason ? { reason } : {}),
    },
    extraEscalationCodes,
  };
  const handled = await handleCommand(sql, reviewAggregate, renewalStreamId(renewalId), command, {
    actor: SYSTEM_ACTOR,
    role: "system",
    action: "system:RecordEvaluation",
    detail: {
      renewalId,
      outcome,
      aiStatus: ai.status,
      ...(ai.status !== "ok" ? { aiReason: ai.reason } : {}),
      aiSignalCount: ai.signals?.length ?? 0,
      integrityCheck: ORDER_INTEGRITY_CHECK,
      counterCheck: COUNTER_CHECK,
    },
  });
  if (!handled.appended) return { status: "already_evaluated" };
  return { status: "evaluated", outcome, events: handled.appended.events.map((e) => e.type) };
}

export interface PendingRenewal {
  renewalId: string;
  position: bigint;
}

/** Renewals with a check-in but no evaluation yet, oldest first, after a cursor position. */
export async function findPendingAfter(
  sql: Sql,
  opts: { limit?: number; afterPosition?: bigint } = {},
): Promise<PendingRenewal[]> {
  // The renewal id comes from the stream id, so a stream whose check-in payload is corrupt is
  // still found (and reported) instead of silently dropping out of the catch-up.
  const rows = await sql.unsafe<{ renewal_id: string; position: string }[]>(
    `SELECT substr(c.stream_id, 9) AS renewal_id, min(c.global_position)::text AS position
       FROM events c
      WHERE c.type = 'CheckInSubmitted'
        AND c.stream_id LIKE 'renewal-%'
        AND NOT EXISTS (
          SELECT 1 FROM events e
           WHERE e.stream_id = c.stream_id AND e.type = 'EligibilityEvaluated')
      GROUP BY c.stream_id
     HAVING min(c.global_position) > $2::bigint
      ORDER BY min(c.global_position) ASC
      LIMIT $1`,
    [opts.limit ?? 25, (opts.afterPosition ?? 0n).toString()] as never[],
  );
  return rows
    .filter((r) => r.renewal_id !== "")
    .map((r) => ({ renewalId: r.renewal_id, position: BigInt(r.position) }));
}

/**
 * Best-effort fail-closed marker for a renewal the pipeline could not evaluate: appends
 * RenewalEscalated{PIPELINE_ERROR} through the review aggregate (which only ever adds an
 * escalation). Returns false if even that was impossible (e.g. an unparseable stream).
 */
export async function markPipelineError(sql: Sql, renewalId: string): Promise<boolean> {
  try {
    await handleCommand(
      sql,
      reviewAggregate,
      renewalStreamId(renewalId),
      { type: "EscalatePipelineError", renewalId },
      {
        actor: SYSTEM_ACTOR,
        role: "system",
        action: "system:EscalatePipelineError",
        detail: { renewalId },
      },
    );
    return true;
  } catch {
    return false;
  }
}

/** Renewal ids with a check-in but no evaluation yet (oldest first). */
export async function findPendingRenewals(sql: Sql, limit = 25): Promise<string[]> {
  return (await findPendingAfter(sql, { limit })).map((p) => p.renewalId);
}

export interface PendingRunStats {
  processed: number;
  failed: number;
  /** Renewal ids (opaque uuids, no PHI) that failed this run. */
  failedIds: string[];
  /** Failures that could not even be marked on the stream (logged with a non-PHI code). */
  unmarked: number;
}

/**
 * Catch-up runner. Each renewal runs in its own try/catch and a cursor moves past failures, so a
 * poison renewal can neither stop the run nor starve the ones behind it. Failures are escalated
 * (best effort) and reported; nothing is silent.
 */
export async function runPendingEvaluations(
  sql: Sql,
  deps: PipelineDeps,
  limit = 25,
): Promise<PendingRunStats> {
  const stats: PendingRunStats = { processed: 0, failed: 0, failedIds: [], unmarked: 0 };
  let cursor = 0n;
  for (let page = 0; page < 50 && stats.processed < limit; page += 1) {
    const batch = await findPendingAfter(sql, { limit, afterPosition: cursor });
    if (batch.length === 0) break;
    for (const p of batch) {
      cursor = p.position > cursor ? p.position : cursor;
      try {
        const r = await evaluateRenewal(sql, p.renewalId, deps);
        if (r.status === "evaluated") stats.processed += 1;
      } catch {
        stats.failed += 1;
        stats.failedIds.push(p.renewalId);
        if (!(await markPipelineError(sql, p.renewalId))) {
          stats.unmarked += 1;
          console.error("PIPELINE_ERROR_UNMARKED", p.renewalId);
        }
      }
    }
  }
  return stats;
}
