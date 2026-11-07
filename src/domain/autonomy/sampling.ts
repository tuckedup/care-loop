// Seeded, deterministic sampling for retrospective review (F060). Pure: no clocks, no Math.random.
// The decision depends ONLY on (seed, renewalId, rate), so replaying a renewal always gives the
// same answer and a rebuild never reshuffles which approvals were selected.
import { createHash } from "node:crypto";

/** Uniform value in [0, 1) derived from the seed and the renewal id. */
export function sampleUnit(seed: number, renewalId: string): number {
  const digest = createHash("sha256").update(`careloop-sample:${seed}:${renewalId}`).digest();
  // 48 bits are exactly representable in a double.
  return digest.readUIntBE(0, 6) / 2 ** 48;
}

/**
 * True when this renewal falls in the sampled share. rate 0 => never, rate >= 1 => always.
 * An invalid rate (NaN, negative) selects nothing: callers validate it with Zod first, and this
 * function never throws.
 */
export function isSampled(seed: number, renewalId: string, rate: number): boolean {
  if (!Number.isFinite(rate) || rate <= 0) return false;
  if (rate >= 1) return true;
  return sampleUnit(seed, renewalId) < rate;
}

export const SAMPLE_REASON = {
  /** RETRO mode: every auto-approval is reviewed afterwards. */
  RETRO_ALL: "RETRO_ALL",
  /** SAMPLED mode: this renewal fell in the seeded SAMPLE_RATE share. */
  SAMPLED_RANDOM: "SAMPLED_RANDOM",
} as const;

/**
 * The AuditSampleSelected reason for an auto-approval, or null when it is not queued for review.
 * Only RETRO and SAMPLED auto-approve at all, so any other mode returns null.
 */
export function sampleReasonFor(
  mode: string,
  seed: number,
  renewalId: string,
  rate: number,
): string | null {
  if (mode === "RETRO") return SAMPLE_REASON.RETRO_ALL;
  if (mode === "SAMPLED" && isSampled(seed, renewalId, rate)) return SAMPLE_REASON.SAMPLED_RANDOM;
  return null;
}
