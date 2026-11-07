// Visit aggregate (stream visit-<visitId>): a booked follow-up visit and its signed note.
// Pure: no I/O, no clocks (the command carries `now`).
//  - Booking NEVER approves a renewal; it only records VisitBooked. The renewal stream is untouched.
//  - Only the clinician the visit was booked with may sign its note (fail closed when the booking
//    names no clinician). Signing emits VisitNoteSigned + CalendarSlotCreated atomically; the
//    follow-up Task lives in its own task-* stream (see ../follow-up).
//  - Idempotent: re-booking the same slot or re-signing the same note id decides nothing.
import { z } from "zod";
import { DomainError, type Aggregate } from "../aggregate";
import type { DomainEvent } from "../events";
import { invalidCommand } from "../patient/patient";
import { ActorRoleSchema } from "../renewal/review";
import { canonicalInstant, followUpSlotFor, validateGridSlot, validateSlot } from "./slots";

const id = z.string().min(1).max(200);

export const visitStreamId = (visitId: string) => `visit-${visitId}`;
/** One patient-booked follow-up visit per renewal, so the stream id enforces it. */
export const followUpVisitId = (renewalId: string) => `fu-${renewalId}`;
/** One follow-up slot per visit (not per note id, so ids can never collide across visits). */
export const followUpSlotId = (visitId: string) => `slot-${visitId}`;

export const BookFollowUpVisitSchema = z.object({
  visitId: id,
  renewalId: id,
  patientId: id,
  clinicianId: id,
  start: z.string().min(1).max(40),
  end: z.string().min(1).max(40),
  /** Injected clock (ISO instant); decide never reads the real time. */
  now: z.iso.datetime({ offset: true }),
});
export const SignVisitNoteSchema = z.object({
  visitId: id,
  noteId: id,
  clinicianId: id,
  actorRole: ActorRoleSchema,
  /** Injected clock (ISO instant); a note can only be signed once the visit has started. */
  now: z.iso.datetime({ offset: true }),
  /** Chosen by the handler (first free grid slot); default is the visit slot + the follow-up gap. */
  followUp: z
    .object({ start: z.string().min(1).max(40), end: z.string().min(1).max(40) })
    .optional(),
});

export type BookFollowUpVisit = { type: "BookFollowUpVisit" } & z.input<
  typeof BookFollowUpVisitSchema
>;
export type SignVisitNote = { type: "SignVisitNote" } & z.input<typeof SignVisitNoteSchema>;
export type VisitCommand = BookFollowUpVisit | SignVisitNote;

export interface VisitState {
  booked: boolean;
  patientId: string | null;
  clinicianId: string | null;
  renewalId: string | null;
  start: string | null;
  end: string | null;
  noteId: string | null;
  slotId: string | null;
}

export const visitInitialState: VisitState = {
  booked: false,
  patientId: null,
  clinicianId: null,
  renewalId: null,
  start: null,
  end: null,
  noteId: null,
  slotId: null,
};

export function evolveVisit(state: VisitState, event: DomainEvent): VisitState {
  switch (event.type) {
    case "VisitBooked":
      return state.booked
        ? state
        : {
            ...state,
            booked: true,
            patientId: event.data.patientId,
            clinicianId: event.data.clinicianId ?? null,
            renewalId: event.data.renewalId ?? null,
            start: event.data.start,
            end: event.data.end,
          };
    case "VisitNoteSigned":
      return state.noteId === null ? { ...state, noteId: event.data.noteId } : state;
    case "CalendarSlotCreated":
      return state.slotId === null ? { ...state, slotId: event.data.slotId } : state;
    default:
      return state;
  }
}

function parse<S extends z.ZodType>(schema: S, command: unknown): z.output<S> {
  const { type: _type, ...payload } = command as Record<string, unknown>;
  void _type;
  const parsed = schema.safeParse(payload);
  if (!parsed.success) invalidCommand(parsed.error);
  return parsed.data;
}

export function decideVisit(state: VisitState, command: VisitCommand): DomainEvent[] {
  switch (command.type) {
    case "BookFollowUpVisit": {
      const c = parse(BookFollowUpVisitSchema, command);
      const slot = validateSlot(c.start, c.end, new Date(c.now));
      if (state.booked) {
        const same =
          state.patientId === c.patientId &&
          state.renewalId === c.renewalId &&
          state.start === slot.start &&
          state.end === slot.end;
        if (same) return []; // idempotent retry
        throw new DomainError("ALREADY_BOOKED", "a visit is already booked for this follow-up");
      }
      return [
        {
          type: "VisitBooked",
          data: {
            v: 1,
            visitId: c.visitId,
            patientId: c.patientId,
            start: slot.start,
            end: slot.end,
            clinicianId: c.clinicianId,
            renewalId: c.renewalId,
          },
        },
      ];
    }
    case "SignVisitNote": {
      const c = parse(SignVisitNoteSchema, command);
      if (c.actorRole !== "clinician") {
        throw new DomainError("FORBIDDEN", "only a clinician can sign a visit note");
      }
      if (!state.booked || state.start === null || state.end === null) {
        throw new DomainError("VISIT_NOT_FOUND", "visit has not been booked");
      }
      if (state.clinicianId === null || state.clinicianId !== c.clinicianId) {
        throw new DomainError(
          "NOT_VISIT_CLINICIAN",
          "only the clinician the visit was booked with can sign its note",
        );
      }
      if (state.noteId !== null) {
        if (state.noteId === c.noteId) return []; // idempotent retry of the same note
        throw new DomainError("VISIT_ALREADY_SIGNED", "this visit already has a signed note");
      }
      // A signed note resets the refill counter, so it is tied to a visit that has actually begun:
      // signing before the visit start is refused (the clock is injected, never read here).
      if (Date.parse(c.now) < Date.parse(state.start)) {
        throw new DomainError("VISIT_NOT_STARTED", "the visit has not started yet");
      }
      const slot = c.followUp
        ? validateGridSlot(c.followUp.start, c.followUp.end)
        : followUpSlotFor({
            start: canonicalInstant(state.start),
            end: canonicalInstant(state.end),
          });
      return [
        {
          type: "VisitNoteSigned",
          data: { v: 1, visitId: c.visitId, noteId: c.noteId, clinicianId: c.clinicianId },
        },
        {
          type: "CalendarSlotCreated",
          data: { v: 1, slotId: followUpSlotId(c.visitId), start: slot.start, end: slot.end },
        },
      ];
    }
  }
}

export const visitAggregate: Aggregate<VisitState, VisitCommand> = {
  initialState: visitInitialState,
  decide: decideVisit,
  evolve: evolveVisit,
};
