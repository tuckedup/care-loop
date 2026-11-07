// Server-side read models for the clinician UI. Reads only: projections plus event reads for
// display. Every write goes through the clinician command handlers.
import "server-only";
import type { Sql } from "postgres";
import { parseEvent, type DomainEvent } from "@/domain/events";
import { findPendingRenewals } from "@/domain/pipeline/process-manager";
import { patientStreamId } from "@/domain/patient/patient";
import { renewalStreamId } from "@/domain/renewal/renewal";
import { readStream } from "@/infra/event-store";
import { registerAllProjections } from "@/infra/projections/all";
import { listPatientMeds, type MedRow } from "@/infra/projections/patient-med-list";
import { getPhq9Trend, type TrendPoint } from "@/infra/projections/phq9-trend";
import { listRenewalQueue, type RenewalQueueRow } from "@/infra/projections/renewal-queue";
import { runAllProjections } from "@/infra/projections/registry";
import { eventSourceId, noteSourceId } from "./view-model";

export async function syncProjections(sql: Sql): Promise<void> {
  await runAllProjections(sql, registerAllProjections());
}

export interface QueueItem {
  row: RenewalQueueRow;
  drugName: string | null;
  /** No EligibilityEvaluated yet: shown as 'Awaiting evaluation', never hidden. */
  awaitingEvaluation: boolean;
  checkInSubmitted: boolean;
}

/** Event-derived facts per renewal id (check-in present / evaluation present). */
async function renewalFacts(sql: Sql, ids: string[]) {
  const checkedIn = new Set<string>();
  const evaluated = new Set<string>();
  if (ids.length === 0) return { checkedIn, evaluated };
  const rows = await sql.unsafe<{ type: string; renewal_id: string }[]>(
    `SELECT type, data->>'renewalId' AS renewal_id FROM events
      WHERE type IN ('CheckInSubmitted','EligibilityEvaluated')
        AND data->>'renewalId' = ANY($1::text[])`,
    [ids] as never[],
  );
  for (const r of rows) (r.type === "CheckInSubmitted" ? checkedIn : evaluated).add(r.renewal_id);
  return { checkedIn, evaluated };
}

export async function loadQueueItems(sql: Sql): Promise<QueueItem[]> {
  await syncProjections(sql);
  const rows = await listRenewalQueue(sql);
  const { checkedIn, evaluated } = await renewalFacts(
    sql,
    rows.map((r) => r.renewalId),
  );
  const medsByPatient = new Map<string, MedRow[]>();
  const drugFor = async (r: RenewalQueueRow) => {
    if (!r.patientId) return null;
    if (!medsByPatient.has(r.patientId)) {
      medsByPatient.set(r.patientId, await listPatientMeds(sql, r.patientId));
    }
    return (
      medsByPatient.get(r.patientId)!.find((m) => m.prescriptionId === r.prescriptionId)
        ?.drugName ?? null
    );
  };
  const items: QueueItem[] = [];
  for (const row of rows) {
    items.push({
      row,
      drugName: await drugFor(row),
      // Fail visible: unevaluated when the projection says no outcome OR no evaluation event exists.
      awaitingEvaluation: row.outcome === null || !evaluated.has(row.renewalId),
      checkInSubmitted: checkedIn.has(row.renewalId),
    });
  }
  // Safety net: a check-in whose renewal is missing from the projection is still listed.
  const known = new Set(rows.map((r) => r.renewalId));
  for (const id of await findPendingRenewals(sql, 100)) {
    if (known.has(id)) continue;
    items.push({
      row: {
        renewalId: id,
        patientId: null,
        prescriptionId: null,
        status: "requested",
        outcome: null,
        escalated: false,
        reasonCodes: [],
        riskSignalCount: 0,
        clinicianId: null,
        decision: null,
        decidedBy: null,
        decisionClinicianId: null,
        anomalies: ["NOT_IN_QUEUE_PROJECTION"],
        requestedAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
        lastPosition: 0n,
        requestPosition: 0n,
      },
      drugName: null,
      awaitingEvaluation: true,
      checkInSubmitted: true,
    });
  }
  return items;
}

