// Pure presentation helpers for the clinician UI. No I/O; unit-tested. These only DESCRIBE
// state that the rules / projections already decided; they never decide anything clinical.
import type { DomainEvent } from "@/domain/events";
import { phq9Item9, scoreGad7, scorePhq9 } from "@/domain/rules/scoring";

/** Plain-language labels for escalation reason codes. Unknown codes are shown verbatim. */
const REASON_LABELS: Record<string, string> = {
  PHQ9_ITEM9_POSITIVE: "PHQ-9 item 9 positive (thoughts of self-harm)",
  PHQ9_TOTAL_HIGH: "PHQ-9 total high",
  PHQ9_RISE: "PHQ-9 rise since last check-in",
  CONTROLLED_SUBSTANCE: "Controlled substance",
  LLM_RISK_SIGNAL: "Risk signal in free text",
  LLM_FAILURE: "AI check unavailable (escalated by default)",
  SEVERE_SIDE_EFFECT: "Severe side effect reported",
  MANIA_SCREEN_POSITIVE: "Mania screen positive",
  PREGNANCY_YES_OR_UNSURE: "Pregnancy yes or unsure",
  PATIENT_REQUESTED_HUMAN: "Patient asked for a human",
  REFILL_LIMIT_REACHED: "Refill limit reached since last visit",
  CHANGE_REQUESTED: "Patient requested a change",
  NO_ACTIVE_ORDER: "No active order",
  NOT_ON_FORMULARY: "Not on formulary",
  IDENTITY_NOT_VERIFIED: "Identity not verified",
  MEDICATION_IDENTITY_MISMATCH: "Medication identity mismatch",
  ORDER_NOT_FOUND: "Prescribed order not found",
  DOSE_FORM_NOT_ALLOWLISTED: "Dose/form not allowlisted",
  TRAZODONE_LIMIT_EXCEEDED: "Trazodone limit exceeded",
  MIRTAZAPINE_MONITORING_MISSING: "Mirtazapine monitoring missing",
  HYDROXYZINE_ALWAYS_ESCALATE: "Hydroxyzine always escalates",
  PIPELINE_ERROR: "Decision pipeline error (escalated by default)",
  INVALID_INPUT: "Invalid input",
};

export const reasonLabel = (code: string): string => REASON_LABELS[code] ?? code;
export const isItem9Code = (code: string): boolean => code === "PHQ9_ITEM9_POSITIVE";

/** Rules whose failure means approval is impossible (mirrors review.ts HARD_BLOCK_RULES). */
export const HARD_BLOCK_RULE_IDS: readonly string[] = ["R01", "R02", "R03"];

export interface ApprovalFacts {
  outcome: string | null;
  reasonCodes: readonly string[];
  failedRuleIds: readonly string[];
}

/**
 * Why the Approve button must be disabled, or null if approval is allowed to be attempted.
 * This MIRRORS the aggregate's refusals for explanation only; the server always re-checks.
 */
export function approvalBlock(f: ApprovalFacts): string | null {
  if (f.failedRuleIds.includes("R03") || f.reasonCodes.includes("CONTROLLED_SUBSTANCE")) {
    return "Controlled substances cannot be approved here.";
  }
  if (f.outcome === "REJECT" || f.failedRuleIds.some((r) => HARD_BLOCK_RULE_IDS.includes(r))) {
    return "The rules rejected this renewal (identity, formulary or order check). It can be denied or followed up with a visit, not approved.";
  }
  if (f.outcome === "FOLLOW_UP_REQUIRED") {
    return "A follow-up visit is required before renewal. Book a visit or deny.";
  }
  return null;
}

export type QueueLabel =
  "escalated" | "awaiting_evaluation" | "needs_decision" | "in_review" | "done";

export interface SparkGeometry {
  points: { x: number; y: number; value: number }[];
  path: string;
}

/** Maps a series onto a w x h box (y inverted, 0..max). Null values are skipped. */
export function sparkGeometry(
  values: readonly (number | null)[],
  max: number,
  w: number,
  h: number,
  pad = 4,
): SparkGeometry {
  const n = values.length;
  const pts: SparkGeometry["points"] = [];
  values.forEach((v, i) => {
    if (v === null) return;
    const x = n === 1 ? w / 2 : pad + (i * (w - 2 * pad)) / (n - 1);
    const y = pad + (1 - Math.min(Math.max(v, 0), max) / max) * (h - 2 * pad);
    pts.push({ x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10, value: v });
  });
  return { points: pts, path: pts.map((p, i) => `${i === 0 ? "M" : "L"}${p.x} ${p.y}`).join(" ") };
}

