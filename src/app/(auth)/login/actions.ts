"use server";
// Demo auth only: lets anyone pick a role. Not a real authentication mechanism.
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";
import { demoAuthEnabled } from "@/infra/auth/production-guards";
import { clientIp, loginLimit, rateLimit } from "@/infra/rate-limit";
import {
  DEMO_SUBJECTS,
  getSecret,
  ROLES,
  SESSION_COOKIE,
  SESSION_TTL_SECONDS,
  signSession,
} from "@/infra/auth/session";

const homeByRole = {
  patient: "/patient/renew",
  clinician: "/clinician/queue",
  pharmacist: "/pharmacist/inbox",
  admin: "/admin",
} as const;

const switchSchema = z.object({ role: z.enum(ROLES) });

export async function switchRole(formData: FormData): Promise<void> {
  // Production default deny: the switcher mints sessions only when DEMO_AUTH_ENABLED=true.
  if (!demoAuthEnabled()) redirect("/login?error=disabled");
  // Per-instance best-effort throttle on minting sessions.
  if (!rateLimit(`login:${clientIp(await headers())}`, loginLimit()).ok) {
    redirect("/login?error=rate-limited");
  }
  // Fail closed: no usable SESSION_SECRET (missing, short, or the dev placeholder in production).
  if (!getSecret()) redirect("/login?error=not-configured");
  const parsed = switchSchema.safeParse({ role: formData.get("role") });
  if (!parsed.success) redirect("/login?error=invalid-role");
  const { role } = parsed.data;
  const store = await cookies();
  store.set(SESSION_COOKIE, signSession({ role, sub: DEMO_SUBJECTS[role] }), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: SESSION_TTL_SECONDS,
  });
  redirect(homeByRole[role]);
}

export async function signOut(): Promise<void> {
  const store = await cookies();
  store.delete(SESSION_COOKIE);
  redirect("/login");
}
