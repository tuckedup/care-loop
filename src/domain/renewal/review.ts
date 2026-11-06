// Renewal decision aggregate (stream renewal-*): the system's evaluation record and the clinician's
// actions. Pure: no I/O, no clocks, no LLM. It folds the SAME renewal stream as renewal.ts.
//
// Safety contract (kept in step with the renewal_queue projection, which is the read side):
//  - RenewalApproved{by:"system"} cannot be emitted by any command here. Approve always emits
//    by:"clinician" with a named clinician id.
//  - An escalated renewal is approved only by the clinician who started its review.
//  - A clinician denial or visit booking also requires that same clinician's review start, because
//    the queue attributes a denial only through ClinicianReviewStarted.
//  - A REJECTed, denied, approved or follow-up renewal accepts no further decision.
//  - The LLM never reaches this file: RecordEvaluation carries rule results and extracted signals
//    as data, and can only ADD an escalation.
import { z } from "zod";
import { DomainError, type Aggregate } from "../aggregate";
import {
  AutonomyModeSchema,
  eventSchemas,
  OutcomeTypeSchema,
  RiskSignalSchema,
  type DomainEvent,
} from "../events";
import { invalidCommand } from "../patient/patient";

const id = z.string().min(1).max(200);

/** Roles as the audit/auth layer names them; only "clinician" may act on a renewal. */
export const ActorRoleSchema = z.enum(["patient", "clinician", "pharmacist", "admin", "system"]);
export type ActorRole = z.infer<typeof ActorRoleSchema>;

// ---------------------------------------------------------------------------------------------
// Commands

const ReasonCodeStr = z.string().min(1).max(100);

export const AiRecordSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("ok"),
    signals: z.array(RiskSignalSchema),
    model: z.string().min(1).max(200),
    latencyMs: z.number().int().min(0),
  }),
  z.object({
    status: z.literal("failed"),
    reason: z.string().min(1).max(100),
    /** Local (tripwire) signals found although the model path failed. */
    signals: z.array(RiskSignalSchema),
    model: z.string().min(1).max(200),
    latencyMs: z.number().int().min(0),
  }),
  /** The AI gate said no (controlled or unidentified medication): no LLM call happened. */
  z.object({
    status: z.literal("not_attempted"),
    reason: z.string().min(1).max(100),
    /** Local tripwire signals (pure code, not an LLM); they only ADD escalation. */
    signals: z.array(RiskSignalSchema).default([]),
  }),
]);
export type AiRecord = z.input<typeof AiRecordSchema>;

export const RecordEvaluationSchema = z.object({
  renewalId: id,
  patientId: id,
  ai: AiRecordSchema,
  /** Extra reasons that force an escalation (e.g. a failed local safety scan). */
  extraEscalationCodes: z.array(ReasonCodeStr).default([]),
  evaluation: z.object({
    outcome: OutcomeTypeSchema,
    results: eventSchemas.EligibilityEvaluated.shape.results,
    /** Reason codes of every failed rule (and pipeline check), in order. */
    reasonCodes: z.array(ReasonCodeStr),
    /** Human-readable reason for REJECT / FOLLOW_UP_REQUIRED outcomes. */
    reason: z.string().min(1).max(500).optional(),
  }),
});
export type RecordEvaluation = { type: "RecordEvaluation" } & z.input<
  typeof RecordEvaluationSchema
>;

const Clinician = { renewalId: id, clinicianId: id, actorRole: ActorRoleSchema };

export const StartReviewSchema = z.object(Clinician);
export const ApproveSchema = z.object({
  ...Clinician,
  autonomyMode: AutonomyModeSchema.default("SHADOW"),
});
export const DenySchema = z.object({
  ...Clinician,
  reason: z.string().trim().min(1).max(500),
});
export const BookVisitSchema = z.object({
  ...Clinician,
  visitId: id,
  start: z.iso.datetime({ offset: true }),
  end: z.iso.datetime({ offset: true }),
});

