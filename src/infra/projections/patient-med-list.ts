import type { Db, StoredEvent } from "@/infra/event-store/types";
import { eventSchemas, type EventData } from "@/domain/events";
import type { Projection } from "./runner";

export type MedStatus = "active" | "stopped";

export interface MedRow {
  prescriptionId: string;
  patientId: string;
  rxcui: string;
  drugName: string;
  doseMg: number;
  frequency: unknown;
  status: MedStatus;
  doseChanged: boolean;
  prescribedAt: string; // ISO-8601
  stoppedAt: string | null;
  lastPosition: bigint;
}

/**
 * Pure rule: SPEC section 3 has no explicit "stop medication" event, so a new prescription of the
 * same drug (rxcui) for the same patient supersedes the earlier active one. The earlier row becomes
 * "stopped"; the new row is "active" and doseChanged when its dose differs from the one it replaced.
 */
export function applyPrescribed(
  activeSameDrug: readonly MedRow[],
  data: EventData<"MedicationPrescribed">,
  meta: { position: bigint; at: string },
): { stop: string[]; insert: MedRow } {
  const previous = [...activeSameDrug].sort((a, b) =>
    a.lastPosition < b.lastPosition ? 1 : -1,
  )[0];
  return {
    stop: activeSameDrug.map((r) => r.prescriptionId),
    insert: {
      prescriptionId: data.prescriptionId,
      patientId: data.patientId,
      rxcui: data.rxcui,
      drugName: data.drugName,
      doseMg: data.dose.amountMg,
      frequency: data.frequency,
      status: "active",
      doseChanged: previous !== undefined && previous.doseMg !== data.dose.amountMg,
      prescribedAt: meta.at,
      stoppedAt: null,
      lastPosition: meta.position,
    },
  };
}

interface MedDbRow {
  prescription_id: string;
  patient_id: string;
  rxcui: string;
  drug_name: string;
  dose_mg: number;
  frequency: unknown;
  status: MedStatus;
  dose_changed: boolean;
  prescribed_at: string | Date;
  stopped_at: string | Date | null;
  last_position: string;
}

const iso = (v: string | Date) => (v instanceof Date ? v : new Date(String(v))).toISOString();

export function toMedRow(r: MedDbRow): MedRow {
  return {
    prescriptionId: r.prescription_id,
    patientId: r.patient_id,
    rxcui: r.rxcui,
    drugName: r.drug_name,
    doseMg: r.dose_mg,
    frequency: r.frequency,
    status: r.status,
    doseChanged: r.dose_changed,
    prescribedAt: iso(r.prescribed_at),
    stoppedAt: r.stopped_at === null ? null : iso(r.stopped_at),
    lastPosition: BigInt(r.last_position),
  };
}

export const patientMedListProjection: Projection = {
  name: "patient_med_list",

  async handle(tx: Db, event: StoredEvent): Promise<void> {
    if (event.type !== "MedicationPrescribed") return;
    const data = eventSchemas.MedicationPrescribed.parse(event.data);
    const at = event.createdAt.toISOString();
    const active = (
      await tx.unsafe<MedDbRow[]>(
        `SELECT * FROM patient_med_list
         WHERE patient_id = $1 AND rxcui = $2 AND status = 'active' FOR UPDATE`,
        [data.patientId, data.rxcui],
      )
    ).map(toMedRow);
    const { stop, insert } = applyPrescribed(active, data, { position: event.globalPosition, at });
    for (const id of stop) {
      await tx.unsafe(
        `UPDATE patient_med_list SET status = 'stopped', stopped_at = $2::timestamptz
         WHERE prescription_id = $1`,
        [id, at],
      );
    }
    await tx.unsafe(
      `INSERT INTO patient_med_list
         (prescription_id, patient_id, rxcui, drug_name, dose_mg, frequency, status,
          dose_changed, prescribed_at, stopped_at, last_position)
       VALUES ($1, $2, $3, $4, $5, $6::text::jsonb, 'active', $7, $8::timestamptz, NULL, $9::bigint)
       ON CONFLICT (prescription_id) DO NOTHING`,
      [
        insert.prescriptionId,
        insert.patientId,
        insert.rxcui,
        insert.drugName,
        insert.doseMg,
        JSON.stringify(insert.frequency),
        insert.doseChanged,
        insert.prescribedAt,
        insert.lastPosition.toString(),
      ],
    );
  },

  async reset(tx: Db): Promise<void> {
    await tx.unsafe(`TRUNCATE patient_med_list`);
  },
};

/** Read helper for UI/API code. */
export async function listPatientMeds(
  sql: Db,
  patientId: string,
  opts: { status?: MedStatus } = {},
): Promise<MedRow[]> {
  const rows = await sql.unsafe<MedDbRow[]>(
    `SELECT * FROM patient_med_list WHERE patient_id = $1
       AND ($2::text IS NULL OR status = $2) ORDER BY last_position ASC`,
    [patientId, opts.status ?? null],
  );
  return rows.map(toMedRow);
}
