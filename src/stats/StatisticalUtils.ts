/** Whether CI was computed from block-level or sample-level resampling */
export type CILevel = "block" | "sample";

/** Stat descriptor for multi-bootstrap: known stat kinds enable zero-alloc inner loops */
export type StatKind = "mean" | "min" | "max" | { percentile: number };

/** Bootstrap estimate with confidence interval and raw resample distribution */
export interface BootstrapResult {
  /** Point estimate from the original sample */
  estimate: number;
  /** Confidence interval [lower, upper] from bootstrap resampling */
  ci: [number, number];
  /** Bootstrap resample distribution (for visualization) */
  samples: number[];
  /** Block-level (between-run) or sample-level (within-run) resampling */
  ciLevel: CILevel;
  /** Original sample count before subsampling (set only when cap applied) */
  subsampled?: number;
}

export type CIDirection = "faster" | "slower" | "uncertain" | "equivalent";

/** Binned histogram for efficient transfer to browser */
export interface HistogramBin {
  /** Bin center value */
  x: number;
  count: number;
}

/**
 * Bootstrap confidence interval for percentage difference between two sample medians.
 * Used for baseline comparisons: negative percent means current is faster.
 */
export interface DifferenceCI {
  /** Observed percentage difference (current - baseline) / baseline */
  percent: number;
  /** Confidence interval [lower, upper] in percent */
  ci: [number, number];
  /** Whether the CI excludes zero: "faster", "slower", or "uncertain" */
  direction: CIDirection;
  /** Bootstrap distribution histogram for visualization */
  histogram?: HistogramBin[];
  /** Label for the CI plot title (e.g. "mean Δ%") */
  label?: string;
  /** Blocks trimmed per side [baseline, current] via Tukey fences */
  trimmed?: [number, number];
  /** Block-level (between-run) or sample-level (within-run) resampling */
  ciLevel?: CILevel;
  /** false when batch count is too low for reliable CI */
  ciReliable?: boolean;
  /** Original sample count before subsampling (set only when cap applied) */
  subsampled?: number;
}

/** Options for bootstrap resampling */
type BootstrapOptions = {
  /** Number of bootstrap resamples (default: 10000) */
  resamples?: number;
  /** Confidence level 0-1 (default: 0.95) */
  confidence?: number;
};

interface StatOp {
  origIndex: number;
  compute: (buf: number[]) => number;
  pointEstimate: (s: number[]) => number;
}

export const defaultConfidence = 0.95;
export const bootstrapSamples = 10000;
export const maxBootstrapInput = 10_000;
const outlierMultiplier = 1.5;

/** Swap direction labels for higher-is-better metrics (positive = faster) */
export function swapDirection(ci: DifferenceCI): DifferenceCI {
  const swap: Record<CIDirection, CIDirection> = {
    faster: "slower",
    slower: "faster",
    uncertain: "uncertain",
    equivalent: "equivalent",
  };
  return { ...ci, direction: swap[ci.direction] };
}

/** Negate percent and CI for "higher is better" metrics (e.g., throughput) */
export function flipCI(ci: DifferenceCI): DifferenceCI {
  return {
    ...ci,
    percent: -ci.percent,
    ci: [-ci.ci[1], -ci.ci[0]],
    histogram: ci.histogram?.map(bin => ({ x: -bin.x, count: bin.count })),
  };
}

/** Compute a statistic from samples by kind */
export function computeStat(samples: number[], kind: StatKind): number {
  if (kind === "mean") return average(samples);
  if (kind === "min") return minOf(samples);
  if (kind === "max") return maxOf(samples);
  return percentile(samples, kind.percentile);
}

