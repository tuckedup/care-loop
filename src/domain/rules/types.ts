// Rule engine types. Pure data only: no I/O, no clocks, no randomness, no env reads.
import type { ControlledSchedule } from "../formulary";

export type { ControlledSchedule };

export type RuleId =
  | "R00"
  | "R01"
  | "R02"
  | "R03"
  | "R04"
  | "R05"
  | "R06"
  | "R07"
  | "R08"
  | "R09"
  | "R10"
  | "R11"
  | "R12"
  | "R13"
  | "D01"
  | "D02"
  | "D03";

export type ReasonCode =
  | "INVALID_INPUT"
  | "IDENTITY_NOT_VERIFIED"
  | "NOT_ON_FORMULARY"
  | "CONTROLLED_SUBSTANCE"
  | "NO_ACTIVE_ORDER"
  | "CHANGE_REQUESTED"
  | "REFILL_LIMIT_REACHED"
  | "PHQ9_ITEM9_POSITIVE"
  | "PHQ9_TOTAL_HIGH"
  | "PHQ9_RISE"
  | "PREGNANCY_YES_OR_UNSURE"
  | "SEVERE_SIDE_EFFECT"
  | "MANIA_SCREEN_POSITIVE"
  | "PATIENT_REQUESTED_HUMAN"
  | "LLM_RISK_SIGNAL"
  | "LLM_FAILURE"
  | "TRAZODONE_LIMIT_EXCEEDED"
  | "MIRTAZAPINE_MONITORING_MISSING"
  | "HYDROXYZINE_ALWAYS_ESCALATE";

/** What a failed rule demands. Passed rules have effect null. */
export type RuleEffect = "REJECT" | "ESCALATE" | "FOLLOW_UP_REQUIRED";

/** Shape persisted in EligibilityEvaluated.results (SPEC section 3). */
export interface RuleResult {
  ruleId: RuleId;
  passed: boolean;
  detail: string;
}

/** A RuleResult plus the machine-readable consequence of failing. */
export interface RuleEvaluation extends RuleResult {
  effect: RuleEffect | null;
  reasonCodes: ReasonCode[];
}

export type Outcome =
  | { type: "AUTO_ELIGIBLE" }
  | { type: "ESCALATE"; reasons: ReasonCode[] }
  | { type: "REJECT"; reason: ReasonCode }
  | { type: "FOLLOW_UP_REQUIRED"; reason: ReasonCode };

export type MedicationRequestStatus =
  | "active"
  | "on-hold"
  | "cancelled"
  | "completed"
  | "entered-in-error"
  | "stopped"
  | "draft"
  | "unknown";

export type RequestedChange = "none" | "dose" | "frequency" | "drug" | "other";
export type PregnancyAnswer = "yes" | "no" | "unsure";

export interface MedicationInput {
  rxcui: string | null;
  name: string;
  doseMg: number | null;
  /** Free-form sig frequency; trazodone requires exactly "nightly". */
  frequency: string | null;
  /** null = affirmatively not controlled. Anything else (including undefined) blocks. */
  controlledSchedule: ControlledSchedule | null;
  /** Caller's formulary lookup result (FormularyEntry.id) or null; re-verified by the rules. */
  formularyId: string | null;
}

export interface ActiveOrderInput {
  /** FHIR MedicationRequest.status. */
  status: MedicationRequestStatus;
  /** FHIR MedicationRequest.intent; "order" = clinician order. */
  intent: string;
  rxcui: string | null;
}

export interface CheckInInput {
  phq9: readonly number[];
  gad7: readonly number[];
  pregnancy: PregnancyAnswer;
  severeSideEffect: boolean;
  /** true = positive mania screen. */
  maniaScreen: boolean;
  requestedHuman: boolean;
}

export interface MirtazapineMonitoringInput {
  baselineRecorded: boolean;
  /** Whole months since the baseline; null = unknown. */
  monthsSinceBaseline: number | null;
  sixMonthRecorded: boolean;
}

export type AiResult = { status: "ok"; signals: readonly unknown[] } | { status: "failed" };

export interface RuleInput {
  identityVerified: boolean;
  medication: MedicationInput;
  activeOrder: ActiveOrderInput | null;
  requestedChange: RequestedChange;
  renewalsSinceLastVisit: number;
  /** Config (REFILL_LIMIT, default 2) passed in by the caller; never read here. */
  refillLimit: number;
  checkIn: CheckInInput;
  /** Last recorded PHQ-9 total, or null if none. */
  priorPhq9Total: number | null;
  monitoring: MirtazapineMonitoringInput | null;
  /** undefined = no AI result yet; treated as failure (fail closed). */
  ai?: AiResult | undefined;
}

export const pass = (ruleId: RuleId, detail: string): RuleEvaluation => ({
  ruleId,
  passed: true,
  detail,
  effect: null,
  reasonCodes: [],
});

export const fail = (
  ruleId: RuleId,
  effect: RuleEffect,
  reasonCodes: ReasonCode[],
  detail: string,
): RuleEvaluation => ({ ruleId, passed: false, detail, effect, reasonCodes });
