// Helpers for the follow-up specs (F051/F053): identity lookup for a seeded patient.
import { e2eSql } from "./clinician";

/** Reads the synthetic identity factors of a seeded patient from its PatientRegistered event. */
export async function seededIdentity(patientId: string) {
  const sql = e2eSql();
  try {
    const [row] = await sql<{ data: { lastName: string; dateOfBirth: string } }[]>`
      SELECT data FROM events
       WHERE stream_id = ${`patient-${patientId}`} AND type = 'PatientRegistered' LIMIT 1`;
    if (!row) throw new Error(`e2e: patient ${patientId} is not seeded`);
    return row.data;
  } finally {
    await sql.end();
  }
}

/** Event types on a stream, in order (read-only assertions). */
export async function streamTypes(streamId: string): Promise<string[]> {
  const sql = e2eSql();
  try {
    const rows = await sql<{ type: string }[]>`
      SELECT type FROM events WHERE stream_id = ${streamId} ORDER BY stream_version`;
    return rows.map((r) => r.type);
  } finally {
    await sql.end();
  }
}
