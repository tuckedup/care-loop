// Event schemas v1 (docs/SPEC.md section 3). Past-tense names, Zod at the boundary.
// Every payload carries `v: 1` so future versions can be upcast. ALL DATA IS SYNTHETIC.
import { z } from "zod";
import type { NewEvent } from "@/infra/event-store/types";

export const EVENT_VERSION = 1 as const;
export const FREE_TEXT_MAX = 2000;

const id = z.string().min(1).max(200);
const isoDate = z.iso.date();
const isoDateTime = z.iso.datetime({ offset: true });
const v1 = z.literal(EVENT_VERSION);
const pharmacyId = z.string().regex(/^[0-9]{7}$/, "pharmacy id must be exactly 7 digits");

export const ControlledScheduleSchema = z.enum(["II", "III", "IV", "V"]);

/** Structured dose; later rules compare it numerically (e.g. a per-drug mg ceiling). */
export const DoseSchema = z.object({
  amountMg: z.number().positive().finite(),
});

/** Structured frequency; `timing: "nightly"` is what a nightly-only limit checks. */
export const FrequencySchema = z.object({
  timesPerDay: z.number().int().min(1).max(6),
  timing: z.enum(["morning", "midday", "evening", "nightly", "any"]),
});

/**
 * Metabolic/CV monitoring dates. Absent fields mean "not recorded"; rules must escalate on
 * missing data, never treat it as passing.
 */
export const MetabolicMonitoringSchema = z.object({
  baselineAt: isoDate.optional(),
  lastSixMonthAt: isoDate.optional(),
});

export const PregnancyAnswerSchema = z.enum(["yes", "no", "unsure"]);
export const RequestedChangeSchema = z.enum(["none", "dose", "frequency", "drug", "other"]);
export const AutonomyModeSchema = z.enum(["SHADOW", "RETRO", "SAMPLED"]);
export const OutcomeTypeSchema = z.enum([
  "AUTO_ELIGIBLE",
  "ESCALATE",
  "REJECT",
  "FOLLOW_UP_REQUIRED",
]);

const phqItem = z.number().int().min(0).max(3);

/** Check-in answers; the same shape the SubmitCheckIn command validates. */
export const CheckInAnswersSchema = z.object({
  phq9: z.array(phqItem).length(9),
  gad7: z.array(phqItem).length(7),
  sideEffects: z.array(z.string().min(1).max(200)).max(20),
  severeSideEffect: z.boolean(),
  pregnancy: PregnancyAnswerSchema,
  /** true = positive mania screen. */
  maniaScreen: z.boolean(),
  freeText: z.string().max(FREE_TEXT_MAX),
  requestedHuman: z.boolean(),
  requestedChange: RequestedChangeSchema,
});
export type CheckInAnswers = z.infer<typeof CheckInAnswersSchema>;

export const RiskSignalSchema = z
  .object({
    type: z.string().min(1).max(100),
    quote: z.string().min(1).max(FREE_TEXT_MAX),
    sourceField: z.string().min(1).max(100),
    start: z.number().int().min(0),
    end: z.number().int().min(0),
  })
  .refine((s) => s.end >= s.start, { message: "end must be >= start" });

