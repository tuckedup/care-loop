// Statistics for repeated live runs.
//
// passHatK: the tau-bench consistency metric. With n trials of one task and c successes, the
//   unbiased estimate of "all k sampled trials succeed" is C(c,k)/C(n,k). For a safety property
//   (every escalation must escalate) this is the number to read, not the average.
// clusteredSe: standard error of a mean when items come in correlated groups (cases of one
//   category share phrasing), following the clustered estimator in "Adding Error Bars to Evals".
//   It is sqrt(sum over clusters of (sum of deviations)^2) / N, with no small-sample correction.

export function passHatK(n: number, c: number, k: number): number {
  if (![n, c, k].every(Number.isInteger) || n <= 0 || k <= 0 || k > n || c < 0 || c > n) {
    throw new RangeError("passHatK needs integers with 0 <= c <= n and 0 < k <= n");
  }
  if (c < k) return 0;
  let p = 1;
  for (let i = 0; i < k; i++) p *= (c - i) / (n - i);
  return p;
}

export function mean(xs: readonly number[]): number {
  if (xs.length === 0) throw new RangeError("mean of an empty list");
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

/** Standard error of the mean of `values`, allowing for correlation inside each `clusters` label. */
export function clusteredSe(values: readonly number[], clusters: readonly string[]): number {
  if (values.length !== clusters.length || values.length === 0) {
    throw new RangeError("clusteredSe needs equal-length, non-empty inputs");
  }
  const m = mean(values);
  const sums = new Map<string, number>();
  values.forEach((v, i) => sums.set(clusters[i]!, (sums.get(clusters[i]!) ?? 0) + (v - m)));
  let ss = 0;
  for (const s of sums.values()) ss += s * s;
  return Math.sqrt(ss) / values.length;
}
