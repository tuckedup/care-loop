// Pure building blocks of the renewal decision process manager (F036).
// Nothing here does I/O, reads a clock or calls the LLM; the orchestrator is
// src/domain/pipeline/process-manager.ts. The medication NAME and DOSE both come from ONE
// structured source, the prescribed order (MedicationPrescribed), so they cannot disagree.
import { findByRxcui, type FormularyEntry } from "../formulary";
import type { EventData } from "../events";
import { scorePhq9 } from "../rules/scoring";
import type {
  CheckInInput,
  MirtazapineMonitoringInput,
  RuleInput,
  RuleResult,
} from "../rules/types";

export type PrescribedOrder = EventData<"MedicationPrescribed">;

/** Pipeline-level (non-rule) check id persisted next to the rule results. */
export const ORDER_INTEGRITY_CHECK = "P01";
/** Reason codes added by the pipeline itself (same vocabulary as the rules where one exists). */
export const MEDICATION_IDENTITY_MISMATCH = "MEDICATION_IDENTITY_MISMATCH";
export const ORDER_NOT_FOUND = "ORDER_NOT_FOUND";

/** Sig frequency string the rules understand: exactly "nightly" for one nightly dose. */
export function frequencyText(f: PrescribedOrder["frequency"]): string {
  if (f.timing === "nightly" && f.timesPerDay === 1) return "nightly";
  return `${f.timesPerDay}x per day, ${f.timing}`;
}

/** Resolve a unique formulary id from the order, else null (the rules re-verify by RxCUI). */
export function formularyIdFor(order: Pick<PrescribedOrder, "rxcui" | "drugName">): string | null {
  const entries: readonly FormularyEntry[] = findByRxcui(order.rxcui);
  if (entries.length === 1) return entries[0]!.id;
  return null;
}

const NUMBER = /\d+(?:[.,]\d+)?/g;

/**
 * If the order's name text carries a number (a dose written into the name), it must equal the
 * structured dose. Any other number disagrees and is reported. Fullwidth and other compatibility
 * digits are folded first (NFKC); non-ASCII leftovers are M01's job.
 */
export function doseInNameProblems(drugName: string, doseMg: number): string[] {
  const folded = drugName.normalize("NFKC");
  const found = folded.match(NUMBER) ?? [];
  const bad = found.filter((t) => Number(t.replace(",", ".")) !== doseMg);
  return bad.length > 0
    ? [
        `order name "${drugName}" contains ${bad.join(", ")} but the structured dose is ${doseMg} mg`,
      ]
    : [];
}

export interface OrderIntegrity {
  ok: boolean;
  problems: string[];
}

/** Checks that the order exists, belongs to the renewing patient, and is self-consistent. */
export function checkOrderIntegrity(
  order: PrescribedOrder | null,
  expected: { patientId: string; prescriptionId: string },
): OrderIntegrity {
  const problems: string[] = [];
  if (order === null) {
    problems.push("prescribed order not found for this renewal");
  } else {
    if (order.patientId !== expected.patientId) problems.push("order belongs to another patient");
    if (order.prescriptionId !== expected.prescriptionId) {
      problems.push("order id does not match the renewal's prescription");
    }
    problems.push(...doseInNameProblems(order.drugName, order.dose.amountMg));
  }
  return { ok: problems.length === 0, problems };
}

/** Whole calendar months from an ISO date to `now`; negative if the date is in the future. */
export function wholeMonthsBetween(fromIsoDate: string, now: Date): number {
  const from = new Date(`${fromIsoDate}T00:00:00Z`);
  let months =
    (now.getUTCFullYear() - from.getUTCFullYear()) * 12 + (now.getUTCMonth() - from.getUTCMonth());
  if (now.getUTCDate() < from.getUTCDate()) months -= 1;
  return months;
}

export function monitoringFrom(
  order: PrescribedOrder | null,
  now: Date,
): MirtazapineMonitoringInput | null {
  const m = order?.metabolicMonitoring;
  if (!m) return null;
  return {
    baselineRecorded: m.baselineAt !== undefined,
    monthsSinceBaseline: m.baselineAt !== undefined ? wholeMonthsBetween(m.baselineAt, now) : null,
    sixMonthRecorded: m.lastSixMonthAt !== undefined,
  };
}

/** A recorded event with its global position, as read from the store. */
export interface PositionedEvent<T = unknown> {
  position: bigint;
  data: T;
}

