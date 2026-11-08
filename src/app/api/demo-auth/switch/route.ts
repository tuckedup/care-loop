import { NextResponse } from "next/server";
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

const switchSchema = z.object({ role: z.enum(ROLES) });
const homeByRole = {
  patient: "/patient/renew",
  clinician: "/clinician/queue",
  pharmacist: "/pharmacist/inbox",
  admin: "/admin",
} as const;

export async function POST(request: Request) {
  const url = new URL(request.url);
  if (request.headers.get("origin") !== url.origin) {
    return NextResponse.redirect(new URL("/login?error=invalid-origin", url), 303);
  }
  if (!demoAuthEnabled()) return NextResponse.redirect(new URL("/login?error=disabled", url), 303);
  if (!rateLimit(`login:${clientIp(request.headers)}`, loginLimit()).ok) {
    return NextResponse.redirect(new URL("/login?error=rate-limited", url), 303);
  }
  if (!getSecret()) return NextResponse.redirect(new URL("/login?error=not-configured", url), 303);

  const formData = await request.formData();
  const parsed = switchSchema.safeParse({ role: formData.get("role") });
  if (!parsed.success) return NextResponse.redirect(new URL("/login?error=invalid-role", url), 303);

  const response = NextResponse.redirect(new URL(homeByRole[parsed.data.role], url), 303);
  response.cookies.set(
    SESSION_COOKIE,
    signSession({ role: parsed.data.role, sub: DEMO_SUBJECTS[parsed.data.role] }),
    {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: SESSION_TTL_SECONDS,
    },
  );
  return response;
}