export interface SourceEvent {
  /** Citation id: evt-<global position>. */
  id: string;
  type: string;
  at: string;
  event: DomainEvent;
}

export interface VisitNote {
  noteId: string;
  /** Sanitised citation / anchor id (note-...), never equal to an evt-N id. */
  sourceId: string;
  visitId: string;
  clinicianId: string;
  eventId: string;
  at: string;
}
export interface PriorVisit {
  visitId: string;
  start: string;
  end: string;
  eventId: string;
}

export interface VisitData {
  row: RenewalQueueRow;
  patientName: string | null;
  events: SourceEvent[];
  meds: MedRow[];
  trend: TrendPoint[];
  visits: PriorVisit[];
  notes: VisitNote[];
}

function parseAll(stored: Awaited<ReturnType<typeof readStream>>): SourceEvent[] {
  const out: SourceEvent[] = [];
  for (const s of stored) {
    try {
      out.push({
        id: eventSourceId(s.globalPosition),
        type: s.type,
        at: s.createdAt.toISOString(),
        event: parseEvent({ type: s.type, data: s.data }),
      });
    } catch {
      // Schema-invalid events are not displayed (and so cannot be cited).
    }
  }
  return out;
}

export async function loadVisitData(sql: Sql, renewalId: string): Promise<VisitData | null> {
  await syncProjections(sql);
  const row = (await listRenewalQueue(sql)).find((r) => r.renewalId === renewalId);
  if (!row) return null;
  const events = parseAll(await readStream(sql, renewalStreamId(renewalId)));
  let patientName: string | null = null;
  let meds: MedRow[] = [];
  let trend: TrendPoint[] = [];
  const visits: PriorVisit[] = [];
  const notes: VisitNote[] = [];
  if (row.patientId) {
    meds = await listPatientMeds(sql, row.patientId);
    trend = await getPhq9Trend(sql, row.patientId);
    const reg = parseAll(await readStream(sql, patientStreamId(row.patientId))).find(
      (e) => e.event.type === "PatientRegistered",
    );
    if (reg && reg.event.type === "PatientRegistered") {
      patientName = `${reg.event.data.firstName} ${reg.event.data.lastName}`;
    }
    const booked = await sql.unsafe<{ global_position: string; type: string; data: unknown }[]>(
      `SELECT global_position, type, data FROM events
        WHERE type = 'VisitBooked' AND data->>'patientId' = $1 ORDER BY global_position`,
      [row.patientId] as never[],
    );
    const bookedEvents = booked.flatMap((b) => {
      try {
        return [
          { id: eventSourceId(b.global_position), e: parseEvent({ type: b.type, data: b.data }) },
        ];
      } catch {
        return [];
      }
    });
    for (const b of bookedEvents) {
      // A clinician booking is recorded twice (renewal stream and visit stream): show it once.
      if (b.e.type !== "VisitBooked") continue;
      const booked = b.e.data;
      if (!visits.some((v) => v.visitId === booked.visitId)) {
        visits.push({
          visitId: booked.visitId,
          start: booked.start,
          end: booked.end,
          eventId: b.id,
        });
      }
    }
    if (visits.length > 0) {
      const signed = await sql.unsafe<
        { global_position: string; type: string; data: unknown; created_at: Date }[]
      >(
        `SELECT global_position, type, data, created_at FROM events
          WHERE type = 'VisitNoteSigned' AND data->>'visitId' = ANY($1::text[])
          ORDER BY global_position`,
        [visits.map((v) => v.visitId)] as never[],
      );
      for (const s of signed) {
        try {
          const e = parseEvent({ type: s.type, data: s.data });
          if (e.type === "VisitNoteSigned") {
            notes.push({
              noteId: e.data.noteId,
              sourceId: noteSourceId(e.data.noteId),
              visitId: e.data.visitId,
              clinicianId: e.data.clinicianId,
              eventId: eventSourceId(s.global_position),
              at: new Date(s.created_at).toISOString(),
            });
          }
        } catch {
          // ignore invalid
        }
      }
    }
  }
  return { row, patientName, events, meds, trend, visits, notes };
}
