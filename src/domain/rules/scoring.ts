// PHQ-9 / GAD-7 scoring. Bands per the clinical-rules skill. Invalid data yields null (fail closed).

export type Phq9Band = "minimal" | "mild" | "moderate" | "moderately_severe" | "severe";
export type Gad7Band = "minimal" | "mild" | "moderate" | "severe";

// Every index 0..length-1 must be present (sparse arrays skip holes in every/reduce) and valid.
const validItems = (items: unknown, length: number): items is readonly number[] => {
  if (!Array.isArray(items) || items.length !== length) return false;
  for (let i = 0; i < length; i++) {
    if (!(i in items)) return false;
    const n: unknown = items[i];
    if (typeof n !== "number" || !Number.isInteger(n) || n < 0 || n > 3) return false;
  }
  return true;
};

/** Sum of nine items scored 0-3 (0-27). Item 9 is also reported separately. null if invalid. */
export function scorePhq9(items: readonly number[]): number | null {
  if (!validItems(items, 9)) return null;
  return items.reduce((a, b) => a + b, 0);
}

/** Sum of seven items scored 0-3 (0-21). null if invalid. */
export function scoreGad7(items: readonly number[]): number | null {
  if (!validItems(items, 7)) return null;
  return items.reduce((a, b) => a + b, 0);
}

/** PHQ-9 item 9 (index 8), scored separately. null if the response set is invalid. */
export function phq9Item9(items: readonly number[]): number | null {
  if (!validItems(items, 9)) return null;
  return items[8] ?? null;
}

export function phq9Band(total: number): Phq9Band | null {
  if (!Number.isInteger(total) || total < 0 || total > 27) return null;
  if (total <= 4) return "minimal";
  if (total <= 9) return "mild";
  if (total <= 14) return "moderate";
  if (total <= 19) return "moderately_severe";
  return "severe";
}

export function gad7Band(total: number): Gad7Band | null {
  if (!Number.isInteger(total) || total < 0 || total > 21) return null;
  if (total <= 4) return "minimal";
  if (total <= 9) return "mild";
  if (total <= 14) return "moderate";
  return "severe";
}
