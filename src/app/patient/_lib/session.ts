// Shared helpers for patient pages and server actions (server only).
import "server-only";
import { redirect } from "next/navigation";
import { requirePageRole } from "@/infra/auth/guard";
import { getSql } from "@/infra/db/client";
import { getOwnedRenewal, nextStepFor, type NextStep } from "./renewal-service";

/** Patient session; redirects to /login or /forbidden otherwise. The id is the session subject. */
export async function requirePatient() {
  const session = await requirePageRole("patient");
  return { patientId: session.sub, sql: getSql() };
}

export const stepPath = (renewalId: string, step: NextStep) =>
  step === "verify" ? `/patient/renew/${renewalId}` : `/patient/renew/${renewalId}/${step}`;

/**
 * Loads the renewal for the signed-in patient (404 if it is not theirs) and redirects to the
 * correct page when the patient is on the wrong step.
 */
export async function loadRenewalForStep(renewalId: string, step: NextStep) {
  const { patientId, sql } = await requirePatient();
  const renewal = await getOwnedRenewal(sql, patientId, renewalId);
  if (!renewal) redirect("/patient/renew?error=NOT_FOUND");
  const expected = nextStepFor(renewal.status);
  if (expected !== step) redirect(stepPath(renewalId, expected));
  return { patientId, sql, renewal };
}
