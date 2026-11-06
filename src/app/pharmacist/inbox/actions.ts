"use server";
// Server-side RBAC first: only a pharmacist or admin may acknowledge; the actor id is the verified
// session subject, never request input.
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { DomainError } from "@/domain/aggregate";
import { acknowledgeAlert } from "@/domain/pharmacist";
import { requireRole } from "@/infra/auth/guard";
import { getSql } from "@/infra/db/client";

const Input = z.object({
  renewalId: z.string().min(1).max(200),
  messageId: z.string().min(1).max(200),
});

export async function acknowledgeAlertAction(formData: FormData): Promise<void> {
  const session = await requireRole("pharmacist", "admin");
  const parsed = Input.safeParse({
    renewalId: formData.get("renewalId"),
    messageId: formData.get("messageId"),
  });
  if (!parsed.success) return;
  try {
    await acknowledgeAlert(getSql(), { role: session.role, id: session.sub }, parsed.data);
  } catch (e) {
    if (!(e instanceof DomainError)) throw e;
  }
  revalidatePath("/pharmacist/inbox");
  revalidatePath("/clinician/pharmacy-alerts");
}
