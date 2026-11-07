// Production guards for the demo auth. Pure functions of an env object so they are unit-testable.
// Default deny: in production a weak/placeholder SESSION_SECRET makes every session invalid, and the
// role switcher stays off unless DEMO_AUTH_ENABLED is exactly "true".
//
// This is demo auth, not real authentication. These guards stop an accidental deploy from running
// with the public template secret or an open role switcher; they do not make it production auth.

export const MIN_SECRET_LENGTH = 32;

/** The SESSION_SECRET value shipped in .env.example. Public, so never acceptable in production. */
export const DEV_PLACEHOLDER_SECRET = "dev-only-change-me-dev-only-change-me";
const DEV_PLACEHOLDER_PREFIX = "dev-only-change-me";

/**
 * Variables that exist only to script end-to-end tests. Each is already ignored unless NODE_ENV is
 * exactly "development" or "test"; hardening.test.ts proves it for every name in this list.
 */
export const DEV_TEST_ONLY_SWITCHES = [
  "MOCK_PHARMACY_FORCE",
  "RISK_FIXTURE",
  "SUMMARY_FIXTURE",
  "VISIT_CLOCK_OFFSET_DAYS",
] as const;

type Env = Record<string, string | undefined>;

export function isProduction(env: Env = process.env): boolean {
  return env.NODE_ENV === "production";
}

export type SecretProblem = "missing" | "too_short" | "dev_placeholder";

/** Why the SESSION_SECRET is unusable, or null. The placeholder is only a problem in production. */
export function sessionSecretProblem(env: Env = process.env): SecretProblem | null {
  const s = env.SESSION_SECRET;
  if (!s) return "missing";
  if (s.length < MIN_SECRET_LENGTH) return "too_short";
  if (isProduction(env) && s.startsWith(DEV_PLACEHOLDER_PREFIX)) return "dev_placeholder";
  return null;
}

/** The secret to sign/verify with, or null (=> no session can be created or verified). */
export function usableSessionSecret(env: Env = process.env): string | null {
  return sessionSecretProblem(env) === null ? (env.SESSION_SECRET as string) : null;
}

/**
 * Whether the demo role switcher (and any demo session) is allowed.
 * Production: only when DEMO_AUTH_ENABLED is exactly "true" (default deny).
 * Elsewhere: allowed unless explicitly set to "false".
 */
export function demoAuthEnabled(env: Env = process.env): boolean {
  if (isProduction(env)) return env.DEMO_AUTH_ENABLED === "true";
  return env.DEMO_AUTH_ENABLED !== "false";
}