export type StartReview = { type: "StartReview" } & z.input<typeof StartReviewSchema>;
export type Approve = { type: "Approve" } & z.input<typeof ApproveSchema>;
export type Deny = { type: "Deny" } & z.input<typeof DenySchema>;
export type BookVisit = { type: "BookVisit" } & z.input<typeof BookVisitSchema>;

export type EscalatePipelineError = { type: "EscalatePipelineError"; renewalId: string };

export type ReviewCommand =
  EscalatePipelineError | RecordEvaluation | StartReview | Approve | Deny | BookVisit;

// ---------------------------------------------------------------------------------------------
// State

export type Decision = "approved" | "denied" | "follow_up_required";

export interface ReviewState {
  requested: boolean;
  patientId: string | null;
  identityVerified: boolean;
  checkInSubmitted: boolean;
  /** An EligibilityEvaluated has been recorded. */
  evaluated: boolean;
  outcome: z.infer<typeof OutcomeTypeSchema> | null;
  escalated: boolean;
  /** Reason codes seen on RenewalEscalated / failed rules (used to spot controlled substances). */
  reasonCodes: string[];
  controlled: boolean;
  /** R01 / R02 / R03 failed: the renewal can be denied or followed up, never approved. */
  blocked: boolean;
  /** Escalated by the pipeline-error marker (no evaluation yet); a clinician may still resolve it. */
  pipelineError: boolean;
  /** Clinician from the FIRST ClinicianReviewStarted (never reassigned, like the queue). */
  reviewerId: string | null;
  decision: Decision | null;
  decidedBy: "system" | "clinician" | null;
  visitIds: string[];
}

export const reviewInitialState: ReviewState = {
  requested: false,
  patientId: null,
  identityVerified: false,
  checkInSubmitted: false,
  evaluated: false,
  outcome: null,
  escalated: false,
  reasonCodes: [],
  controlled: false,
  blocked: false,
  pipelineError: false,
  reviewerId: null,
  decision: null,
  decidedBy: null,
  visitIds: [],
};

export function evolveReview(state: ReviewState, event: DomainEvent): ReviewState {
  switch (event.type) {
    case "RenewalRequested":
      return state.requested
        ? state
        : { ...state, requested: true, patientId: event.data.patientId };
    case "IdentityVerified":
      return { ...state, identityVerified: true };
    case "CheckInSubmitted":
      return { ...state, checkInSubmitted: true };
    case "RiskSignalsExtracted":
      return event.data.signals.length > 0
        ? { ...state, escalated: true, reasonCodes: [...state.reasonCodes, "LLM_RISK_SIGNAL"] }
        : state;
    case "EligibilityEvaluated": {
      const failed = event.data.results.filter((r) => !r.passed).map((r) => r.ruleId);
      return {
        ...state,
        evaluated: true,
        outcome: event.data.outcome,
        escalated: state.escalated || event.data.outcome === "ESCALATE",
        // R03 failing at all marks the renewal controlled (hard block on any approval).
        controlled: state.controlled || failed.includes("R03"),
        blocked: state.blocked || failed.some((r) => HARD_BLOCK_RULES.includes(r)),
      };
    }
    case "RenewalEscalated":
      return {
        ...state,
        escalated: true,
        reasonCodes: [...state.reasonCodes, ...event.data.reasonCodes],
        pipelineError: state.pipelineError || event.data.reasonCodes.includes("PIPELINE_ERROR"),
        controlled: state.controlled || event.data.reasonCodes.includes("CONTROLLED_SUBSTANCE"),
      };
    case "ClinicianReviewStarted":
      return state.reviewerId === null && state.decision === null
        ? { ...state, reviewerId: event.data.clinicianId }
        : state;
    // Mirrors the renewal_queue gates: an approval/denial only counts as a decision if the queue
    // would complete the row. A forged event (system approval of an escalated renewal, another
    // clinician's id, a decision before review start) is ignored, so it can never block the
    // legitimate reviewer from deciding.
    case "RenewalApproved": {
      if (state.decision !== null) return state;
      const d = event.data;
      if (d.by === "system") {
        return state.escalated ? state : { ...state, decision: "approved", decidedBy: "system" };
      }
      if (!d.clinicianId) return state;
      if (state.reviewerId !== null && state.reviewerId !== d.clinicianId) return state;
      if (state.escalated && state.reviewerId === null) return state;
      return { ...state, decision: "approved", decidedBy: "clinician" };
    }
    case "RenewalDenied":
      if (state.decision !== null) return state;
      if (state.reviewerId !== null)
        return { ...state, decision: "denied", decidedBy: "clinician" };
      return state.escalated ? state : { ...state, decision: "denied", decidedBy: "system" };
    case "FollowUpRequired":
      return state.decision === null && !state.escalated
        ? { ...state, decision: "follow_up_required", decidedBy: "system" }
        : state;
    case "VisitBooked":
      return { ...state, visitIds: [...state.visitIds, event.data.visitId] };
    default:
      return state;
  }
}

