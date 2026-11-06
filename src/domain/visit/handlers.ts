// Visit command handlers: load streams -> decide -> audited append (appendToStream is the only
// write path). Actor role and id come from the verified session, never from request input.
//
// Cross-stream checks (renewal really is awaiting follow-up, slot not double-booked) run INSIDE the
// append transaction: appendToStream takes the audit chain-head row lock before running the
// callback, so audited writers are serialized and these reads cannot race another booking.
import type { Sql } from "postgres";
import { appendToStream, type AppendResult } from "@/infra/audit";
import { withConcurrencyRetry } from "@/infra/event-store";
import type { Db } from "@/infra/event-store/types";
import { DEMO_SUBJECTS } from "@/infra/auth/session";
import { DomainError, replay } from "../aggregate";
import { loadStream } from "../aggregate-handler";
import { makeEvent } from "../events";
import { followUpTaskId, taskAggregate, taskStreamId } from "../follow-up/task";
import { renewalStreamId } from "../renewal/renewal";
import { reviewAggregate, type ActorRole } from "../renewal/review";
import { generateSlots, overlaps, validateSlot, type Slot } from "./slots";
import {
  followUpVisitId,
  visitAggregate,
  visitStreamId,
  type SignVisitNote,
  type VisitState,
} from "./visit";

export interface Actor {
  role: ActorRole;
  id: string;
}

/**
 * The one synthetic scheduling clinician follow-up visits are booked with.
 * TODO: a real clinician roster / availability source.
 */
export const SCHEDULING_CLINICIAN_ID = DEMO_SUBJECTS.clinician;

export interface BookedVisit {
  visitId: string;
  patientId: string;
  clinicianId: string | null;
  renewalId: string | null;
  start: string;
  end: string;
}

type Reader = Pick<Db, "unsafe">;

/** Every VisitBooked event (any stream), parsed loosely; data was Zod-validated on write. */
async function allBookedVisits(db: Reader): Promise<BookedVisit[]> {
  const rows = await db.unsafe<{ data: Record<string, unknown> }[]>(
    `SELECT data FROM events WHERE type = 'VisitBooked' ORDER BY global_position`,
  );
  return rows.map((r) => ({
    visitId: String(r.data.visitId),
    patientId: String(r.data.patientId),
    clinicianId: typeof r.data.clinicianId === "string" ? r.data.clinicianId : null,
    renewalId: typeof r.data.renewalId === "string" ? r.data.renewalId : null,
    start: String(r.data.start),
    end: String(r.data.end),
  }));
}

/** Slots still offered to the patient: the grid minus anything the clinician already has. */
export async function listOpenSlots(sql: Sql, now: Date): Promise<Slot[]> {
  const booked = (await allBookedVisits(sql)).filter(
    (v) => v.clinicianId === SCHEDULING_CLINICIAN_ID || v.clinicianId === null,
  );
  return generateSlots(now).filter((s) => !booked.some((b) => overlaps(s, b)));
}

/** The patient-visible booking for a renewal, if any. */
export async function findVisitForRenewal(
  sql: Sql,
  patientId: string,
  renewalId: string,
): Promise<BookedVisit | null> {
  const all = await allBookedVisits(sql);
  return all.find((v) => v.patientId === patientId && v.renewalId === renewalId) ?? null;
}

/**
 * A patient books a follow-up visit for a renewal that the rules held at FOLLOW_UP_REQUIRED.
 * Booking NEVER approves, denies or otherwise changes the renewal: it appends VisitBooked to the
 * visit stream only. A repeat of the same booking decides nothing; a different slot for the same
 * renewal is refused.
 */
