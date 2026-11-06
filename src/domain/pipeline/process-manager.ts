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
import type { RiskTextInput } from "@/ai/types";
import type { Db } from "@/infra/event-store/types";
import { handleCommand, loadStream } from "../aggregate-handler";
import { parseEvent, type DomainEvent } from "../events";
import { rxStreamId } from "../patient/patient";
import {
  buildRuleInput,
  checkOrderIntegrity,
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

/** Reads (never writes) the history the counters need. Schema-invalid events are ignored. */
async function loadHistory(
  sql: Db,
  patientId: string,
): Promise<HistoryFacts & { checkIns: CheckInFact[] }> {
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
        // A schema-invalid historical event contributes nothing.
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
  const checkIns: CheckInFact[] = [];
  if (renewalIds.length > 0) {
    const byRenewal = `data->>'renewalId' = ANY($2::text[])`;
    for (const r of await read("RenewalApproved", byRenewal, renewalIds)) {
      if (r.event.type === "RenewalApproved") {
        approvals.push({ position: r.position, data: r.event.data });
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
  return { requests, approvals, visitsBooked, notesSigned, checkIns };
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

  // AI gate FIRST. Controlled / unknown / unidentified medications never reach the LLM client.
  let ai: AiRecord;
  let rulesAi: AiResult;
  if (!(isAiPathAllowed(baseInput) && isAiPathPermitted(baseInput))) {
    ai = { status: "not_attempted", reason: "ai_path_blocked" };
    rulesAi = { status: "failed" };
  } else {
    const text: RiskTextInput = {
      freeText: checkIn.data.freeText,
      sideEffects: checkIn.data.sideEffects.join("; "),
    };
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
        signals: [],
        model: deps.ai.model ?? "unset",
        latencyMs: 0,
      };
      rulesAi = { status: "failed" };
    }
  }

  const rules = evaluateEligibility({ ...baseInput, ai: rulesAi });
  const results = [...rules.results, integrityResult(integrity)];
  const reasonCodes: string[] = [...rules.reasonCodes];
  let outcome: RecordEvaluation["evaluation"]["outcome"] = rules.outcome.type;
  let reason: string | undefined;
  if (!integrity.ok) {
    // An inconsistent or missing order is never auto-denied or auto-eligible: a person looks.
    outcome = "ESCALATE";
    reasonCodes.push(order === null ? ORDER_NOT_FOUND : MEDICATION_IDENTITY_MISMATCH);
  } else if (rules.outcome.type === "REJECT") {
    reason = `Not eligible for renewal (${rules.outcome.reason})`;
  } else if (rules.outcome.type === "FOLLOW_UP_REQUIRED") {
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
      aiSignalCount: ai.status === "not_attempted" ? 0 : ai.signals.length,
      integrityCheck: ORDER_INTEGRITY_CHECK,
    },
  });
  if (!handled.appended) return { status: "already_evaluated" };
  return { status: "evaluated", outcome, events: handled.appended.events.map((e) => e.type) };
}

/** Renewals with a check-in but no evaluation yet (oldest first). Used by the catch-up runner. */
export async function findPendingRenewals(sql: Sql, limit = 25): Promise<string[]> {
  const rows = await sql.unsafe<{ renewal_id: string }[]>(
    `SELECT c.data->>'renewalId' AS renewal_id
       FROM events c
      WHERE c.type = 'CheckInSubmitted'
        AND NOT EXISTS (
          SELECT 1 FROM events e
           WHERE e.stream_id = c.stream_id AND e.type = 'EligibilityEvaluated')
      ORDER BY c.global_position ASC
      LIMIT $1`,
    [limit] as never[],
  );
  return rows.map((r) => r.renewal_id).filter((x) => typeof x === "string" && x !== "");
}

/** Catch-up runner: evaluates pending renewals; one failure never blocks the others. */
export async function runPendingEvaluations(
  sql: Sql,
  deps: PipelineDeps,
  limit = 25,
): Promise<{ processed: number; failed: number }> {
  let processed = 0;
  let failed = 0;
  for (const renewalId of await findPendingRenewals(sql, limit)) {
    try {
      const r = await evaluateRenewal(sql, renewalId, deps);
      if (r.status === "evaluated") processed += 1;
    } catch {
      failed += 1; // stays pending for the next run
    }
  }
  return { processed, failed };
}
