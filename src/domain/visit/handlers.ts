// Visit command handlers: load streams -> decide -> audited append (appendToStream is the only
// write path). Actor role and id come from the verified session, never from request input.
//
// Cross-stream checks (renewal really is awaiting follow-up, slot not double-booked, ids not
// reused) run INSIDE the append transaction: appendToStream takes the audit chain-head row lock
// before running the callback, so audited writers are serialized and these reads cannot race
// another booking or signing. A thrown DomainError rolls the whole append back (atomic).
import type { Sql } from "postgres";
import { appendToStream, type AppendResult } from "@/infra/audit";
import { withConcurrencyRetry } from "@/infra/event-store";
import type { Db } from "@/infra/event-store/types";
import { DEMO_SUBJECTS } from "@/infra/auth/session";
import { DomainError, replay } from "../aggregate";
import { loadStream } from "../aggregate-handler";
import { bookVisit as bookRenewalVisit } from "../clinician/handlers";
import { makeEvent } from "../events";
import { followUpTaskId, taskAggregate, taskStreamId } from "../follow-up/task";
import { renewalStreamId } from "../renewal/renewal";
import { reviewAggregate, type ActorRole } from "../renewal/review";
import {
  firstFreeSlot,
  followUpSlotFor,
  generateSlots,
  overlaps,
  validateSlot,
  type Slot,
} from "./slots";
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
const VISIT_PREFIX = "visit-";

interface BookedRow extends BookedVisit {
  streamId: string;
}

/** Every VisitBooked event (any stream), parsed loosely; data was Zod-validated on write. */
async function allBookedVisits(db: Reader): Promise<BookedRow[]> {
  const rows = await db.unsafe<{ stream_id: string; data: Record<string, unknown> }[]>(
    `SELECT stream_id, data FROM events WHERE type = 'VisitBooked' ORDER BY global_position`,
  );
  return rows.map((r) => ({
    streamId: r.stream_id,
    visitId: String(r.data.visitId),
    patientId: String(r.data.patientId),
    clinicianId: typeof r.data.clinicianId === "string" ? r.data.clinicianId : null,
    renewalId: typeof r.data.renewalId === "string" ? r.data.renewalId : null,
    start: String(r.data.start),
    end: String(r.data.end),
  }));
}

interface Held extends Slot {
  /** Visit the interval belongs to (a booking, or the follow-up slot created for it). */
  visitId: string;
}

/** Everything the scheduling clinician already holds: booked visits AND created calendar slots. */
async function heldIntervals(db: Reader): Promise<Held[]> {
  const booked = (await allBookedVisits(db))
    .filter((v) => v.clinicianId === SCHEDULING_CLINICIAN_ID || v.clinicianId === null)
    .map((v) => ({ visitId: v.visitId, start: v.start, end: v.end }));
  const slots = await db.unsafe<{ stream_id: string; data: Record<string, unknown> }[]>(
    `SELECT stream_id, data FROM events WHERE type = 'CalendarSlotCreated' ORDER BY global_position`,
  );
  return [
    ...booked,
    ...slots.map((r) => ({
      visitId: r.stream_id.startsWith(VISIT_PREFIX) ? r.stream_id.slice(VISIT_PREFIX.length) : "",
      start: String(r.data.start),
      end: String(r.data.end),
    })),
  ];
}

/** Slots still offered to the patient: the grid minus visits and calendar slots already held. */
export async function listOpenSlots(sql: Sql, now: Date): Promise<Slot[]> {
  const held = await heldIntervals(sql);
  return generateSlots(now).filter((s) => !held.some((b) => overlaps(s, b)));
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
        // A visit id already used by a booking in ANOTHER stream (or for another renewal) is a
        // forged or colliding id: refuse it so it can never vouch for someone else's visit.
        if (booked.some((b) => b.visitId === visitId && b.streamId !== streamId)) {
          throw new DomainError("VISIT_ID_CONFLICT", "that visit id is already in use");
        }
        if (booked.some((b) => b.renewalId === input.renewalId && b.visitId !== visitId)) {
          throw new DomainError("ALREADY_BOOKED", "a visit is already booked for this follow-up");
        }
        const held = await heldIntervals(tx);
        // The event being appended is already visible in this tx: ignore this visit's own interval.
        if (held.some((h) => h.visitId !== visitId && overlaps(slot, h))) {
          throw new DomainError("SLOT_TAKEN", "that time was just booked; pick another");
        }
      },
    );
  });
  return { appended, visitId };
}

