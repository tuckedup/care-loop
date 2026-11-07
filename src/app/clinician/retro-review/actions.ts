"use server";
// Retrospective review server action (F060). Server-side RBAC first: requireRole("clinician")
// throws 401/403 before any input is parsed. The reviewer id is the verified session subject,
// never request input; the aggregate re-checks the role and the one-review-per-renewal rule.
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { DomainError } from "@/domain/aggregate";
import { recordRetroReview } from "@/domain/autonomy/retro-review";
import { requireRole } from "@/infra/auth/guard";
import { getSql } from "@/infra/db/client";

export type RetroReviewResult = { ok: true } | { ok: false; code: string; message: string };

const Input = z.object({ renewalId: z.string().min(1).max(200), concur: z.boolean() });

export async function recordRetroReviewAction(
  renewalId: unknown,
  concur: unknown,
): Promise<RetroReviewResult> {
  const session = await requireRole("clinician");
  const parsed = Input.safeParse({ renewalId, concur });
  if (!parsed.success) {
    return { ok: false, code: "INVALID_INPUT", message: "Check the form and try again." };
  }
  try {
    await recordRetroReview(getSql(), { role: "clinician", id: session.sub }, parsed.data);
  } catch (e) {
    if (e instanceof DomainError) return { ok: false, code: e.code, message: e.message };
    throw e;
  }
  revalidatePath("/clinician/retro-review");
  revalidatePath("/admin/dashboard");
  return { ok: true };
}

/** Form entry point: the page re-renders with the recorded outcome (or the unchanged row). */
export async function retroReviewFormAction(formData: FormData): Promise<void> {
  const concur = formData.get("concur");
  await recordRetroReviewAction(
    formData.get("renewalId"),
    concur === "yes" ? true : concur === "no" ? false : undefined,
  );
}
