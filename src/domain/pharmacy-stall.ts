// Which renewals are still "in flight" with the pharmacy or the care team, and which have stalled
// (accepted by the pharmacy but never filled). Pure: the clock is always passed in. The stale
// threshold is a demo configuration value, NOT a clinical threshold (TODO: source needed for a real
// value).

export const STALLED_CODE = "STALLED_NO_FILL";
/** Sent, but the transmission was never confirmed (e.g. a leased message reaped to dead). */
export const UNCONFIRMED_CODE = "TRANSMIT_UNCONFIRMED";
/**
 * Errors that mean "the pharmacy may still hold this prescription": the renewal stays UNSETTLED for
 * the duplicate-send guard until a clinician approves a newer renewal, which then SUPERSEDES it
 * (a CancelRx is queued in the same transaction) instead of both sending.
 */
export const SUPERSEDABLE_CODES: readonly string[] = [STALLED_CODE, UNCONFIRMED_CODE];
/** An approval with a confirmed pharmacy that was never queued for sending (alert, not silence). */
export const APPROVED_NOT_SENT_CODE = "APPROVED_NOT_SENT";
/** A fill arrived for a renewal that had been superseded: possible double fill, needs a person. */
export const FILL_AFTER_SUPERSEDE_CODE = "FILL_AFTER_SUPERSEDE";
/** A cancel acknowledgement arrived for a prescription that had already been filled. */
export const CANCEL_AFTER_FILL_CODE = "CANCEL_AFTER_FILL";
export const DEFAULT_STALE_HOURS = 72;

/** PHARMACY_STALE_HOURS (hours); anything unusable falls back to the default. */
export function staleHoursFrom(env: Record<string, string | undefined> = {}): number {
  const n = Number(env.PHARMACY_STALE_HOURS);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_STALE_HOURS;
}

export interface FlightRow {
  status: string;
  pharmacyStatus: string | null;
  /** ISO time of the last event on the renewal; absent => staleness cannot be judged. */
  updatedAt?: string;
}

const RESUMABLE = new Set(["requested", "identity_verified"]);
const TERMINAL = new Set([
  "approved",
  "denied",
  "follow_up_required",
  "filled",
  "cancelled",
  // superseded by a newer approved renewal; its CancelRx is on its way
  "cancel_requested",
]);
const AWAITING_PHARMACY = new Set(["queued", "transmitted", "pharmacy_status"]);

/** A renewal the pharmacy accepted (or should have) that has seen no fill for too long. */
export function isStalled(row: FlightRow, now: Date, staleHours: number): boolean {
  if (!AWAITING_PHARMACY.has(row.status) || !row.updatedAt) return false;
  const t = Date.parse(row.updatedAt);
  if (!Number.isFinite(t)) return false;
  return now.getTime() - t > staleHours * 3_600_000;
}

/**
 * True while the renewal blocks a NEW renewal of the same prescription. A stalled renewal stops
 * blocking (the patient is not stuck forever) but is still surfaced as an alert; the transmit
 * duplicate guard separately keeps treating it as unsettled so nothing is ever sent twice.
 * Unknown states count as in flight (fail closed).
 */
export function isInFlight(
  row: FlightRow,
  opts: { now?: Date; staleHours?: number } = {},
): boolean {
  if (RESUMABLE.has(row.status)) return false; // resumed, not blocked
  if (TERMINAL.has(row.status)) return false;
  if (row.status === "pharmacy_error") {
    // Final only when explicitly not retryable.
    return !(
      row.pharmacyStatus?.startsWith("ERROR:") && !row.pharmacyStatus.endsWith(":retryable")
    );
  }
  if (opts.now && isStalled(row, opts.now, opts.staleHours ?? DEFAULT_STALE_HOURS)) return false;
  return true;
}
