// Synthetic scheduling grid for follow-up visits. Pure: no clock (callers pass `now`).
// Slots are 30-minute blocks on weekdays 09:00-17:00 UTC for the synthetic clinician. This is demo
// scheduling policy, NOT a clinical threshold; the grid and horizon are placeholders
// (TODO: real availability source).
import { DomainError } from "../aggregate";

export const SLOT_MINUTES = 30;
export const FIRST_SLOT_HOUR_UTC = 9;
/** Exclusive end of the working day: the last slot ends at this hour. */
export const LAST_SLOT_END_HOUR_UTC = 17;
export const BOOKING_HORIZON_DAYS = 28;
/** Default gap between a signed visit and the follow-up calendar slot (synthetic placeholder). */
export const FOLLOW_UP_INTERVAL_DAYS = 28;

const MS_MIN = 60_000;
const MS_DAY = 86_400_000;

export interface Slot {
  start: string;
  end: string;
}

/** Canonical UTC ISO string (milliseconds, Z). Throws DomainError on an unparseable instant. */
export function canonicalInstant(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) {
    throw new DomainError("INVALID_SLOT", "slot time is not a valid instant");
  }
  return new Date(t).toISOString();
}

function onGrid(startMs: number): boolean {
  const d = new Date(startMs);
  const day = d.getUTCDay();
  if (day === 0 || day === 6) return false;
  if (d.getUTCSeconds() !== 0 || d.getUTCMilliseconds() !== 0) return false;
  if (d.getUTCMinutes() % SLOT_MINUTES !== 0) return false;
  const minuteOfDay = d.getUTCHours() * 60 + d.getUTCMinutes();
  return (
    minuteOfDay >= FIRST_SLOT_HOUR_UTC * 60 &&
    minuteOfDay + SLOT_MINUTES <= LAST_SLOT_END_HOUR_UTC * 60
  );
}

/**
 * A bookable slot: on the grid, exactly SLOT_MINUTES long, strictly in the future and inside the
 * booking horizon. Throws a DomainError otherwise; returns the canonical start/end.
 */
export function validateSlot(start: string, end: string, now: Date): Slot {
  const s = Date.parse(start);
  const e = Date.parse(end);
  if (!Number.isFinite(s) || !Number.isFinite(e)) {
    throw new DomainError("INVALID_SLOT", "slot time is not a valid instant");
  }
  if (s <= now.getTime()) throw new DomainError("SLOT_IN_PAST", "the slot must be in the future");
  if (s > now.getTime() + BOOKING_HORIZON_DAYS * MS_DAY) {
    throw new DomainError("SLOT_TOO_FAR", "the slot is beyond the booking window");
  }
  if (!onGrid(s) || e - s !== SLOT_MINUTES * MS_MIN) {
    throw new DomainError("INVALID_SLOT", "not an offered appointment slot");
  }
  return { start: new Date(s).toISOString(), end: new Date(e).toISOString() };
}

/** All offered slots from the next UTC day through the booking horizon, in time order. */
export function generateSlots(now: Date, days = BOOKING_HORIZON_DAYS): Slot[] {
  const base = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const out: Slot[] = [];
  for (let d = 1; d <= Math.min(days, BOOKING_HORIZON_DAYS); d++) {
    const dayStart = base + d * MS_DAY;
    for (
      let m = FIRST_SLOT_HOUR_UTC * 60;
      m + SLOT_MINUTES <= LAST_SLOT_END_HOUR_UTC * 60;
      m += SLOT_MINUTES
    ) {
      const s = dayStart + m * MS_MIN;
      if (!onGrid(s) || s > now.getTime() + BOOKING_HORIZON_DAYS * MS_DAY) continue;
      out.push({
        start: new Date(s).toISOString(),
        end: new Date(s + SLOT_MINUTES * MS_MIN).toISOString(),
      });
    }
  }
  return out;
}

/** True when two half-open intervals overlap. */
export function overlaps(a: Slot, b: Slot): boolean {
  return Date.parse(a.start) < Date.parse(b.end) && Date.parse(b.start) < Date.parse(a.end);
}

/** Follow-up calendar slot: the signed visit's slot shifted by FOLLOW_UP_INTERVAL_DAYS. */
export function followUpSlotFor(visit: Slot): Slot {
  const shift = FOLLOW_UP_INTERVAL_DAYS * MS_DAY;
  return {
    start: new Date(Date.parse(visit.start) + shift).toISOString(),
    end: new Date(Date.parse(visit.end) + shift).toISOString(),
  };
}
