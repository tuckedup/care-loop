"use server";
// Queue "open" action: opening an item for review calls the StartReview command (status becomes
// in-progress) and then shows the visit view. The clinician id is the session subject.
import { redirect } from "next/navigation";
import { z } from "zod";
import { getSession } from "@/infra/auth/guard";
import { startReviewAction } from "./review-actions";

const Id = z.string().min(1).max(200);

export async function openRenewalAction(formData: FormData): Promise<void> {
  const session = await getSession();
  if (!session) redirect("/login");
  if (session.role !== "clinician" && session.role !== "admin") redirect("/forbidden");
  const parsed = Id.safeParse(formData.get("renewalId"));
  if (!parsed.success) redirect("/clinician/queue");
  const target = `/clinician/renewals/${encodeURIComponent(parsed.data)}`;
  // Admins are read-only: they view without starting a review.
  if (session.role !== "clinician") redirect(target);
  const result = await startReviewAction(parsed.data);
  redirect(result.ok ? target : `${target}?notice=${encodeURIComponent(result.code)}`);
}