const payloads = {
  PatientRegistered: z.object({
    v: v1,
    patientId: id,
    firstName: z.string().min(1).max(100),
    lastName: z.string().min(1).max(100),
    dateOfBirth: isoDate,
  }),
  MedicationPrescribed: z.object({
    v: v1,
    prescriptionId: id,
    patientId: id,
    rxcui: z.string().min(1).max(20),
    drugName: z.string().min(1).max(200),
    dose: DoseSchema,
    frequency: FrequencySchema,
    sig: z.string().min(1).max(500),
    /** Nullable on purpose: null = affirmatively not controlled. */
    controlledSchedule: ControlledScheduleSchema.nullable(),
    prescriberId: id,
    metabolicMonitoring: MetabolicMonitoringSchema.optional(),
  }),
  RenewalRequested: z.object({
    v: v1,
    renewalId: id,
    patientId: id,
    prescriptionId: id,
  }),
  /**
   * Additive (F047): the pharmacy the patient confirmed before the check-in, with the name,
   * address and phone they were shown (a snapshot of what was confirmed).
   */
  PharmacySelected: z.object({
    v: v1,
    renewalId: id,
    pharmacyId,
    name: z.string().min(1).max(200),
    address: z.string().min(1).max(300),
    phone: z.string().min(1).max(40),
  }),
  IdentityVerified: z.object({
    v: v1,
    renewalId: id,
    method: z.literal("dob_lastname"),
  }),
  CheckInSubmitted: CheckInAnswersSchema.extend({ v: v1, renewalId: id }),
  RiskSignalsExtracted: z.object({
    v: v1,
    renewalId: id,
    signals: z.array(RiskSignalSchema),
    model: z.string().min(1).max(200),
    latencyMs: z.number().int().min(0),
  }),
  EligibilityEvaluated: z.object({
    v: v1,
    renewalId: id,
    results: z.array(
      z.object({ ruleId: z.string().min(1), passed: z.boolean(), detail: z.string() }),
    ),
    outcome: OutcomeTypeSchema,
  }),
  RenewalEscalated: z.object({
    v: v1,
    renewalId: id,
    reasonCodes: z.array(z.string().min(1)).min(1),
  }),
  ClinicianReviewStarted: z.object({ v: v1, renewalId: id, clinicianId: id }),
  RenewalApproved: z.object({
    v: v1,
    renewalId: id,
    by: z.enum(["system", "clinician"]),
    autonomyMode: AutonomyModeSchema,
    clinicianId: id.optional(),
  }),
  RenewalDenied: z.object({
    v: v1,
    renewalId: id,
    reason: z.string().min(1).max(500),
    /** Additive (F042). Absent on older events; the queue then infers the actor from review start. */
    by: z.enum(["system", "clinician"]).optional(),
    clinicianId: id.optional(),
  }),
  RxRenewalQueued: z.object({
    v: v1,
    renewalId: id,
    prescriptionId: id,
    idempotencyKey: id,
    /** Additive (F048): where and under which message id the outbox row will transmit it. */
    pharmacyId: pharmacyId.optional(),
    messageId: id.optional(),
    /**
     * Additive: earlier renewals of the same prescription (stalled, unfilled) that this approval
     * supersedes. The same transaction queues a CancelRx for each; they are no longer unsettled.
     */
    supersedes: z
      .array(z.object({ renewalId: id, pharmacyId }))
      .max(10)
      .optional(),
  }),
  RxRenewalTransmitted: z.object({
    v: v1,
    renewalId: id,
    messageId: id,
    idempotencyKey: id,
  }),
  PharmacyStatusReceived: z.object({
    v: v1,
    renewalId: id,
    messageId: id,
    status: z.string().min(1).max(100),
  }),
  PharmacyErrorReceived: z.object({
    v: v1,
    renewalId: id,
    messageId: id,
    code: z.string().min(1).max(100),
    retryable: z.boolean(),
  }),
  RxFillReceived: z.object({ v: v1, renewalId: id, messageId: id }),
  /** Additive (F049): the pharmacy acknowledged a CancelRx. */
  RxCancelAcknowledged: z.object({ v: v1, renewalId: id, messageId: id }),
  FollowUpRequired: z.object({
    v: v1,
    renewalId: id,
    patientId: id,
    reason: z.string().min(1).max(500),
  }),
  VisitBooked: z.object({
    v: v1,
    visitId: id,
    patientId: id,
    start: isoDateTime,
    end: isoDateTime,
    /** Additive (F042): the clinician who booked it and the renewal it follows up. */
    clinicianId: id.optional(),
    renewalId: id.optional(),
  }),
  VisitNoteSigned: z.object({ v: v1, visitId: id, noteId: id, clinicianId: id }),
  CalendarSlotCreated: z.object({
    v: v1,
    slotId: id,
    start: isoDateTime,
    end: isoDateTime,
  }),
  FollowUpTaskCreated: z.object({
    v: v1,
    taskId: id,
    patientId: id,
    visitId: id.optional(),
  }),
  PharmacistEscalationReceived: z.object({
    v: v1,
    renewalId: id,
    messageId: id,
    message: z.string().min(1).max(FREE_TEXT_MAX),
  }),
  /** Additive (F054): a pharmacist/admin acknowledged a pharmacy alert (escalation or error). */
  PharmacyAlertAcknowledged: z.object({
    v: v1,
    renewalId: id,
    /** The messageId of the PharmacistEscalationReceived / PharmacyErrorReceived acknowledged. */
    messageId: id,
    acknowledgedBy: id,
  }),
  AuditSampleSelected: z.object({
    v: v1,
    renewalId: id,
    /** Additive (F060): why the auto-approval was queued for retrospective review. */
    reason: z.string().min(1).max(200).optional(),
  }),
  RetroReviewRecorded: z.object({
    v: v1,
    renewalId: id,
    reviewerId: id,
    concur: z.boolean(),
  }),
  /**
   * Additive (F059): the admin-chosen autonomy mode, on the settings stream. Absent => SHADOW.
   * `changedBy` is the admin's session subject (never request input).
   */
  AutonomyModeChanged: z.object({ v: v1, mode: AutonomyModeSchema, changedBy: id }),
} as const;

export const eventSchemas = payloads;
export type EventType = keyof typeof payloads;
export const EVENT_TYPES = Object.keys(payloads) as EventType[];

export type EventData<T extends EventType> = z.infer<(typeof payloads)[T]>;

export type DomainEvent = {
  [T in EventType]: { type: T; data: EventData<T> };
}[EventType];

const entries = EVENT_TYPES.map((t) =>
  z.object({ type: z.literal(t), data: payloads[t] }),
) as unknown as [z.ZodType<DomainEvent>, ...z.ZodType<DomainEvent>[]];

/** Discriminated union over all v1 events. */
export const DomainEventSchema: z.ZodType<DomainEvent> = z.union(entries);

export class UnknownEventTypeError extends Error {
  override readonly name = "UnknownEventTypeError";
  constructor(readonly eventType: string) {
    super(`Unknown event type: ${eventType}`);
  }
}

/** Validate a stored/incoming { type, data } pair. Throws UnknownEventTypeError or ZodError. */
export function parseEvent(input: { type: string; data: unknown }): DomainEvent {
  if (!Object.hasOwn(payloads, input.type)) throw new UnknownEventTypeError(input.type);
  const type = input.type as EventType;
  const data = payloads[type].parse(input.data);
  return { type, data } as DomainEvent;
}

/** Build a store-ready event with its payload validated (and unknown keys stripped). */
export function makeEvent<T extends EventType>(
  type: T,
  data: EventData<T>,
  metadata?: Record<string, unknown>,
): NewEvent {
  const parsed = payloads[type].parse(data);
  return metadata ? { type, data: parsed, metadata } : { type, data: parsed };
}
