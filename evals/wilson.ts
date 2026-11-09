// 95% Wilson score interval for a proportion k/n. Used to report eval recall with its uncertainty:
// a perfect score on a small set still has a wide lower bound, so never read 116/116 as "100%".
export function wilsonInterval(k: number, n: number, z = 1.96): { low: number; high: number } {
  if (!Number.isInteger(k) || !Number.isInteger(n) || n <= 0 || k < 0 || k > n) {
    throw new RangeError("wilsonInterval needs integers with 0 <= k <= n and n > 0");
  }
  const p = k / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return { low: Math.max(0, centre - half), high: Math.min(1, centre + half) };
}
