"use server";
// Clinician visit-note signing (F052). Server-side RBAC first: requireRole("clinician") throws
// 401/403 before any input is read. The clinician id is the verified session subject, never form
// input; the note id is derived from the visit id so a double submit signs the same note once.
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { DomainError } from "@/domain/aggregate";
import { signingNow } from "@/domain/visit/clock";
import { signVisitNote } from "@/domain/visit/handlers";
import { requireRole } from "@/infra/auth/guard";
import { getSql } from "@/infra/db/client";

const Input = z.object({ visitId: z.string().min(1).max(200) });

export async function signVisitNoteAction(formData: FormData): Promise<void> {
  const session = await requireRole("clinician");
  const parsed = Input.safeParse({ visitId: String(formData.get("visitId") ?? "") });
  if (!parsed.success) redirect("/clinician/visits?error=INVALID_INPUT");
  const { visitId } = parsed.data;
  let target = "/clinician/visits";
  try {
    await signVisitNote(
      getSql(),
      { role: "clinician", id: session.sub },
      { visitId, noteId: `note-${visitId}` },
      signingNow(new Date()),
    );
  } catch (e) {
    if (!(e instanceof DomainError)) throw e;
    target += `?error=${encodeURIComponent(e.code)}`;
  }
  revalidatePath("/clinician/visits");
  redirect(target);
}
