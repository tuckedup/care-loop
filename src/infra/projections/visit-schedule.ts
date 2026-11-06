// Projection visit_schedule (F052): the read side of follow-up visits.
//   VisitBooked          -> visit_schedule row (status booked)
//   VisitNoteSigned      -> visit_schedule.status = note_signed (+ note id)
//   CalendarSlotCreated  -> calendar_slots row (visit id comes from the visit-<id> stream)
//   FollowUpTaskCreated  -> follow_up_tasks row, FHIR Task status "requested"
// Deterministic: only event data and stream ids are read, so a rebuild equals the incremental run.
import { EVENT_TYPES, parseEvent, type DomainEvent } from "@/domain/events";
import type { Db, StoredEvent } from "@/infra/event-store/types";
import { recordAnomaly } from "./anomalies";
import type { Projection } from "./runner";

const KNOWN = new Set<string>(EVENT_TYPES);
const RELEVANT = new Set([
  "VisitBooked",
  "VisitNoteSigned",
  "CalendarSlotCreated",
  "FollowUpTaskCreated",
]);

export interface VisitRow {
  visitId: string;
  patientId: string;
  renewalId: string | null;
  clinicianId: string | null;
  start: string;
  end: string;
  status: "booked" | "note_signed";
  noteId: string | null;
}
export interface CalendarSlotRow {
  slotId: string;
  visitId: string;
  clinicianId: string | null;
  start: string;
  end: string;
}
export interface FollowUpTaskRow {
  taskId: string;
  patientId: string;
  visitId: string | null;
  /** FHIR Task.status */
  status: "requested";
}

const VISIT_PREFIX = "visit-";

export const visitScheduleProjection: Projection = {
  name: "visit_schedule",

  async handle(tx: Db, stored: StoredEvent): Promise<void> {
    if (!KNOWN.has(stored.type) || !RELEVANT.has(stored.type)) return;
    let event: DomainEvent;
    try {
      event = parseEvent({ type: stored.type, data: stored.data });
    } catch (e) {
      await recordAnomaly(tx, "visit_schedule", stored, "INVALID_EVENT", String(e));
      return;
    }
    const position = stored.globalPosition.toString();
    switch (event.type) {
      case "VisitBooked":
        await tx.unsafe(
          `INSERT INTO visit_schedule (visit_id, patient_id, renewal_id, clinician_id, start_at,
                                       end_at, status, booked_position)
           VALUES ($1, $2, $3, $4, $5::timestamptz, $6::timestamptz, 'booked', $7::bigint)
           ON CONFLICT (visit_id) DO NOTHING`,
          [
            event.data.visitId,
            event.data.patientId,
            event.data.renewalId ?? null,
            event.data.clinicianId ?? null,
            event.data.start,
            event.data.end,
            position,
          ],
        );
        return;
      case "VisitNoteSigned":
        await tx.unsafe(
          `UPDATE visit_schedule SET status = 'note_signed', note_id = $2
           WHERE visit_id = $1 AND status = 'booked'`,
          [event.data.visitId, event.data.noteId],
        );
        return;
      case "CalendarSlotCreated": {
        if (!stored.streamId.startsWith(VISIT_PREFIX)) {
          await recordAnomaly(
            tx,
            "visit_schedule",
            stored,
            "INVALID_EVENT",
            "CalendarSlotCreated outside a visit stream",
          );
          return;
        }
        const visitId = stored.streamId.slice(VISIT_PREFIX.length);
        await tx.unsafe(
          `INSERT INTO calendar_slots (slot_id, visit_id, clinician_id, start_at, end_at, position)
           VALUES ($1, $2, (SELECT clinician_id FROM visit_schedule WHERE visit_id = $2),
                   $3::timestamptz, $4::timestamptz, $5::bigint)
           ON CONFLICT (slot_id) DO NOTHING`,
          [event.data.slotId, visitId, event.data.start, event.data.end, position],
        );
        return;
      }
      case "FollowUpTaskCreated":
        await tx.unsafe(
          `INSERT INTO follow_up_tasks (task_id, patient_id, visit_id, status, position)
           VALUES ($1, $2, $3, 'requested', $4::bigint)
           ON CONFLICT (task_id) DO NOTHING`,
          [event.data.taskId, event.data.patientId, event.data.visitId ?? null, position],
        );
        return;
      default:
    }
  },

  async reset(tx: Db): Promise<void> {
    await tx.unsafe(`TRUNCATE visit_schedule, calendar_slots, follow_up_tasks`);
  },
};

const iso = (d: string | Date) => (d instanceof Date ? d : new Date(String(d))).toISOString();

interface VisitDbRow {
  visit_id: string;
  patient_id: string;
  renewal_id: string | null;
  clinician_id: string | null;
  start_at: string | Date;
  end_at: string | Date;
  status: "booked" | "note_signed";
  note_id: string | null;
}

/** Visits booked with a clinician (or all of them when no clinician is given), soonest first. */
export async function listVisits(db: Db, opts: { clinicianId?: string } = {}): Promise<VisitRow[]> {
  const rows = opts.clinicianId
    ? await db.unsafe<VisitDbRow[]>(
        `SELECT * FROM visit_schedule WHERE clinician_id = $1 ORDER BY start_at, visit_id`,
        [opts.clinicianId],
      )
    : await db.unsafe<VisitDbRow[]>(`SELECT * FROM visit_schedule ORDER BY start_at, visit_id`);
  return rows.map((r) => ({
    visitId: r.visit_id,
    patientId: r.patient_id,
    renewalId: r.renewal_id,
    clinicianId: r.clinician_id,
    start: iso(r.start_at),
    end: iso(r.end_at),
    status: r.status,
    noteId: r.note_id,
  }));
}

export async function listCalendarSlots(
  db: Db,
  opts: { clinicianId?: string } = {},
): Promise<CalendarSlotRow[]> {
  const rows = await db.unsafe<
    {
      slot_id: string;
      visit_id: string;
      clinician_id: string | null;
      start_at: string | Date;
      end_at: string | Date;
    }[]
  >(
    opts.clinicianId
      ? `SELECT * FROM calendar_slots WHERE clinician_id = $1 ORDER BY start_at, slot_id`
      : `SELECT * FROM calendar_slots ORDER BY start_at, slot_id`,
    opts.clinicianId ? [opts.clinicianId] : [],
  );
  return rows.map((r) => ({
    slotId: r.slot_id,
    visitId: r.visit_id,
    clinicianId: r.clinician_id,
    start: iso(r.start_at),
    end: iso(r.end_at),
  }));
}

export async function listFollowUpTasks(db: Db): Promise<FollowUpTaskRow[]> {
  const rows = await db.unsafe<
    { task_id: string; patient_id: string; visit_id: string | null; status: "requested" }[]
  >(`SELECT task_id, patient_id, visit_id, status FROM follow_up_tasks ORDER BY position`);
  return rows.map((r) => ({
    taskId: r.task_id,
    patientId: r.patient_id,
    visitId: r.visit_id,
    status: r.status,
  }));
}
