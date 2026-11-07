// Eval case schema (SPEC section 10): {id, scenario, input, med, history, expected}.
// Cases are HAND-LABELED by a human from the SPEC rules text. Never label from model or code output.
import { z } from "zod";
import type { ReasonCode } from "../src/domain/rules";

export const REASON_CODES = [
  "INVALID_INPUT",
  "MEDICATION_IDENTITY_MISMATCH",
  "DOSE_FORM_NOT_ALLOWLISTED",
  "IDENTITY_NOT_VERIFIED",
  "NOT_ON_FORMULARY",
  "CONTROLLED_SUBSTANCE",
  "NO_ACTIVE_ORDER",
  "CHANGE_REQUESTED",
  "REFILL_LIMIT_REACHED",
  "PHQ9_ITEM9_POSITIVE",
  "PHQ9_TOTAL_HIGH",
  "PHQ9_RISE",
  "PREGNANCY_YES_OR_UNSURE",
  "SEVERE_SIDE_EFFECT",
  "MANIA_SCREEN_POSITIVE",
  "PATIENT_REQUESTED_HUMAN",
  "LLM_RISK_SIGNAL",
  "LLM_FAILURE",
  "TRAZODONE_LIMIT_EXCEEDED",
  "MIRTAZAPINE_MONITORING_MISSING",
  "HYDROXYZINE_ALWAYS_ESCALATE",
] as const satisfies readonly ReasonCode[];

// Compile-time exhaustiveness: errors if ReasonCode gains a member missing from REASON_CODES.
type Missing = Exclude<ReasonCode, (typeof REASON_CODES)[number]>;
export const reasonCodesExhaustive: [Missing] extends [never] ? true : never = true;

const phq9 = z.array(z.number().int().min(0).max(3)).length(9);
const gad7 = z.array(z.number().int().min(0).max(3)).length(7);

export const CheckInSubmittedSchema = z
  .object({
    phq9,
    gad7,
    sideEffects: z.string().default(""),
    severeSideEffect: z.boolean(),
    pregnancy: z.enum(["yes", "no", "unsure"]),
    maniaScreen: z.boolean(),
    freeText: z.string(),
    requestedHuman: z.boolean(),
    requestedChange: z.enum(["none", "dose", "frequency", "drug", "other"]),
  })
  .strict();

export const MedSchema = z
  .object({
    rxcui: z.string().nullable(),
    name: z.string(),
    doseMg: z.number().nullable(),
    frequency: z.string().nullable(),
    controlledSchedule: z.enum(["II", "III", "IV", "V"]).nullable(),
    formularyId: z.string().nullable(),
  })
  .strict();

export const HistorySchema = z
  .object({
    identityVerified: z.boolean(),
    activeOrder: z
      .object({ status: z.string(), intent: z.string(), rxcui: z.string().nullable() })
      .strict()
      .nullable(),
    renewalsSinceLastVisit: z.number().int().min(0),
    refillLimit: z.number().int().min(0),
    priorPhq9Total: z.number().int().min(0).max(27).nullable(),
    monitoring: z
      .object({
        baselineRecorded: z.boolean(),
        monthsSinceBaseline: z.number().int().min(0).nullable(),
        sixMonthRecorded: z.boolean(),
      })
      .strict()
      .nullable(),
  })
  .strict();

export const OUTCOME_TYPES = ["AUTO_ELIGIBLE", "ESCALATE", "REJECT", "FOLLOW_UP_REQUIRED"] as const;

export const EvalCaseSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
    scenario: z.string().min(1),
    /** Risk category for coverage accounting (free label, e.g. "suicidality", "pregnancy"). */
    category: z.string().min(1),
    /** Hand-labeling provenance: which SPEC section 4 rules the label was derived from. */
    labeledFrom: z.string().min(1),
    /** Marks a case whose phrasing is deliberately evasive (indirect, sarcastic, buried, encoded...). */
    adversarial: z.boolean().optional(),
    input: CheckInSubmittedSchema,
    med: MedSchema,
    history: HistorySchema,
    /**
     * Name of an AI fixture file (evals/fixtures/<name>.json) supplying the canned model
     * response for this case. Absent = rules-only case (AI result is ok with no signals).
     */
    aiFixture: z
      .string()
      .regex(/^[a-z0-9][a-z0-9-]*$/)
      .optional(),
    expected: z
      .object({
        outcome: z.enum(OUTCOME_TYPES),
        /** Every reason code of every failed rule (set comparison). Empty for AUTO_ELIGIBLE. */
        reasonCodes: z.array(z.enum(REASON_CODES)),
      })
      .strict(),
  })
  .strict();

export type EvalCase = z.infer<typeof EvalCaseSchema>;

/**
 * Patient-risk categories (SPEC section 10 hard cases plus the structured escalation triggers).
 * A case is a RISK case when its `category` is in this list. Every risk category needs at least
 * three cases including one adversarial phrasing (enforced by scripts/evals-count.test.ts).
 */
export const RISK_CATEGORIES = [
  "suicidality",
  "buried-suicidal-ideation",
  "sarcasm-gallows-humour",
  "passive-ideation-indirect",
  "self-harm",
  "harm-to-others",
  "pregnancy",
  "mania",
  "severe-side-effect",
  "disguised-dose-change",
  "contradictory-answers",
  "requested-human",
  "prompt-injection",
  "controlled-substance",
] as const;

export const isRiskCategory = (category: string): boolean =>
  (RISK_CATEGORIES as readonly string[]).includes(category);
