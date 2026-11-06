"use server";
import { redirect } from "next/navigation";
import { PatientInputError, startRenewal } from "../_lib/renewal-service";
import { requirePatient, stepPath } from "../_lib/session";

/** Starts (or resumes) a renewal for the signed-in patient's own medication. */
export async function startRenewalAction(formData: FormData): Promise<void> {
  const { patientId, sql } = await requirePatient();
  let target: string;
  try {
    const { renewalId, next } = await startRenewal(sql, patientId, formData.get("prescriptionId"));
    target = stepPath(renewalId, next);
  } catch (e) {
    if (e instanceof PatientInputError) {
      target = `/patient/renew?error=${encodeURIComponent(e.code)}`;
    } else {
      throw e;
    }
  }
  redirect(target);
}