export const eventSourceId = (globalPosition: bigint | number | string): string =>
  `evt-${String(globalPosition)}`;

const clip = (s: string, n = 300) => (s.length > n ? `${s.slice(0, n)}...` : s);

/** One-line, fact-only description of an event, used for the source list and the AI summary. */
export function describeEvent(e: DomainEvent): string {
  switch (e.type) {
    case "RenewalRequested":
      return `Renewal requested for prescription ${e.data.prescriptionId}.`;
    case "IdentityVerified":
      return `Identity verified (${e.data.method}).`;
    case "CheckInSubmitted": {
      const d = e.data;
      const parts = [
        `PHQ-9 total ${scorePhq9(d.phq9) ?? "invalid"}, item 9 = ${phq9Item9(d.phq9) ?? "invalid"}`,
        `GAD-7 total ${scoreGad7(d.gad7) ?? "invalid"}`,
        `side effects: ${d.sideEffects.length ? d.sideEffects.join("; ") : "none"}`,
        `severe side effect: ${d.severeSideEffect ? "yes" : "no"}`,
        `pregnancy: ${d.pregnancy}`,
        `mania screen positive: ${d.maniaScreen ? "yes" : "no"}`,
        `requested change: ${d.requestedChange}`,
        `asked for a human: ${d.requestedHuman ? "yes" : "no"}`,
        `patient free text: "${clip(d.freeText, 200)}"`,
      ];
      return `Check-in submitted. ${parts.join("; ")}.`;
    }
    case "RiskSignalsExtracted":
      return e.data.signals.length === 0
        ? `Risk-signal scan (${e.data.model}): no signals.`
        : `Risk-signal scan (${e.data.model}): ${e.data.signals
            .map((s) => `${s.type} in ${s.sourceField}: "${clip(s.quote, 120)}"`)
            .join("; ")}.`;
    case "EligibilityEvaluated": {
      const failed = e.data.results.filter((r) => !r.passed);
      return `Rules evaluated: outcome ${e.data.outcome}; ${
        failed.length === 0
          ? "all rules passed"
          : `failed ${failed.map((r) => `${r.ruleId} (${clip(r.detail, 100)})`).join("; ")}`
      }.`;
    }
    case "RenewalEscalated":
      return `Escalated to a clinician: ${e.data.reasonCodes.join(", ")}.`;
    case "ClinicianReviewStarted":
      return `Clinician ${e.data.clinicianId} started review.`;
    case "RenewalApproved":
      return `Renewal approved by ${e.data.by}.`;
    case "RenewalDenied":
      return `Renewal denied (${e.data.by ?? "unknown"}): ${clip(e.data.reason, 150)}.`;
    case "FollowUpRequired":
      return `Follow-up visit required: ${clip(e.data.reason, 150)}.`;
    case "VisitBooked":
      return `Visit booked ${e.data.start} to ${e.data.end}.`;
    case "VisitNoteSigned":
      return `Visit note ${e.data.noteId} signed for visit ${e.data.visitId}.`;
    default:
      return `${e.type}.`;
  }
}

/** FNV-1a, only used to keep sanitised note ids distinct (not a security primitive). */
function shortHash(s: string): string {
  let h = 0x811c9dc5;
  for (const c of s) {
    h ^= c.codePointAt(0)!;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/**
 * Citation / anchor id for a visit note: always "note-" + a sanitised id (so it can never equal an
 * "evt-<n>" id and is safe in an element id, a URL fragment and a prompt). If sanitising changed
 * the id, a hash suffix keeps different raw ids distinct.
 */
export function noteSourceId(noteId: string): string {
  const clean = noteId.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 80);
  const id = clean === noteId ? clean : `${clean}-${shortHash(noteId)}`;
  return `note-${id}`;
}

/** The ONE place an element id / fragment is built from a (server-validated) source id. */
export const anchorId = (sourceId: string): string => `src-${sourceId}`;
