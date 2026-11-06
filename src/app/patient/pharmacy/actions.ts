"use server";
import { redirect } from "next/navigation";
import { confirmPatientPharmacy } from "../_lib/pharmacy-service";
import { PatientInputError } from "../_lib/renewal-service";
import { requirePatient, stepPath } from "../_lib/session";

/** Records the confirmed pharmacy on the patient's renewal, then continues to the check-in. */
export async function confirmRenewalPharmacyAction(formData: FormData): Promise<void> {
  const { patientId, sql } = await requirePatient();
  const renewalId = String(formData.get("renewalId") ?? "");
  const pharmacyId = formData.get("pharmacyId");
  let target: string;
  try {
    await confirmPatientPharmacy(sql, patientId, renewalId, pharmacyId);
    target = stepPath(renewalId, "check-in");
  } catch (e) {
    if (!(e instanceof PatientInputError)) throw e;
    target = e.code.startsWith("PHARMACY_")
      ? `/patient/pharmacy?renewalId=${encodeURIComponent(renewalId)}&pharmacyId=${encodeURIComponent(String(pharmacyId ?? ""))}`
      : `/patient/renew?error=${encodeURIComponent(e.code)}`;
  }
  redirect(target);
}
