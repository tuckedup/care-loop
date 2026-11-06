import { timingSafeEqual } from "node:crypto";

/** Constant-time bearer check. Missing/empty CRON_SECRET => always false (fail closed). */
export function isCronAuthorized(header: string | null, secret: string | undefined): boolean {
  if (!secret || !header) return false;
  const m = /^Bearer (.+)$/.exec(header);
  if (!m) return false;
  const a = Buffer.from(m[1]!);
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}
