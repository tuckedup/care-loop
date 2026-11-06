"use server";
// Patient follow-up booking (F051). The patient id is the verified session subject; the slot end is
// derived on the server (never trusted from the form). Booking never approves a renewal.
import { redirect } from "next/navigation";
import { z } from "zod";
import { DomainError } from "@/domain/aggregate";
import { bookFollowUpVisit } from "@/domain/visit/handlers";
import { SLOT_MINUTES } from "@/domain/visit/slots";
import { requirePatient } from "../../_lib/session";

const Input = z.object({
  renewalId: z.string().min(1).max(200),
  start: z.iso.datetime({ offset: true }),
});

export async function bookFollowUpAction(formData: FormData): Promise<void> {
  const { patientId, sql } = await requirePatient();
  const parsed = Input.safeParse({
    renewalId: String(formData.get("renewalId") ?? ""),
    start: String(formData.get("start") ?? ""),
  });
  if (!parsed.success) redirect("/patient/status");
  const { renewalId, start } = parsed.data;
  const end = new Date(Date.parse(start) + SLOT_MINUTES * 60_000).toISOString();
  let target = `/patient/follow-up/${encodeURIComponent(renewalId)}`;
  try {
    await bookFollowUpVisit(sql, { role: "patient", id: patientId }, { renewalId, start, end });
  } catch (e) {
    if (!(e instanceof DomainError)) throw e;
    target += `?error=${encodeURIComponent(e.code)}`;
  }
  redirect(target);
}
