// Patient pharmacy step (F047): list the fake pharmacies and record the confirmed selection on
// the patient's own renewal. Framework-free so it is unit-testable against Postgres.
import type { Sql } from "postgres";
import { DomainError } from "@/domain/aggregate";
import { selectPharmacy, type Pharmacy } from "@/domain/pharmacy";
import { selectedPharmacyId, selectRenewalPharmacy } from "@/domain/pharmacy-selection";
import { loadStream } from "@/domain/aggregate-handler";
import { renewalStreamId } from "@/domain/renewal/renewal";
import { getOwnedRenewal, PatientInputError } from "./renewal-service";

export async function listPharmacies(sql: Sql): Promise<Pharmacy[]> {
  const rows = await sql.unsafe<Pharmacy[]>(
    `SELECT id, name, address, phone FROM pharmacies ORDER BY name, id`,
  );
  return [...rows];
}

/** True when the renewal stream already carries a PharmacySelected. */
export async function renewalHasPharmacy(sql: Sql, renewalId: string): Promise<boolean> {
  const { events } = await loadStream(sql, renewalStreamId(renewalId));
  return selectedPharmacyId(events) !== null;
}

/**
 * Records the patient's confirmed pharmacy. The renewal must be the patient's own (404-style
 * error otherwise) and the id must be a known pharmacy: nothing is guessed or defaulted.
 */
export async function confirmPatientPharmacy(
  sql: Sql,
  patientId: string,
  renewalId: string,
  rawPharmacyId: unknown,
): Promise<void> {
  if (!(await getOwnedRenewal(sql, patientId, renewalId))) {
    throw new PatientInputError("NOT_FOUND", "Renewal not found.");
  }
  const selection = selectPharmacy(await listPharmacies(sql), rawPharmacyId);
  if (!selection.ok)
    throw new PatientInputError(`PHARMACY_${selection.error}`, "Choose a pharmacy from the list.");
  try {
    await selectRenewalPharmacy(
      sql,
      { renewalId, pharmacy: selection.pharmacy },
      { actor: patientId, role: "patient", action: "patient:SelectPharmacy" },
    );
  } catch (e) {
    if (e instanceof DomainError) throw new PatientInputError(e.code, e.message);
    throw e;
  }
}