/** @return true if the stat kind supports bootstrap CI (min/max don't) */
export function isBootstrappable(kind: StatKind): boolean {
  return kind !== "min" && kind !== "max";
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

/** @return relative standard deviation (coefficient of variation) */
export function coefficientOfVariation(samples: number[]): number {
  const mean = average(samples);
  if (mean === 0) return 0;
  const stdDev = standardDeviation(samples);
  return stdDev / mean;
}

/** @return median absolute deviation for robust variability measure */
export function medianAbsoluteDeviation(samples: number[]): number {
  const med = median(samples);
  const deviations = samples.map(x => Math.abs(x - med));
  return median(deviations);
}

/** @return outliers detected via Tukey's interquartile range method */
export function findOutliers(samples: number[]): {
  rate: number;
  indices: number[];
} {
  const [lo, hi] = tukeyFences(samples, outlierMultiplier);
  const indices = samples.flatMap((v, i) => (v < lo || v > hi ? [i] : []));
  return { rate: indices.length / samples.length, indices };
}

/** Sample-level bootstrap CI: resample individual samples with replacement. */
export function sampleBootstrap(
  samples: number[],
  statFn: (s: number[]) => number,
  options: BootstrapOptions = {},
): BootstrapResult {
  const { resamples = bootstrapSamples, confidence: conf = defaultConfidence } =
    options;
  const sub = subsample(samples, maxBootstrapInput);
  const buf = new Array(sub.length);
  const stats = Array.from({ length: resamples }, () => {
    resampleInto(sub, buf);
    return statFn(buf);
  });
  return {
    estimate: statFn(samples),
    ci: computeInterval(stats, conf),
    samples: stats,
    ciLevel: "sample",
    ...(sub !== samples && { subsampled: samples.length }),
  };
}

/** Shared-resample bootstrap: one resample per iteration, all stats computed on it.
 *  Mean is computed first (non-destructive), then percentiles via in-place quickSelect. */
export function multiSampleBootstrap(
  samples: number[],
  stats: StatKind[],
  options: BootstrapOptions = {},
): BootstrapResult[] {
  const { resamples = bootstrapSamples, confidence: conf = defaultConfidence } =
    options;
  const sub = subsample(samples, maxBootstrapInput);
  const n = sub.length;
  const buf = new Array(n);
  const ops = buildStatOps(stats, n);
  const allStats = ops.map(() => new Array<number>(resamples));

  for (let i = 0; i < resamples; i++) {
    resampleInto(sub, buf);
    for (let j = 0; j < ops.length; j++) {
      allStats[j][i] = ops[j].compute(buf);
    }
  }

  const capped = sub !== samples;
  const results = new Array<BootstrapResult>(stats.length);
  for (let j = 0; j < ops.length; j++) {
    results[ops[j].origIndex] = {
      estimate: ops[j].pointEstimate(samples),
      ci: computeInterval(allStats[j], conf),
      samples: allStats[j],
      ciLevel: "sample",
      ...(capped && { subsampled: samples.length }),
    };
  }
  return results;
}

/** Bootstrap CIs for multiple stats, dispatching block vs sample automatically.
 *  Returns undefined for non-bootstrappable stats (min/max). */
export function bootstrapCIs(
  samples: number[],
  batchOffsets: number[] | undefined,
  stats: StatKind[],
  options?: BootstrapOptions,
): (BootstrapResult | undefined)[] {
  const bsStats = stats.filter(isBootstrappable);
  if (bsStats.length === 0) return stats.map(() => undefined);

  const hasBlocks = (batchOffsets?.length ?? 0) >= 2;
  const bsResults = hasBlocks
    ? bsStats.map(s =>
        blockBootstrap(samples, batchOffsets!, statKindToFn(s), options),
      )
    : multiSampleBootstrap(samples, bsStats, options);

  const results: (BootstrapResult | undefined)[] = new Array(stats.length);
  let bi = 0;
  for (let i = 0; i < stats.length; i++) {
    results[i] = isBootstrappable(stats[i]) ? bsResults[bi++] : undefined;
  }
  return results;
}

/** Convert StatKind to a stat function */
export function statKindToFn(kind: StatKind): (s: number[]) => number {
  if (kind === "mean") return average;
  if (kind === "min") return minOf;
  if (kind === "max") return maxOf;
  const p = kind.percentile;
  return (s: number[]) => percentile(s, p);
}

/** Block bootstrap CI: Tukey-trim outlier batches, then resample per-block
 *  statFn values as independent observations. Requires 2+ blocks. */
export function blockBootstrap(
  samples: number[],
  blocks: number[],
  statFn: (s: number[]) => number,
  options: BootstrapOptions = {},
): BootstrapResult {
  const { resamples = bootstrapSamples, confidence: conf = defaultConfidence } =
    options;
  const side = prepareBlocks(samples, blocks, statFn);
  const stats = Array.from({ length: resamples }, () =>
    average(createResample(side.blockVals)),
  );
  return {
    estimate: statFn(side.filtered),
    ci: computeInterval(stats, conf),
    samples: stats,
    ciLevel: "block",
  };
}

/** @return mean of values */
export function average(values: number[]): number {
  const sum = values.reduce((a, b) => a + b, 0);
  return sum / values.length;
}

/** @return median (50th percentile) of values */
export function median(values: number[]): number {
  return percentile(values, 0.5);
}

/** @return standard deviation with Bessel's correction */
export function standardDeviation(samples: number[]): number {
  if (samples.length <= 1) return 0;
  const mean = average(samples);
  const variance =
    samples.reduce((sum, x) => sum + (x - mean) ** 2, 0) / (samples.length - 1);
  return Math.sqrt(variance);
}

/** @return value at percentile p (0-1), using O(N) quickselect */
export function percentile(values: number[], p: number): number {
  const copy = values.slice();
  const k = Math.max(0, Math.ceil(copy.length * p) - 1);
  return quickSelect(copy, k);
}

/** Hoare's selection: O(N) average k-th smallest element. Mutates arr. */
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

/** Fill buf in-place with bootstrap resample (with replacement) from source */
export function resampleInto(source: number[], buf: number[]): void {
  const n = source.length;
  for (let i = 0; i < n; i++) {
    buf[i] = source[Math.floor(Math.random() * n)];
  }
}

/** @return bootstrap resample with replacement */
export function createResample(samples: number[]): number[] {
  const n = samples.length;
  return Array.from(
    { length: n },
    () => samples[Math.floor(Math.random() * n)],
  );
}

/** @return Tukey fence bounds [lo, hi] for the given IQR multiplier.
 *  minIqr prevents degenerate fences when values are tightly clustered. */
export function tukeyFences(
  values: number[],
  multiplier = 3,
  minIqr = 0,
): [lo: number, hi: number] {
  const q1 = percentile(values, 0.25);
  const q3 = percentile(values, 0.75);
  const iqr = Math.max(q3 - q1, minIqr);
  return [q1 - multiplier * iqr, q3 + multiplier * iqr];
}

/** @return indices of values below the upper 3x IQR Tukey fence.
 *  Only trims slow outliers — fast batches reflect less environmental noise, not errors.
 *  Floors IQR at 2% of median to avoid over-trimming tightly clustered batch means. */
export function tukeyKeep(values: number[]): number[] {
  if (values.length < 4) return values.map((_, i) => i);
  const minIqr = median(values) * 0.02;
  const [, hi] = tukeyFences(values, 3, minIqr);
  return values.flatMap((v, i) => (v <= hi ? [i] : []));
}

/** @return samples split into blocks by offset boundaries */
export function splitByOffsets(
  samples: number[],
  offsets: number[],
): number[][] {
  return offsets.map((start, i) => {
    const end = i + 1 < offsets.length ? offsets[i + 1] : samples.length;
    return samples.slice(start, end);
  });
}

/** @return per-block statistic values from sample data split by offsets */
export function blockValues(
  samples: number[],
  offsets: number[],
  fn: (s: number[]) => number,
): number[] {
  return splitByOffsets(samples, offsets).map(fn);
}

/** Tukey-trim outlier blocks and compute per-block statistic for one side */
export function prepareBlocks(
  samples: number[],
  offsets: number[],
  fn: (s: number[]) => number,
  noTrim?: boolean,
): { blockVals: number[]; filtered: number[]; trimCount: number } {
  const splits = splitByOffsets(samples, offsets);
  const means = splits.map(average);
  const keep = noTrim ? means.map((_, i) => i) : tukeyKeep(means);
  return {
    blockVals: keep.map(i => fn(splits[i])),
    filtered: keep.flatMap(i => splits[i]),
    trimCount: means.length - keep.length,
  };
}

/** Random subsample without replacement via partial Fisher-Yates. Returns original if n <= max. */
export function subsample(samples: number[], max: number): number[] {
  if (samples.length <= max) return samples;
  const copy = samples.slice();
  for (let i = 0; i < max; i++) {
    const j = i + Math.floor(Math.random() * (copy.length - i));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, max);
}

/** @return confidence interval [lower, upper] */
export function computeInterval(
  values: number[],
  conf: number,
): [number, number] {
  const alpha = (1 - conf) / 2;
  return [percentile(values, alpha), percentile(values, 1 - alpha)];
}

/** Build stat operations in safe order: mean/min/max first (non-destructive),
 *  then percentiles ascending (use quickSelect which mutates buf) */
function buildStatOps(stats: StatKind[], n: number): StatOp[] {
  const simple = (order: number, i: number, fn: (s: number[]) => number) => ({
    order,
    compute: fn,
    pointEstimate: fn,
    origIndex: i,
  });
  const ops = stats.map((s, i): StatOp & { order: number } => {
    if (s === "mean") return simple(-3, i, average);
    if (s === "min") return simple(-2, i, minOf);
    if (s === "max") return simple(-1, i, maxOf);
    const p = s.percentile;
    const k = Math.max(0, Math.ceil(n * p) - 1);
    return {
      order: p,
      origIndex: i,
      compute: (buf: number[]) => quickSelect(buf, k),
      pointEstimate: (v: number[]) => percentile(v, p),
    };
  });
  ops.sort((a, b) => a.order - b.order);
  return ops;
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
