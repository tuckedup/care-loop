// Test-only clock offset for the signing gate (e2e cannot wait for a booked slot to arrive).
// DEFAULT DENY: the offset is honoured only when NODE_ENV is exactly "development" or "test" AND
// VISIT_CLOCK_OFFSET_DAYS is a whole number of days in 1..365. Production ignores it, so a signed
// note there always needs the real clock to have reached the visit start. Booking never uses it.
export function signingNow(
  real: Date,
  env: Record<string, string | undefined> = process.env,
): Date {
  const raw = env.VISIT_CLOCK_OFFSET_DAYS;
  if (!raw || !/^\d{1,3}$/.test(raw)) return real;
  if (env.NODE_ENV !== "development" && env.NODE_ENV !== "test") return real;
  const days = Number(raw);
  if (days < 1 || days > 365) return real;
  return new Date(real.getTime() + days * 86_400_000);
}