/**
 * A clinician books a visit for a renewal's patient. The visit id is DERIVED on the server from
 * the renewal id (never accepted from a client), and an id already used by a booking for another
 * patient or renewal is refused, so a copied visit id cannot tie a note to the wrong patient.
 */
export async function bookClinicianVisit(
  sql: Sql,
  actor: Actor,
  input: { renewalId: string; start: string; end: string },
) {
  const visitId = `cv-${input.renewalId}`;
  const renewal = replay(
    reviewAggregate,
    (await loadStream(sql, renewalStreamId(input.renewalId))).events,
  );
  const clash = (await allBookedVisits(sql)).some(
    (b) =>
      b.visitId === visitId &&
      (b.patientId !== renewal.patientId || b.renewalId !== input.renewalId),
  );
  if (clash || (await loadStream(sql, visitStreamId(visitId))).version > 0) {
    throw new DomainError("VISIT_ID_CONFLICT", "that visit id is already in use");
  }
  return bookRenewalVisit(sql, actor, { ...input, visitId });
}

async function noteIdUsedElsewhere(db: Reader, noteId: string, streamId: string) {
  const rows = await db.unsafe<{ n: string }[]>(
    `SELECT count(*) AS n FROM events
      WHERE type = 'VisitNoteSigned' AND data->>'noteId' = $1 AND stream_id <> $2`,
    [noteId, streamId],
  );
  return Number(rows[0]!.n) > 0;
}

/** True when the task stream already holds a task for a different patient or visit. */
async function taskConflicts(db: Reader, taskStream: string, patientId: string, visitId: string) {
  const rows = await db.unsafe<{ n: string }[]>(
    `SELECT count(*) AS n FROM events
      WHERE stream_id = $1 AND (type <> 'FollowUpTaskCreated'
         OR data->>'patientId' <> $2 OR COALESCE(data->>'visitId', '') <> $3)`,
    [taskStream, patientId, visitId],
  );
  return Number(rows[0]!.n) > 0;
}

/** Appends the follow-up task for a signed visit if it is missing (idempotent). */
async function ensureTask(
  sql: Sql,
  actor: Actor,
  visit: { visitId: string; noteId: string; patientId: string },
): Promise<AppendResult | null> {
  const taskId = followUpTaskId(visit.visitId);
  const taskStream = taskStreamId(taskId);
  return withConcurrencyRetry(async () => {
    const { events, version } = await loadStream(sql, taskStream);
    const decided = taskAggregate.decide(replay(taskAggregate, events), {
      type: "CreateFollowUpTask",
      taskId,
      patientId: visit.patientId,
      visitId: visit.visitId,
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
        action:
          actor.role === "system" ? "system:RepairFollowUpTask" : "clinician:CreateFollowUpTask",
        detail: { visitId: visit.visitId, noteId: visit.noteId, taskId },
      },
    );
  });
}

/**
 * A clinician signs the note of a visit booked with them, once the visit has started (`now` is
 * injected: a signed note resets the refill counter, so it is tied to a visit that really began).
 * VisitNoteSigned + CalendarSlotCreated are one append (visit stream); the follow-up Task follows in
 * its own stream. All conflicts (note id reuse, task id, slot overlap) are checked inside the first
 * append's transaction, so a refusal writes nothing. Every call converges: a retry after a crash
 * between the two appends still ends with exactly one task and one slot.
 */
