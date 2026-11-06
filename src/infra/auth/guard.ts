// Server-side RBAC guards. Fail closed: no valid session => 401 / redirect to /login;
// wrong role => 403 / redirect to /forbidden.
import "server-only";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { authorize, SESSION_COOKIE, verifySession, type Role, type Session } from "./session";

export class AuthError extends Error {
  constructor(
    public readonly status: 401 | 403,
    reason: string,
  ) {
    super(reason);
    this.name = "AuthError";
  }
}

export async function getSession(): Promise<Session | null> {
  const store = await cookies();
  return verifySession(store.get(SESSION_COOKIE)?.value);
}

/** Route handlers / server actions: throws AuthError (use authErrorResponse to map to a Response). */
export async function requireRole(...roles: Role[]): Promise<Session> {
  const d = authorize(await getSession(), roles);
  if (!d.ok) throw new AuthError(d.status, d.reason);
  return d.session;
}

export function authErrorResponse(err: unknown): Response {
  if (err instanceof AuthError) {
    return Response.json({ error: err.message }, { status: err.status });
  }
  throw err;
}

/** Server components: redirects instead of throwing. */
export async function requirePageRole(...roles: Role[]): Promise<Session> {
  const d = authorize(await getSession(), roles);
  if (!d.ok) redirect(d.status === 401 ? "/login" : "/forbidden");
  return d.session;
}
