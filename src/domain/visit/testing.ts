// Test support: the approval path needs a patient-confirmed pharmacy (F048). Synthetic data only.
// Imported by tests, never by app code.
import type { Sql } from "postgres";
import { ensurePharmacy, PHARMACY_ID } from "@/infra/outbox/test-fixture";
import { selectRenewalPharmacy } from "../pharmacy-selection";
import { CALM_CHECK_IN, seedRenewal, type ScenarioOptions } from "../pipeline/testing";
import { submitCheckIn } from "../renewal/handlers";

export async function confirmTestPharmacy(sql: Sql, renewalId: string, patientId: string) {
  await ensurePharmacy(sql);
  await selectRenewalPharmacy(
    sql,
    {
      renewalId,
      pharmacy: {
        id: PHARMACY_ID,
        name: "Test Pharmacy (synthetic)",
        address: "1 Elm Street, Faketown",
        phone: "(555) 010-0000",
      },
    },
    { actor: patientId, role: "patient", action: "test:confirm-pharmacy" },
  );
}

/** Like seedRenewal, but the patient confirms a pharmacy BEFORE the check-in (so it can be approved). */
export async function seedConfirmedRenewal(sql: Sql, opts: ScenarioOptions = {}) {
  const s = await seedRenewal(sql, { ...opts, skipCheckIn: true });
  await confirmTestPharmacy(sql, s.renewalId, s.patientId);
  await submitCheckIn(
    sql,
    { renewalId: s.renewalId, ...CALM_CHECK_IN, ...opts.checkIn },
    { actor: s.patientId, role: "patient", action: "test:check-in" },
  );
  return s;
}