// ---------------------------------------------------------------------------------------------
// decide

function parse<S extends z.ZodType>(schema: S, command: unknown): z.output<S> {
  const { type: _type, ...payload } = command as Record<string, unknown>;
  void _type;
  const parsed = schema.safeParse(payload);
  if (!parsed.success) invalidCommand(parsed.error);
  return parsed.data;
}

/** Reason codes that make the rules' REJECT unsafe to apply without a human. */
const unique = (xs: readonly string[]) => [...new Set(xs)];

/** Failed rules that make approval impossible (identity, formulary, controlled substance). */
const HARD_BLOCK_RULES: readonly string[] = ["R01", "R02", "R03"];
/** Failures that are purely administrative: the only ones a system denial may rest on. */
const ADMIN_RULES: readonly string[] = ["R01", "R02"];

function decideRecordEvaluation(state: ReviewState, cmd: RecordEvaluation): DomainEvent[] {
  const c = parse(RecordEvaluationSchema, cmd);
  if (!state.requested)
    throw new DomainError("RENEWAL_NOT_REQUESTED", "renewal has not been requested");
  if (state.patientId !== c.patientId) {
    throw new DomainError("PATIENT_MISMATCH", "patient does not match the renewal");
  }
  if (!state.checkInSubmitted) {
    throw new DomainError("CHECK_IN_NOT_SUBMITTED", "no check-in to evaluate");
  }
  // Idempotent on replay: a renewal is evaluated exactly once.
  if (state.evaluated) return [];
  const alreadyDecided = state.decision !== null;

  const { renewalId, patientId, ai, evaluation } = c;
  const events: DomainEvent[] = [];

  if (ai.status === "ok" || ai.signals.length > 0) {
    events.push({
      type: "RiskSignalsExtracted",
      data: {
        v: 1,
        renewalId,
        signals: ai.signals,
        model:
          ai.status === "ok"
            ? ai.model
            : ai.status === "failed"
              ? `unavailable:${ai.reason}`
              : `local-tripwire:${ai.reason}`,
        latencyMs: ai.status === "not_attempted" ? 0 : ai.latencyMs,
      },
    });
  }
  events.push({
    type: "EligibilityEvaluated",
    data: { v: 1, renewalId, results: evaluation.results, outcome: evaluation.outcome },
  });

  const aiSignals = ai.signals.length;
  const aiFailed = ai.status === "failed";
  const failedIds = evaluation.results.filter((r) => !r.passed).map((r) => r.ruleId);
  const controlled =
    failedIds.includes("R03") || evaluation.reasonCodes.includes("CONTROLLED_SUBSTANCE");
  const forced = c.extraEscalationCodes.length > 0;
  // R13 fails merely because the AI gate blocked the path; that is not a safety signal.
  const benignR13 = ai.status === "not_attempted" && aiSignals === 0;
  const safetyFailure = failedIds.some(
    (id) => !ADMIN_RULES.includes(id) && !(id === "R13" && benignR13),
  );
  // A system denial rests ONLY on purely administrative failures (R01/R02) with no safety rule,
  // integrity check, tripwire hit or AI signal anywhere. Anything else is seen by a person.
  const administrativeReject =
    evaluation.outcome === "REJECT" && !safetyFailure && aiSignals === 0 && !aiFailed && !forced;
  // The facts are recorded either way. If a person already decided, or the renewal is already
  // escalated, no further system decision (denial / follow-up) is ever emitted on top of it.
  if (alreadyDecided) return events;

  // Escalation only ever ADDS: it is emitted for ESCALATE, any AI/tripwire signal, any AI failure,
  // a controlled substance, and for every REJECT that is not purely administrative.
  const escalate =
    evaluation.outcome === "ESCALATE" ||
    aiSignals > 0 ||
    aiFailed ||
    controlled ||
    forced ||
    (evaluation.outcome === "REJECT" && !administrativeReject);
  if (escalate) {
    const codes = unique([
      ...evaluation.reasonCodes,
      ...c.extraEscalationCodes,
      ...(aiSignals > 0 ? ["LLM_RISK_SIGNAL"] : []),
      ...(aiFailed ? ["LLM_FAILURE"] : []),
      ...(controlled ? ["CONTROLLED_SUBSTANCE"] : []),
    ]);
    events.push({
      type: "RenewalEscalated",
      data: { v: 1, renewalId, reasonCodes: codes.length > 0 ? codes : ["INVALID_INPUT"] },
    });
    return events;
  }
  switch (evaluation.outcome) {
    case "REJECT":
      if (state.escalated) return events; // recorded; a clinician resolves it
      events.push({
        type: "RenewalDenied",
        data: {
          v: 1,
          renewalId,
          reason: evaluation.reason ?? "Not eligible for renewal under the eligibility rules",
          by: "system",
        },
      });
      return events;
    case "FOLLOW_UP_REQUIRED":
      if (state.escalated) return events;
      events.push({
        type: "FollowUpRequired",
        data: {
          v: 1,
          renewalId,
          patientId,
          reason: evaluation.reason ?? "A follow-up visit is required before renewal",
        },
      });
      return events;
    default:
      // AUTO_ELIGIBLE: awaits a clinician. Autonomy modes (F059) are not applied here.
      return events;
  }
}

