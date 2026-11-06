"use server";
import { redirect } from "next/navigation";
import {
  checkInFromFormData,
  PatientInputError,
  submitPatientCheckIn,
  verifyPatientIdentity,
} from "../../_lib/renewal-service";
import type { CheckInFormState } from "../../_lib/check-in-content";
import { requirePatient, stepPath } from "../../_lib/session";

/** Identity verification. Wrong input redirects back with a generic message (no factor leaked). */
export async function verifyIdentityAction(renewalId: string, formData: FormData): Promise<void> {
  const { patientId, sql } = await requirePatient();
  let target: string;
  try {
    const outcome = await verifyPatientIdentity(sql, patientId, renewalId, {
      dateOfBirth: String(formData.get("dateOfBirth") ?? ""),
      lastName: String(formData.get("lastName") ?? ""),
    });
    target = outcome.ok
      ? stepPath(renewalId, "check-in")
      : `${stepPath(renewalId, "verify")}?error=${outcome.code}`;
  } catch (e) {
    if (!(e instanceof PatientInputError)) throw e;
    target = `/patient/renew?error=${encodeURIComponent(e.code)}`;
  }
  redirect(target);
}

/** Check-in: Zod-validated server side; field errors come back as form state. */
export async function submitCheckInAction(
  renewalId: string,
  _prev: CheckInFormState,
  formData: FormData,
): Promise<CheckInFormState> {
  const { patientId, sql } = await requirePatient();
  const answers = checkInFromFormData(formData);
  let outcome;
  try {
    outcome = await submitPatientCheckIn(sql, patientId, renewalId, answers);
  } catch (e) {
    if (!(e instanceof PatientInputError)) throw e;
    redirect(`/patient/renew?error=${encodeURIComponent(e.code)}`);
  }
  if (outcome.ok) redirect(stepPath(renewalId, "result"));
  return {
    attempt: _prev.attempt + 1,
    fieldErrors: outcome.fieldErrors,
    formError: outcome.formError ?? null,
    values: answers as CheckInFormState["values"],
  };
}