export async function signVisitNote(
  sql: Sql,
  actor: Actor,
  input: { visitId: string; noteId: string },
  now: Date = new Date(),
): Promise<{ signed: AppendResult | null; task: AppendResult | null }> {
  const streamId = visitStreamId(input.visitId);
  let signed: AppendResult | null = null;
  for (let attempt = 0; ; attempt++) {
    try {
      signed = await withConcurrencyRetry(async () => {
        const { events, version } = await loadStream(sql, streamId);
        const state = replay(visitAggregate, events);
        // The follow-up slot is the first free grid slot at/after visit + gap (never a held one).
        let followUp: Slot | undefined;
        if (state.start && state.end && state.noteId === null) {
          const held = (await heldIntervals(sql)).filter((h) => h.visitId !== input.visitId);
          followUp = firstFreeSlot(
            followUpSlotFor({
              start: new Date(state.start).toISOString(),
              end: new Date(state.end).toISOString(),
            }),
            held,
          );
        }
        const command: SignVisitNote = {
          type: "SignVisitNote",
          visitId: input.visitId,
          noteId: input.noteId,
          clinicianId: actor.id,
          actorRole: actor.role,
          now: now.toISOString(),
          ...(followUp ? { followUp } : {}),
        };
        const decided = visitAggregate.decide(state, command);
        if (decided.length === 0) return null;
        const patientId = state.patientId!;
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
          async (tx) => {
            if (await noteIdUsedElsewhere(tx, input.noteId, streamId)) {
              throw new DomainError(
                "NOTE_ID_CONFLICT",
                "that note id is already used by another visit",
              );
            }
            if (
              await taskConflicts(
                tx,
                taskStreamId(followUpTaskId(input.visitId)),
                patientId,
                input.visitId,
              )
            ) {
              throw new DomainError("TASK_CONFLICT", "the follow-up task id is already in use");
            }
            const held = (await heldIntervals(tx)).filter((h) => h.visitId !== input.visitId);
            if (followUp && held.some((h) => overlaps(followUp, h))) {
              throw new DomainError("SLOT_TAKEN", "the follow-up slot was just taken");
            }
          },
        );
      });
      break;
    } catch (e) {
      // Another writer took the chosen follow-up slot between choosing and appending: choose again.
      if (e instanceof DomainError && e.code === "SLOT_TAKEN" && attempt < 3) continue;
      throw e;
    }
  }

  // The visit now holds exactly this note (decide would have thrown otherwise): ensure its task.
  const state = replay(visitAggregate, (await loadStream(sql, streamId)).events);
  if (state.noteId !== input.noteId || state.patientId === null) {
    throw new DomainError("VISIT_NOT_SIGNED", "visit note was not recorded");
  }
  const task = await ensureTask(sql, actor, {
    visitId: input.visitId,
    noteId: input.noteId,
    patientId: state.patientId,
  });
  return { signed, task };
}

export const REPAIR_ACTOR: Actor = { role: "system", id: "visit-repair" };

/**
 * Repair sweep: finds signed visit notes whose follow-up task is missing (a crash between the two
 * appends of signing) and completes them with the same idempotent logic. Safe to run repeatedly
 * and concurrently. Returns what it completed; a signed visit with no calendar slot (cannot
 * happen through signVisitNote, the slot is in the same append) is reported, not guessed at.
 */
export async function repairUnfinishedSignings(
  sql: Sql,
): Promise<{ checked: number; repaired: string[]; missingSlot: string[]; failed: string[] }> {
  const signed = await sql.unsafe<{ stream_id: string; note_id: string }[]>(
    `SELECT stream_id, data->>'noteId' AS note_id FROM events
      WHERE type = 'VisitNoteSigned' AND stream_id LIKE 'visit-%' ORDER BY global_position`,
  );
  const repaired: string[] = [];
  const missingSlot: string[] = [];
  const failed: string[] = [];
  for (const row of signed) {
    const visitId = row.stream_id.slice(VISIT_PREFIX.length);
    const state = replay(visitAggregate, (await loadStream(sql, row.stream_id)).events);
    if (state.patientId === null || state.noteId === null) continue;
    if (state.slotId === null) missingSlot.push(visitId);
    try {
      const task = await ensureTask(sql, REPAIR_ACTOR, {
        visitId,
        noteId: state.noteId,
        patientId: state.patientId,
      });
      if (task) repaired.push(visitId);
    } catch (e) {
      if (!(e instanceof DomainError)) throw e;
      failed.push(visitId); // a conflicting task stream needs a human, never a guess
    }
  }
  return { checked: signed.length, repaired, missingSlot, failed };
}
