"use server";
// Admin server action: change the autonomy mode (F059). Server-side RBAC first: requireRole("admin")
// throws 401/403 before anything is parsed or written. The actor is the verified session subject,
// never request input; the aggregate re-checks the role. Zod validates the mode at the boundary.
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { DomainError } from "@/domain/aggregate";
import { setAutonomyMode } from "@/domain/autonomy/mode";
import { AutonomyModeSchema } from "@/domain/events";
import { requireRole } from "@/infra/auth/guard";
import { getSql } from "@/infra/db/client";

export type AutonomyActionResult =
  | { ok: true; mode: z.infer<typeof AutonomyModeSchema> }
  | { ok: false; code: string; message: string };

const Input = z.object({ mode: AutonomyModeSchema });

export async function setAutonomyModeAction(raw: unknown): Promise<AutonomyActionResult> {
  const session = await requireRole("admin");
  const parsed = Input.safeParse({ mode: raw });
  if (!parsed.success) {
    return { ok: false, code: "INVALID_INPUT", message: "Unknown autonomy mode." };
  }
  try {
    await setAutonomyMode(getSql(), { role: "admin", id: session.sub }, { mode: parsed.data.mode });
  } catch (e) {
    if (e instanceof DomainError) return { ok: false, code: e.code, message: e.message };
    throw e;
  }
  revalidatePath("/admin/autonomy");
  revalidatePath("/admin/dashboard");
  return { ok: true, mode: parsed.data.mode };
}

/** Form entry point used by the page. The result is shown by the re-rendered page. */
export async function autonomyFormAction(formData: FormData): Promise<void> {
  await setAutonomyModeAction(formData.get("mode"));
}
