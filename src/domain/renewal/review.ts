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
  z.object({ status: z.literal("not_attempted"), reason: z.string().min(1).max(100) }),
]);
export type AiRecord = z.infer<typeof AiRecordSchema>;

export const RecordEvaluationSchema = z.object({
  renewalId: id,
  patientId: id,
  ai: AiRecordSchema,
  evaluation: z.object({
    outcome: OutcomeTypeSchema,
    results: eventSchemas.EligibilityEvaluated.shape.results,
    /** Reason codes of every failed rule (and pipeline check), in order. */
    reasonCodes: z.array(ReasonCodeStr),
    /** Human-readable reason for REJECT / FOLLOW_UP_REQUIRED outcomes. */
    reason: z.string().min(1).max(500).optional(),
  }),
});
export type RecordEvaluation = { type: "RecordEvaluation" } & z.infer<
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

export type ReviewCommand = RecordEvaluation | StartReview | Approve | Deny | BookVisit;

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
      };
    }
    case "RenewalEscalated":
      return {
        ...state,
        escalated: true,
        reasonCodes: [...state.reasonCodes, ...event.data.reasonCodes],
        controlled: state.controlled || event.data.reasonCodes.includes("CONTROLLED_SUBSTANCE"),
      };
    case "ClinicianReviewStarted":
      return state.reviewerId === null && state.decision === null
        ? { ...state, reviewerId: event.data.clinicianId }
        : state;
    case "RenewalApproved":
      return state.decision === null
        ? { ...state, decision: "approved", decidedBy: event.data.by }
        : state;
    case "RenewalDenied":
      return state.decision === null
        ? {
            ...state,
            decision: "denied",
            decidedBy:
              event.data.by ??
              (state.reviewerId !== null || state.escalated ? "clinician" : "system"),
          }
        : state;
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

  const { renewalId, patientId, ai, evaluation } = c;
  const events: DomainEvent[] = [];

  if (ai.status !== "not_attempted" && (ai.status === "ok" || ai.signals.length > 0)) {
    events.push({
      type: "RiskSignalsExtracted",
      data: {
        v: 1,
        renewalId,
        signals: ai.signals,
        model: ai.status === "ok" ? ai.model : `unavailable:${ai.reason}`,
        latencyMs: ai.latencyMs,
      },
    });
  }
  events.push({
    type: "EligibilityEvaluated",
    data: { v: 1, renewalId, results: evaluation.results, outcome: evaluation.outcome },
  });

  const aiSignals = ai.status === "not_attempted" ? 0 : ai.signals.length;
  const aiFailed = ai.status === "failed";
  const ruleFailed = (ruleId: string) =>
    evaluation.results.some((r) => r.ruleId === ruleId && !r.passed);
  const controlled = ruleFailed("R03") || evaluation.reasonCodes.includes("CONTROLLED_SUBSTANCE");

  // Escalation is emitted for ESCALATE, any AI signal, any AI failure (it can only ADD), and for
  // a controlled-substance REJECT: a person, not a silent auto-denial, handles those.
  const escalate = evaluation.outcome === "ESCALATE" || aiSignals > 0 || aiFailed || controlled;
  if (escalate) {
    const codes = unique([
      ...evaluation.reasonCodes,
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

function requireOpen(state: ReviewState): void {
  if (!state.requested)
    throw new DomainError("RENEWAL_NOT_REQUESTED", "renewal has not been requested");
  if (!state.evaluated)
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
    case "StartReview": {
      const c = parse(StartReviewSchema, command);
      requireClinician(c.actorRole, c.clinicianId);
      requireOpen(state);
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
      if (state.outcome === "REJECT") {
        throw new DomainError("APPROVAL_OF_REJECTED", "a rejected renewal cannot be approved");
      }
      if (state.outcome === "FOLLOW_UP_REQUIRED") {
        throw new DomainError("APPROVAL_OF_FOLLOW_UP", "a follow-up visit is required first");
      }
      if (state.controlled) {
        throw new DomainError(
          "CONTROLLED_NOT_APPROVABLE",
          "controlled substances are not approvable here",
        );
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
      requireOpen(state);
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
      if (!state.evaluated)
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
