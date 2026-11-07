"use server";
// Clinician server actions (F042). Server-side RBAC: every action starts with
// requireRole("clinician") (401/403 are thrown as AuthError before any command runs). The clinician
// id is the verified session subject, never request input, and decide() re-checks the role.
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { DomainError } from "@/domain/aggregate";
import { approveRenewal, denyRenewal, startReview } from "@/domain/clinician/handlers";
import { bookClinicianVisit } from "@/domain/visit/handlers";
import { requireRole } from "@/infra/auth/guard";
import { getSql } from "@/infra/db/client";

export type ReviewActionResult = { ok: true } | { ok: false; code: string; message: string };

const Id = z.string().min(1).max(200);
const RenewalInput = z.object({ renewalId: Id });
const DenyInput = RenewalInput.extend({ reason: z.string().trim().min(1).max(500) });
const BookInput = RenewalInput.extend({
  start: z.iso.datetime({ offset: true }),
  end: z.iso.datetime({ offset: true }),
});

async function run<S extends z.ZodType<{ renewalId: string }>>(
  schema: S,
  raw: unknown,
  command: (actor: { role: "clinician"; id: string }, input: z.output<S>) => Promise<unknown>,
): Promise<ReviewActionResult> {
  // RBAC first: an unauthenticated or non-clinician caller learns nothing about the input.
  const session = await requireRole("clinician");
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, code: "INVALID_INPUT", message: "Check the form and try again." };
  }
  try {
    await command({ role: "clinician", id: session.sub }, parsed.data);
  } catch (e) {
    if (e instanceof DomainError) return { ok: false, code: e.code, message: e.message };
    throw e;
  }
  revalidatePath("/clinician/queue");
  return { ok: true };
}

export async function startReviewAction(renewalId: string): Promise<ReviewActionResult> {
  return run(RenewalInput, { renewalId }, (actor, i) => startReview(getSql(), actor, i));
}

export async function approveRenewalAction(renewalId: string): Promise<ReviewActionResult> {
  return run(RenewalInput, { renewalId }, (actor, i) => approveRenewal(getSql(), actor, i));
}

export async function denyRenewalAction(
  renewalId: string,
  reason: string,
): Promise<ReviewActionResult> {
  return run(DenyInput, { renewalId, reason }, (actor, i) => denyRenewal(getSql(), actor, i));
}

// The visit id is derived on the server (bookClinicianVisit); a client-supplied one is ignored.
export async function bookVisitAction(input: {
  renewalId: string;
  start: string;
  end: string;
}): Promise<ReviewActionResult> {
  return run(BookInput, input, (actor, i) => bookClinicianVisit(getSql(), actor, i));
}