export interface HistoryFacts {
  requests: PositionedEvent<EventData<"RenewalRequested">>[];
  approvals: PositionedEvent<EventData<"RenewalApproved">>[];
  visitsBooked: PositionedEvent<EventData<"VisitBooked">>[];
  notesSigned: PositionedEvent<EventData<"VisitNoteSigned">>[];
}

/**
 * Renewals approved for this patient and prescription since the patient's last signed visit
 * note (F036: incremented on RenewalApproved, reset on VisitNoteSigned). The current renewal is
 * never counted. A VisitNoteSigned counts as the patient's only if its visit was booked for them.
 */
export function countRenewalsSinceLastVisit(
  facts: HistoryFacts,
  patientId: string,
  prescriptionId: string,
  currentRenewalId: string,
): number {
  const visitPatient = new Map(facts.visitsBooked.map((v) => [v.data.visitId, v.data.patientId]));
  let lastVisit = -1n;
  for (const n of facts.notesSigned) {
    if (visitPatient.get(n.data.visitId) === patientId && n.position > lastVisit) {
      lastVisit = n.position;
    }
  }
  const mine = new Set(
    facts.requests
      .filter(
        (r) =>
          r.data.patientId === patientId &&
          r.data.prescriptionId === prescriptionId &&
          r.data.renewalId !== currentRenewalId,
      )
      .map((r) => r.data.renewalId),
  );
  return facts.approvals.filter((a) => mine.has(a.data.renewalId) && a.position > lastVisit).length;
}

/** Last PHQ-9 total from the patient's earlier check-ins (before the current one), or null. */
export function priorPhq9TotalFrom(
  checkIns: PositionedEvent<{ renewalId: string; phq9: readonly number[] }>[],
  currentRenewalId: string,
): number | null {
  let best: { position: bigint; total: number } | null = null;
  for (const c of checkIns) {
    if (c.data.renewalId === currentRenewalId) continue;
    const total = scorePhq9(c.data.phq9);
    if (total === null) continue;
    if (best === null || c.position > best.position) best = { position: c.position, total };
  }
  return best?.total ?? null;
}

export interface RuleInputSources {
  renewalId: string;
  identityVerified: boolean;
  order: PrescribedOrder | null;
  checkIn: EventData<"CheckInSubmitted">;
  renewalsSinceLastVisit: number;
  refillLimit: number;
  priorPhq9Total: number | null;
  now: Date;
}

/** RuleInput WITHOUT the AI result (added once the AI gate has been consulted). */
export function buildRuleInput(src: RuleInputSources): RuleInput {
  const { order, checkIn } = src;
  const checkInInput: CheckInInput = {
    phq9: checkIn.phq9,
    gad7: checkIn.gad7,
    pregnancy: checkIn.pregnancy,
    severeSideEffect: checkIn.severeSideEffect,
    maniaScreen: checkIn.maniaScreen,
    requestedHuman: checkIn.requestedHuman,
  };
  return {
    identityVerified: src.identityVerified,
    medication: order
      ? {
          rxcui: order.rxcui,
          name: order.drugName,
          doseMg: order.dose.amountMg,
          frequency: frequencyText(order.frequency),
          controlledSchedule: order.controlledSchedule,
          formularyId: formularyIdFor(order),
        }
      : // Unknown order: undefined schedule is treated as controlled by the rules (fail closed).
        {
          rxcui: null,
          name: "",
          doseMg: null,
          frequency: null,
          controlledSchedule: "unknown" as never,
          formularyId: null,
        },
    activeOrder: order ? { status: "active", intent: "order", rxcui: order.rxcui } : null,
    requestedChange: checkIn.requestedChange,
    renewalsSinceLastVisit: src.renewalsSinceLastVisit,
    refillLimit: src.refillLimit,
    checkIn: checkInInput,
    priorPhq9Total: src.priorPhq9Total,
    monitoring: monitoringFrom(order, src.now),
  };
}

/** The persisted result row for the pipeline's own order-integrity check. */
export function integrityResult(integrity: OrderIntegrity): RuleResult {
  return {
    // RuleId is a closed union in the rules; the event schema accepts any non-empty string.
    ruleId: ORDER_INTEGRITY_CHECK as RuleResult["ruleId"],
    passed: integrity.ok,
    detail: integrity.ok ? "order name, dose and owner consistent" : integrity.problems.join("; "),
  };
}
