/** Pure display helpers for the admin dashboard. */

export function formatPercent(rate: number | null): string {
  if (rate === null || !Number.isFinite(rate)) return "n/a";
  return `${(rate * 100).toFixed(1)}%`;
}

/** Seconds as a short human duration ("42 s", "5 min 3 s", "2 h 10 min", "3 d 4 h"). */
export function formatDuration(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds) || seconds < 0) return "n/a";
  const s = Math.round(seconds);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ${s % 60} s`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} h ${m % 60} min`;
  return `${Math.floor(h / 24)} d ${h % 24} h`;
}