function requireClinician(role: ActorRole, clinicianId: string): void {
  if (role !== "clinician") {
    throw new DomainError("NOT_A_CLINICIAN", "only a clinician may act on a renewal");
  }
  if (clinicianId.trim() === "") throw new DomainError("NOT_A_CLINICIAN", "clinician id required");
}

/**
 * `allowPipelineError`: a renewal escalated ONLY by the pipeline-error marker has no evaluation
 * yet; a clinician may start review, deny or book a visit for it, but never approve it.
 */
function requireOpen(state: ReviewState, allowPipelineError = false): void {
  if (!state.requested)
    throw new DomainError("RENEWAL_NOT_REQUESTED", "renewal has not been requested");
  if (!state.evaluated && !(allowPipelineError && state.pipelineError))
    throw new DomainError("NOT_EVALUATED", "renewal has not been evaluated yet");
  if (state.decision !== null) throw new DomainError("ALREADY_DECIDED", "renewal already decided");
}

function requireSameReviewer(state: ReviewState, clinicianId: string): void {
  if (state.reviewerId === null) {
    throw new DomainError("REVIEW_NOT_STARTED", "start the review before deciding");
  }
  if (state.reviewerId !== clinicianId) {
    throw new DomainError(
      "REVIEWER_MISMATCH",
      "only the clinician who started the review may decide",
    );
  }
}

