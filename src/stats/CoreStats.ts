/** Stat descriptor for multi-bootstrap: known stat kinds enable zero-alloc inner loops */
export type StatKind = "mean" | "min" | "max" | { percentile: number };

/** One bucket of an {@link integerCounts} tally: a distinct value and how often
 *  it occurred. */
export interface IntegerCount {
  value: number;
  count: number;
}

/** Compute a statistic from samples by kind */
export function computeStat(samples: number[], kind: StatKind): number {
  if (kind === "mean") return mean(samples);
  if (kind === "min") return minOf(samples);
  if (kind === "max") return maxOf(samples);
  return percentile(samples, kind.percentile);
}

/** @return true if the stat kind supports bootstrap CI (min/max don't) */
export function isBootstrappable(kind: StatKind): boolean {
  return kind !== "min" && kind !== "max";
}

/** Convert StatKind to a stat function */
export function statKindToFn(kind: StatKind): (s: number[]) => number {
  if (kind === "mean") return mean;
  if (kind === "min") return minOf;
  if (kind === "max") return maxOf;
  const p = kind.percentile;
  return (s: number[]) => percentile(s, p);
}

/** The non-percentile stat kinds (mean/min/max) compute without mutating their
 *  input, so staged bootstrap builders run them before the destructive
 *  percentile selects. @return the reducer plus its sort order, or undefined for
 *  a percentile kind (the caller sequences that by its own fraction). */
export function nonPercentileStat(
  kind: StatKind,
): { order: number; fn: (s: number[]) => number } | undefined {
  if (kind === "mean") return { order: -3, fn: mean };
  if (kind === "min") return { order: -2, fn: minOf };
  if (kind === "max") return { order: -1, fn: maxOf };
  return undefined;
}

/** @return smallest value in samples (loop to avoid spread-arg limits) */
export function minOf(samples: number[]): number {
  let min = samples[0];
  for (let i = 1; i < samples.length; i++) {
    if (samples[i] < min) min = samples[i];
  }
  return min;
}

/** @return largest value in samples (loop to avoid spread-arg limits) */
export function maxOf(samples: number[]): number {
  let max = samples[0];
  for (let i = 1; i < samples.length; i++) {
    if (samples[i] > max) max = samples[i];
  }
  return max;
}

/** @return mean of values */
export function mean(values: number[]): number {
  const sum = values.reduce((a, b) => a + b, 0);
  return sum / values.length;
}

/** @return median (50th percentile) of values */
export function median(values: number[]): number {
  return percentile(values, 0.5);
}

/** @return value at percentile p (0-1), using O(N) quickselect */
export function percentile(values: number[], p: number): number {
  const copy = values.slice();
  return quickSelect(copy, percentileIndex(copy.length, p));
}

/** @return 0-based index of percentile p (0-1) in an n-element sorted array. */
export function percentileIndex(n: number, p: number): number {
  return Math.max(0, Math.ceil(n * p) - 1);
}

/** Hoare's selection: O(N) mean k-th smallest element. Mutates arr. */
export function quickSelect(arr: number[], k: number): number {
  let lo = 0;
  let hi = arr.length - 1;
  while (lo < hi) {
    const [i, j] = partition(arr, lo, hi);
    if (k <= j) hi = j;
    else if (k >= i) lo = i;
    else break;
  }
  return arr[k];
}

/** @return standard deviation with Bessel's correction */
export function standardDeviation(samples: number[]): number {
  if (samples.length <= 1) return 0;
  const avg = mean(samples);
  const variance =
    samples.reduce((sum, x) => sum + (x - avg) ** 2, 0) / (samples.length - 1);
  return Math.sqrt(variance);
}

/** @return relative standard deviation (coefficient of variation) */
export function coefficientOfVariation(samples: number[]): number {
  const avg = mean(samples);
  if (avg === 0) return 0;
  const stdDev = standardDeviation(samples);
  return stdDev / avg;
}

/** @return median absolute deviation for robust variability measure */
export function medianAbsoluteDeviation(samples: number[]): number {
  const med = median(samples);
  const deviations = samples.map(x => Math.abs(x - med));
  return median(deviations);
}

/** Running totals of an array: result[i] = sum of values[0..i]. Used to turn
 *  per-sample durations into loop-relative end times for placing GC events. */
export function cumulativeSum(values: number[]): number[] {
  const out = new Array<number>(values.length);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    out[i] = sum;
  }
  return out;
}

/** Index of the first cumulative end time at or past `offset`, i.e. the sample
 *  whose window contains a loop-relative offset; the last sample when `offset`
 *  is past the end. `endTimes` is a {@link cumulativeSum} of sample durations. */
export function sampleIndexAtOffset(
  offset: number,
  endTimes: number[],
): number {
  const idx = endTimes.findIndex(t => t >= offset);
  return idx >= 0 ? idx : endTimes.length - 1;
}

/** Tally how often each distinct integer appears, sorted by value ascending. */
export function integerCounts(values: number[]): IntegerCount[] {
  const counts = new Map<number, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts]
    .sort((a, b) => a[0] - b[0])
    .map(([value, count]) => ({ value, count }));
}

/** Hoare partition around the midpoint pivot. @return [i, j] boundary indices. */
function partition(arr: number[], lo: number, hi: number): [number, number] {
  const pivot = arr[lo + ((hi - lo) >> 1)];
  let i = lo;
  let j = hi;
  while (i <= j) {
    while (arr[i] < pivot) i++;
    while (arr[j] > pivot) j--;
    if (i <= j) {
      [arr[i], arr[j]] = [arr[j], arr[i]];
      i++;
      j--;
    }
  }
  return [i, j];
}
