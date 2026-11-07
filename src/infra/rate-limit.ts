// Minimal in-memory fixed-window rate limiter keyed by (route, client IP).
//
// PER-INSTANCE, BEST EFFORT: state lives in the memory of one server process. On a serverless
// platform every warm instance has its own counters and a cold start resets them, so this slows
// accidental floods and naive guessing; it is not a distributed or abuse-proof limiter. Put a real
// edge/WAF limit in front of anything exposed beyond a demo.
//
// The client IP comes from the proxy headers. On Vercel x-forwarded-for is set by the platform;
// elsewhere a client can spoof it unless a trusted proxy overwrites it. We use the RIGHTMOST entry
// (the one appended by the proxy nearest to us); without any header all callers share one bucket,
// which is the strict direction.

export interface RateLimitConfig {
  /** Max requests per window per key. */
  limit: number;
  windowMs: number;
}

export interface RateLimitResult {
  ok: boolean;
  limit: number;
  remaining: number;
  retryAfterSeconds: number;
}

interface Bucket {
  count: number;
  resetAt: number;
}

const MAX_BUCKETS = 10_000;
const buckets = new Map<string, Bucket>();

/** Test helper: forget all counters. */
export function resetRateLimits(): void {
  buckets.clear();
}

function prune(now: number): void {
  for (const [k, b] of buckets) if (b.resetAt <= now) buckets.delete(k);
  // Still too big (many distinct live keys): drop the oldest insertions. Best effort by design.
  while (buckets.size >= MAX_BUCKETS) {
    const first = buckets.keys().next();
    if (first.done) break;
    buckets.delete(first.value);
  }
}

export function rateLimit(
  key: string,
  cfg: RateLimitConfig,
  now: number = Date.now(),
): RateLimitResult {
  let b = buckets.get(key);
  if (!b || b.resetAt <= now) {
    if (buckets.size >= MAX_BUCKETS) prune(now);
    b = { count: 0, resetAt: now + cfg.windowMs };
    buckets.set(key, b);
  }
  b.count += 1;
  const ok = b.count <= cfg.limit;
  return {
    ok,
    limit: cfg.limit,
    remaining: Math.max(0, cfg.limit - b.count),
    retryAfterSeconds: Math.max(1, Math.ceil((b.resetAt - now) / 1000)),
  };
}

interface HeaderReader {
  get(name: string): string | null;
}

export function clientIp(headers: HeaderReader): string {
  const xff = headers.get("x-forwarded-for");
  if (xff) {
    const parts = xff
      .split(",")
      .map((p) => p.trim())
      .filter(Boolean);
    const last = parts[parts.length - 1];
    if (last) return last.slice(0, 64);
  }
  const real = headers.get("x-real-ip")?.trim();
  return real ? real.slice(0, 64) : "unknown";
}

/** Fixed budgets. Cron and pharmacy numbers leave ample headroom for the legitimate callers. */
export const LIMITS = {
  cron: { limit: 30, windowMs: 60_000 },
  mockPharmacy: { limit: 120, windowMs: 60_000 },
  login: { limit: 20, windowMs: 60_000 },
} as const satisfies Record<string, RateLimitConfig>;

/** Login budget per minute; LOGIN_RATE_LIMIT_PER_MIN overrides it (e2e only; never raise in production). */
export function loginLimit(env: Record<string, string | undefined> = process.env): RateLimitConfig {
  const n = Number(env.LOGIN_RATE_LIMIT_PER_MIN);
  return Number.isInteger(n) && n >= 1 ? { ...LIMITS.login, limit: n } : LIMITS.login;
}

/** Returns a 429 Response when the caller is over budget for this route, otherwise null. */
export function enforceRateLimit(
  request: Request,
  route: string,
  cfg: RateLimitConfig,
): Response | null {
  const r = rateLimit(`${route}:${clientIp(request.headers)}`, cfg);
  if (r.ok) return null;
  return Response.json(
    { error: "rate_limited" },
    { status: 429, headers: { "Retry-After": String(r.retryAfterSeconds) } },
  );
}