export function decideReview(state: ReviewState, command: ReviewCommand): DomainEvent[] {
  switch (command.type) {
    case "RecordEvaluation":
      return decideRecordEvaluation(state, command);
    case "EscalatePipelineError": {
      // System-only fail-closed marker: only ever ADDS an escalation, never decides.
      if (!state.requested) {
        throw new DomainError("RENEWAL_NOT_REQUESTED", "renewal has not been requested");
      }
      if (state.escalated || state.decision !== null) return [];
      return [
        {
          type: "RenewalEscalated",
          data: { v: 1, renewalId: command.renewalId, reasonCodes: ["PIPELINE_ERROR"] },
        },
      ];
    }
    case "StartReview": {
      const c = parse(StartReviewSchema, command);
      requireClinician(c.actorRole, c.clinicianId);
      requireOpen(state, true);
      if (state.reviewerId === c.clinicianId) return []; // idempotent
      if (state.reviewerId !== null) {
        throw new DomainError(
          "REVIEW_ALREADY_STARTED",
          "another clinician is reviewing this renewal",
        );
      }
      return [
        {
          type: "ClinicianReviewStarted",
          data: { v: 1, renewalId: c.renewalId, clinicianId: c.clinicianId },
        },
      ];
    }
    case "Approve": {
      const c = parse(ApproveSchema, command);
      requireClinician(c.actorRole, c.clinicianId);
      requireOpen(state);
      if (state.controlled) {
        throw new DomainError(
          "CONTROLLED_NOT_APPROVABLE",
          "controlled substances are not approvable here",
        );
      }
      if (state.outcome === "REJECT" || state.blocked) {
        throw new DomainError("APPROVAL_OF_REJECTED", "a rejected renewal cannot be approved");
      }
      if (state.outcome === "FOLLOW_UP_REQUIRED") {
        throw new DomainError("APPROVAL_OF_FOLLOW_UP", "a follow-up visit is required first");
      }
      if (state.escalated) {
        requireSameReviewer(state, c.clinicianId);
      } else if (state.reviewerId !== null && state.reviewerId !== c.clinicianId) {
        throw new DomainError("REVIEWER_MISMATCH", "another clinician is reviewing this renewal");
      }
      return [
        {
          type: "RenewalApproved",
          data: {
            v: 1,
            renewalId: c.renewalId,
            by: "clinician",
            autonomyMode: c.autonomyMode,
            clinicianId: c.clinicianId,
          },
        },
      ];
    }
    case "Deny": {
      const c = parse(DenySchema, command);
      requireClinician(c.actorRole, c.clinicianId);
      requireOpen(state, true);
      requireSameReviewer(state, c.clinicianId);
      return [
        {
          type: "RenewalDenied",
          data: {
            v: 1,
            renewalId: c.renewalId,
            reason: c.reason,
            by: "clinician",
            clinicianId: c.clinicianId,
          },
        },
      ];
    }
    case "BookVisit": {
      const c = parse(BookVisitSchema, command);
      requireClinician(c.actorRole, c.clinicianId);
      if (!state.requested || state.patientId === null) {
        throw new DomainError("RENEWAL_NOT_REQUESTED", "renewal has not been requested");
      }
      if (!state.evaluated && !state.pipelineError)
        throw new DomainError("NOT_EVALUATED", "renewal has not been evaluated yet");
      if (Date.parse(c.end) <= Date.parse(c.start)) {
        throw new DomainError("INVALID_COMMAND", "visit end must be after start");
      }
      if (state.visitIds.includes(c.visitId)) return []; // idempotent
      const visit: DomainEvent = {
        type: "VisitBooked",
        data: {
          v: 1,
          visitId: c.visitId,
          patientId: state.patientId,
          start: c.start,
          end: c.end,
          clinicianId: c.clinicianId,
          renewalId: c.renewalId,
        },
      };
      // A follow-up already decided by the system only needs the booking.
      if (state.decision === "follow_up_required") return [visit];
      if (state.decision !== null)
        throw new DomainError("ALREADY_DECIDED", "renewal already decided");
      requireSameReviewer(state, c.clinicianId);
      return [
        visit,
        {
          type: "RenewalDenied",
          data: {
            v: 1,
            renewalId: c.renewalId,
            reason: "Not renewed; a follow-up visit has been booked",
            by: "clinician",
            clinicianId: c.clinicianId,
          },
        },
      ];
    }
  }
}

export const reviewAggregate: Aggregate<ReviewState, ReviewCommand> = {
  initialState: reviewInitialState,
  decide: decideReview,
  evolve: evolveReview,
};
