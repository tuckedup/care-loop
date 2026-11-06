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

/** Units a dose in a name may use. Only mass units convert; anything else is a mismatch. */
const MASS_TO_MG: Readonly<Record<string, number>> = {
  mg: 1,
  g: 1000,
  mcg: 0.001,
  ug: 0.001,
  µg: 0.001, // micro sign
  μg: 0.001, // Greek mu
};
const UNIT_WORDS = /^(mcg|mg|ug|µg|μg|kg|ml|meq|iu|units?|g|l|%)(?![a-z])/;
const NUMBER_WORDS =
  /\b(zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|half|quarter)\b/;

/**
 * Parses one numeric token. Returns the value, or null when the separators are ambiguous
 * ("1,5", "1.000", "1.000,5"): ambiguity never resolves in the patient's favour.
 */
export function parseAmbiguousNumber(t: string): number | null {
  if (/^\d+$/.test(t)) return Number(t);
  const hasComma = t.includes(",");
  const hasDot = t.includes(".");
  const groups = (sep: string) => t.split(sep);
  const thousands = (sep: string) => {
    const g = groups(sep);
    return g[0]!.length >= 1 && g[0]!.length <= 3 && g.slice(1).every((x) => /^\d{3}$/.test(x));
  };
  if (hasComma && !hasDot) {
    return thousands(",") ? Number(t.replaceAll(",", "")) : null;
  }
  if (hasDot && !hasComma) {
    const g = groups(".");
    if (g.length !== 2 || g[1] === "" || g[1]!.length === 3) return null; // "1.000" is ambiguous
    return Number(t);
  }
  // Both separators: only "1,234.5" (commas as thousands, one trailing dot) is unambiguous.
  const lastComma = t.lastIndexOf(",");
  const lastDot = t.lastIndexOf(".");
  if (lastComma > lastDot) return null;
  const [intPart, frac, ...rest] = t.split(".");
  if (rest.length > 0 || !frac || !intPart) return null;
  const g = intPart.split(",");
  if (!(g[0]!.length >= 1 && g[0]!.length <= 3 && g.slice(1).every((x) => /^\d{3}$/.test(x)))) {
    return null;
  }
  return Number(`${g.join("")}.${frac}`);
}

/**
 * A dose written into the order's name text must equal the structured dose in mg. Reported as a
 * problem (=> escalate): any non-ASCII digit, any number word, an unparseable or ambiguous
 * number, a non-mass unit, or a different amount. Mass units convert exactly (1 g = 1000 mg,
 * 1000 mcg = 1 mg). A bare number is read as mg.
 */
export function doseInNameProblems(drugName: string, doseMg: number): string[] {
  const problems: string[] = [];
  const text = drugName.toLowerCase();
  if (/[^\x00-\x7f]/.test(text) && /\p{N}/u.test(text.replace(/[0-9]/g, ""))) {
    problems.push("name contains non-ASCII digits or numerals");
  }
  if (NUMBER_WORDS.test(text)) problems.push("name contains a number written as a word");
  const re = /\d[\d.,]*\d|\d/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const token = m[0];
    const amount = parseAmbiguousNumber(token);
    const rest = text.slice(m.index + token.length).replace(/^\s*/, "");
    const unit = UNIT_WORDS.exec(rest)?.[1];
    if (amount === null) {
      problems.push(`name has an ambiguous number "${token}"`);
    } else if (unit !== undefined && MASS_TO_MG[unit] === undefined) {
      problems.push(`name has a non-mass unit "${token} ${unit}"`);
    } else {
      const inMg = amount * (unit === undefined ? 1 : MASS_TO_MG[unit]!);
      if (Math.abs(inMg - doseMg) > 1e-9) {
        problems.push(
          `name has ${token}${unit ? ` ${unit}` : ""} but the structured dose is ${doseMg} mg`,
        );
      }
    }
  }
  return problems;
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
  /** Check-ins and denials of the patient's renewals (in-flight counting). Optional for tests. */
  checkIns?: PositionedEvent<{ renewalId: string }>[];
  denials?: PositionedEvent<{ renewalId: string }>[];
  /**
   * Non-empty when the patient's history held schema-invalid events of the kinds the counter
   * reads. The counter is then UNKNOWN (P02): never trust or under-count it.
   */
  unreliable?: string[];
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
  const approved = new Set(
    facts.approvals.filter((a) => mine.has(a.data.renewalId)).map((a) => a.data.renewalId),
  );
  const denied = new Set((facts.denials ?? []).map((d) => d.data.renewalId));
  const counted = facts.approvals.filter(
    (a) => mine.has(a.data.renewalId) && a.position > lastVisit,
  ).length;
  // Conservative in-flight rule: another renewal of the same prescription with a check-in after
  // the last visit that is neither approved (already counted) nor denied counts as one. Two
  // concurrent renewals therefore each see the other and can never both pass below the limit.
  const inFlight = new Set(
    (facts.checkIns ?? [])
      .filter(
        (c) =>
          mine.has(c.data.renewalId) &&
          c.position > lastVisit &&
          !approved.has(c.data.renewalId) &&
          !denied.has(c.data.renewalId),
      )
      .map((c) => c.data.renewalId),
  );
  return counted + inFlight.size;
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

export const COUNTER_CHECK = "P02";

/** P02: the refill counter must be knowable. Unknown history is never treated as zero. */
export function counterResult(facts: Pick<HistoryFacts, "unreliable">): RuleResult {
  const bad = facts.unreliable ?? [];
  return {
    ruleId: COUNTER_CHECK as RuleResult["ruleId"],
    passed: bad.length === 0,
    detail: bad.length === 0 ? "renewal history readable" : `unreadable history: ${bad.join("; ")}`,
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
