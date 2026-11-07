// Demo auth session: HMAC-SHA256 signed cookie value. Not production auth.
// Format: v1.<base64url(JSON payload)>.<base64url(HMAC over "v1.<payload>")>
import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { MIN_SECRET_LENGTH, usableSessionSecret } from "./production-guards";

export const ROLES = ["patient", "clinician", "pharmacist", "admin"] as const;
export type Role = (typeof ROLES)[number];

export const SESSION_COOKIE = "careloop_demo_session";
export const SESSION_VERSION = 1;
export const SESSION_TTL_SECONDS = 8 * 60 * 60;
const MAX_CLOCK_SKEW_SECONDS = 60;

// Synthetic subject ids, one per demo role.
export const DEMO_SUBJECTS: Record<Role, string> = {
  patient: "patient-demo-001",
  clinician: "clinician-demo-001",
  pharmacist: "pharmacist-demo-001",
  admin: "admin-demo-001",
};

export const sessionPayloadSchema = z.object({
  v: z.literal(SESSION_VERSION),
  role: z.enum(ROLES),
  sub: z.string().min(1).max(128),
  iat: z.number().int().nonnegative(),
});
export type Session = z.infer<typeof sessionPayloadSchema>;

export function getSecret(env: Record<string, string | undefined> = process.env): string | null {
  // Fail closed: missing/short secrets, and in production the .env.example placeholder, give null.
  return usableSessionSecret(env);
}

function mac(data: string, secret: string): Buffer {
  return createHmac("sha256", secret).update(data).digest();
}

/** Throws if the secret is missing or too short (fail closed: never signs unkeyed). */
export function signSession(
  input: { role: Role; sub: string },
  opts: { secret?: string | null; nowSeconds?: number } = {},
): string {
  const secret = opts.secret === undefined ? getSecret() : opts.secret;
  if (!secret || secret.length < MIN_SECRET_LENGTH) {
    throw new Error("SESSION_SECRET is missing or too short");
  }
  const payload: Session = sessionPayloadSchema.parse({
    v: SESSION_VERSION,
    role: input.role,
    sub: input.sub,
    iat: opts.nowSeconds ?? Math.floor(Date.now() / 1000),
  });
  const body = `v${SESSION_VERSION}.${Buffer.from(JSON.stringify(payload)).toString("base64url")}`;
  return `${body}.${mac(body, secret).toString("base64url")}`;
}

/** Returns the session, or null for any missing/tampered/expired/invalid input. Never throws. */
export function verifySession(
  value: string | null | undefined,
  opts: { secret?: string | null; nowSeconds?: number } = {},
): Session | null {
  try {
    const secret = opts.secret === undefined ? getSecret() : opts.secret;
    if (!value || !secret || secret.length < MIN_SECRET_LENGTH) return null;
    const parts = value.split(".");
    if (parts.length !== 3 || parts[0] !== `v${SESSION_VERSION}`) return null;
    const body = `${parts[0]}.${parts[1]}`;
    const given = Buffer.from(parts[2]!, "base64url");
    const expected = mac(body, secret);
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
    const parsed = sessionPayloadSchema.safeParse(
      JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")),
    );
    if (!parsed.success) return null;
    const now = opts.nowSeconds ?? Math.floor(Date.now() / 1000);
    const age = now - parsed.data.iat;
    if (age > SESSION_TTL_SECONDS || age < -MAX_CLOCK_SKEW_SECONDS) return null;
    return parsed.data;
  } catch {
    return null;
  }
}

export type AuthDecision =
  | { ok: true; session: Session }
  | { ok: false; status: 401 | 403; reason: "unauthenticated" | "forbidden" };

/** Pure RBAC decision. No session => 401; role not allowed (or no roles listed) => 403. */
export function authorize(session: Session | null, allowed: readonly Role[]): AuthDecision {
  if (!session) return { ok: false, status: 401, reason: "unauthenticated" };
  if (!allowed.includes(session.role)) return { ok: false, status: 403, reason: "forbidden" };
  return { ok: true, session };
}