export async function bookFollowUpVisit(
  sql: Sql,
  actor: Actor,
  input: { renewalId: string; start: string; end: string },
  now: Date = new Date(),
): Promise<{ appended: AppendResult | null; visitId: string }> {
  if (actor.role !== "patient") {
    throw new DomainError("FORBIDDEN", "only the patient can book their follow-up visit");
  }
  // Ownership and state come from the renewal stream. A renewal that is not the caller's looks
  // the same as one that does not exist (no existence leak).
  const renewal = replay(
    reviewAggregate,
    (await loadStream(sql, renewalStreamId(input.renewalId))).events,
  );
  if (!renewal.requested || renewal.patientId !== actor.id) {
    throw new DomainError("RENEWAL_NOT_FOUND", "renewal not found");
  }
  if (renewal.decision !== "follow_up_required") {
    throw new DomainError("NOT_FOLLOW_UP", "this renewal does not need a follow-up visit");
  }
  const visitId = followUpVisitId(input.renewalId);
  const streamId = visitStreamId(visitId);
  const slot = validateSlot(input.start, input.end, now);

  const appended = await withConcurrencyRetry(async () => {
    const { events, version } = await loadStream(sql, streamId);
    const state: VisitState = replay(visitAggregate, events);
    const decided = visitAggregate.decide(state, {
      type: "BookFollowUpVisit",
      visitId,
      renewalId: input.renewalId,
      patientId: actor.id,
      clinicianId: SCHEDULING_CLINICIAN_ID,
      start: slot.start,
      end: slot.end,
      now: now.toISOString(),
    });
    if (decided.length === 0) return null;
    return appendToStream(
      sql,
      streamId,
      version,
      decided.map((e) => makeEvent(e.type, e.data as never)),
      {
        actor: actor.id,
        role: actor.role,
        action: "patient:BookFollowUpVisit",
        detail: { renewalId: input.renewalId, visitId },
      },
      async (tx) => {
        const booked = await allBookedVisits(tx);
        if (booked.some((b) => b.renewalId === input.renewalId && b.visitId !== visitId)) {
          throw new DomainError("ALREADY_BOOKED", "a visit is already booked for this follow-up");
        }
        const clash = booked.some(
          (b) =>
            b.visitId !== visitId && // the event being appended is already visible in this tx
            (b.clinicianId === SCHEDULING_CLINICIAN_ID || b.clinicianId === null) &&
            overlaps(slot, b),
        );
        if (clash) throw new DomainError("SLOT_TAKEN", "that time was just booked; pick another");
      },
    );
  });
  return { appended, visitId };
}

/**
 * A clinician signs the note of a visit booked with them: VisitNoteSigned + CalendarSlotCreated
 * (one append, visit stream) and then the follow-up Task (task stream). Every call converges: if a
 * retry finds the note signed it still makes sure the task exists, so the same note id signed
 * twice yields exactly one task and one slot.
 */
export async function signVisitNote(
  sql: Sql,
  actor: Actor,
  input: { visitId: string; noteId: string },
): Promise<{ signed: AppendResult | null; task: AppendResult | null }> {
  const streamId = visitStreamId(input.visitId);
  const command: SignVisitNote = {
    type: "SignVisitNote",
    visitId: input.visitId,
    noteId: input.noteId,
    clinicianId: actor.id,
    actorRole: actor.role,
  };
  const signed = await withConcurrencyRetry(async () => {
    const { events, version } = await loadStream(sql, streamId);
    const decided = visitAggregate.decide(replay(visitAggregate, events), command);
    if (decided.length === 0) return null;
    return appendToStream(
      sql,
      streamId,
      version,
      decided.map((e) => makeEvent(e.type, e.data as never)),
      {
        actor: actor.id,
        role: actor.role,
        action: "clinician:SignVisitNote",
        detail: { visitId: input.visitId, noteId: input.noteId },
      },
    );
  });

  // The visit now holds exactly this note (decide would have thrown otherwise): ensure its task.
  const state = replay(visitAggregate, (await loadStream(sql, streamId)).events);
  if (state.noteId !== input.noteId || state.patientId === null) {
    throw new DomainError("VISIT_NOT_SIGNED", "visit note was not recorded");
  }
  const taskId = followUpTaskId(input.noteId);
  const taskStream = taskStreamId(taskId);
  const patientId = state.patientId;
  const task = await withConcurrencyRetry(async () => {
    const { events, version } = await loadStream(sql, taskStream);
    const decided = taskAggregate.decide(replay(taskAggregate, events), {
      type: "CreateFollowUpTask",
      taskId,
      patientId,
      visitId: input.visitId,
    });
    if (decided.length === 0) return null;
    return appendToStream(
      sql,
      taskStream,
      version,
      decided.map((e) => makeEvent(e.type, e.data as never)),
      {
        actor: actor.id,
        role: actor.role,
        action: "clinician:CreateFollowUpTask",
        detail: { visitId: input.visitId, noteId: input.noteId, taskId },
      },
    );
  });
  return { signed, task };
}
