/** Bootstrap estimate with confidence interval and raw resample distribution */
export interface BootstrapResult {
  /** Point estimate from the original sample */
  estimate: number;
  /** Confidence interval [lower, upper] from bootstrap resampling */
  ci: [number, number];
  /** Bootstrap resample distribution (for visualization) */
  samples: number[];
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
}

/** Options for bootstrap resampling methods */
type BootstrapOptions = {
  /** Number of bootstrap resamples (default: 10000) */
  resamples?: number;
  /** Confidence level 0-1 (default: 0.95) */
  confidence?: number;
  /** Custom stat function applied to both samples (default: median) */
  statFn?: (s: number[]) => number;
  /** Block boundaries for block bootstrap (indices where each batch starts) */
  blocks?: number[];
};

/** Options for bootstrapDifferenceCI with per-side block boundaries */
type DiffBootstrapOptions = BootstrapOptions & {
  /** Block boundaries for the second sample array */
  blocksB?: number[];
  /** Equivalence margin in percent. CI within [-margin, +margin] ==> "equivalent" */
  equivMargin?: number;
};
const defaultConfidence = 0.95;
const outlierMultiplier = 1.5;
const bootstrapSamples = 10000;

/** Swap direction labels for higher-is-better metrics (positive = faster) */
export function swapDirection(ci: DifferenceCI): DifferenceCI {
  const swapped: Record<CIDirection, CIDirection> = {
    faster: "slower",
    slower: "faster",
    uncertain: "uncertain",
    equivalent: "equivalent",
  };
  return { ...ci, direction: swapped[ci.direction] };
}

/** Negate percent and CI for "higher is better" metrics (e.g., throughput) */
export function flipCI(ci: DifferenceCI): DifferenceCI {
  return {
    percent: -ci.percent,
    ci: [-ci.ci[1], -ci.ci[0]],
    direction: ci.direction,
    histogram: ci.histogram?.map(bin => ({ x: -bin.x, count: bin.count })),
  };
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
  const median = percentile(samples, 0.5);
  const deviations = samples.map(x => Math.abs(x - median));
  return percentile(deviations, 0.5);
}

/** @return outliers detected via Tukey's interquartile range method */
export function findOutliers(samples: number[]): {
  rate: number;
  indices: number[];
} {
  const [lo, hi] = tukeyFences(samples, outlierMultiplier);
  const indices = samples
    .map((v, i) => (v < lo || v > hi ? i : -1))
    .filter(i => i >= 0);
  return { rate: indices.length / samples.length, indices };
}

/** @return bootstrap confidence interval for median */
export function bootstrapMedian(
  samples: number[],
  options: BootstrapOptions = {},
): BootstrapResult {
  return bootstrapStat(samples, s => percentile(s, 0.5), options);
}

/** @return bootstrap CI for an arbitrary statistic function */
export function bootstrapStat(
  samples: number[],
  statFn: (s: number[]) => number,
  options: BootstrapOptions = {},
): BootstrapResult {
  const { resamples = bootstrapSamples, confidence: conf = defaultConfidence } =
    options;
  // With blocks: apply statFn per block (independent observations), then
  // resample those block-level values. This keeps CIs in the metric's native
  // domain (e.g. lines/sec) rather than raw time.
  const blockVals = options.blocks
    ? blockValues(samples, options.blocks, statFn)
    : undefined;
  const draw = blockVals
    ? () => average(createResample(blockVals))
    : () => statFn(createResample(samples));
  const stats = Array.from({ length: resamples }, draw);
  return {
    estimate: statFn(samples),
    ci: computeInterval(stats, conf),
    samples: stats,
  };
}

/** @return mean of values */
export function average(values: number[]): number {
  const sum = values.reduce((a, b) => a + b, 0);
  return sum / values.length;
}

/** @return standard deviation with Bessel's correction */
export function standardDeviation(samples: number[]): number {
  if (samples.length <= 1) return 0;
  const mean = average(samples);
  const variance =
    samples.reduce((sum, x) => sum + (x - mean) ** 2, 0) / (samples.length - 1);
  return Math.sqrt(variance);
}

/** @return value at percentile p (0-1) */
export function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.ceil(sorted.length * p) - 1;
  return sorted[Math.max(0, index)];
}

/** @return bootstrap resample with replacement */
export function createResample(samples: number[]): number[] {
  const n = samples.length;
  return Array.from(
    { length: n },
    () => samples[Math.floor(Math.random() * n)],
  );
}

/** @return Tukey fence bounds [lo, hi] for the given IQR multiplier */
export function tukeyFences(
  values: number[],
  multiplier = 3,
): [lo: number, hi: number] {
  const q1 = percentile(values, 0.25);
  const q3 = percentile(values, 0.75);
  const iqr = q3 - q1;
  return [q1 - multiplier * iqr, q3 + multiplier * iqr];
}

/** @return indices of values within 3x IQR Tukey fences */
function tukeyKeep(values: number[]): number[] {
  if (values.length < 4) return values.map((_, i) => i);
  const [lo, hi] = tukeyFences(values);
  return values.map((v, i) => (v >= lo && v <= hi ? i : -1)).filter(i => i >= 0);
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
function blockValues(
  samples: number[],
  offsets: number[],
  fn: (s: number[]) => number,
): number[] {
  return splitByOffsets(samples, offsets).map(fn);
}

/** Tukey-trim blocks and compute per-block statistics.
 *  Trimming uses batch means (sensitive to environmental noise regardless of
 *  target statistic). Per-block values for bootstrap use the caller's statFn
 *  so that p50 comparisons resample batch medians, mean uses batch means, etc. */
function prepareBlocks(
  a: number[],
  b: number[],
  options: DiffBootstrapOptions,
  fn: (s: number[]) => number,
): {
  blockValsA?: number[];
  blockValsB?: number[];
  filteredA?: number[];
  filteredB?: number[];
  trimmed?: [number, number];
} {
  const blocksB = options.blocksB ?? options.blocks;
  const splitsA = options.blocks ? splitByOffsets(a, options.blocks) : undefined;
  const splitsB = blocksB ? splitByOffsets(b, blocksB) : undefined;
  if (!splitsA && !splitsB) return {};
  // Trim based on batch means — mean is most sensitive to environmental noise
  const meansA = splitsA?.map(average);
  const meansB = splitsB?.map(average);
  const keepA = meansA ? tukeyKeep(meansA) : undefined;
  const keepB = meansB ? tukeyKeep(meansB) : undefined;
  // Per-block values for bootstrap use the target statistic
  return {
    blockValsA: keepA && splitsA ? keepA.map(i => fn(splitsA[i])) : undefined,
    blockValsB: keepB && splitsB ? keepB.map(i => fn(splitsB[i])) : undefined,
    filteredA: keepA && splitsA ? keepA.flatMap(i => splitsA[i]) : undefined,
    filteredB: keepB && splitsB ? keepB.flatMap(i => splitsB[i]) : undefined,
    trimmed: [
      (meansA?.length ?? 0) - (keepA?.length ?? 0),
      (meansB?.length ?? 0) - (keepB?.length ?? 0),
    ],
  };
}

/** @return bootstrap CI for percentage difference between baseline (a) and current (b).
 *  With block boundaries, uses Tukey-trimmed per-block means as independent observations. */
export function bootstrapDifferenceCI(
  a: number[],
  b: number[],
  options: DiffBootstrapOptions = {},
): DifferenceCI {
  const { resamples = bootstrapSamples, confidence: conf = defaultConfidence } =
    options;
  const fn = options.statFn ?? ((s: number[]) => percentile(s, 0.5));
  const { blockValsA, blockValsB, filteredA, filteredB, trimmed } =
    prepareBlocks(a, b, options, fn);

  // Point estimate: pooled statistic from Tukey-filtered samples (or all if no blocks)
  const baseVal = fn(filteredA ?? a);
  const currVal = fn(filteredB ?? b);
  const observedPct = ((currVal - baseVal) / baseVal) * 100;

  const drawA = blockValsA
    ? () => average(createResample(blockValsA))
    : () => fn(createResample(a));
  const drawB = blockValsB
    ? () => average(createResample(blockValsB))
    : () => fn(createResample(b));
  const diffs = Array.from({ length: resamples }, () => {
    const valA = drawA();
    const valB = drawB();
    return ((valB - valA) / valA) * 100;
  });

  const ci = computeInterval(diffs, conf);
  const direction = classifyDirection(ci, observedPct, options.equivMargin);
  return {
    percent: observedPct,
    ci,
    direction,
    histogram: binValues(diffs),
    trimmed,
  };
}

/** Classify CI direction, with optional equivalence margin (in percent) */
function classifyDirection(
  ci: [number, number],
  observed: number,
  margin?: number,
): CIDirection {
  const withinMargin =
    margin != null && margin > 0 && ci[0] >= -margin && ci[1] <= margin;
  if (withinMargin) return "equivalent";
  const excludesZero = ci[0] > 0 || ci[1] < 0;
  if (excludesZero) return observed < 0 ? "faster" : "slower";
  return "uncertain";
}

type BinnedCI = {
  estimate: number;
  ci: [number, number];
  histogram: HistogramBin[];
};

/** Convert a BootstrapResult to a binned CI with histogram */
export function binBootstrapResult(result: BootstrapResult): BinnedCI {
  const { estimate, ci, samples } = result;
  return { estimate, ci, histogram: binValues(samples) };
}

/** @return confidence interval [lower, upper] */
function computeInterval(values: number[], conf: number): [number, number] {
  const alpha = (1 - conf) / 2;
  return [percentile(values, alpha), percentile(values, 1 - alpha)];
}

/** Bin values into histogram for compact visualization */
function binValues(values: number[], binCount = 30): HistogramBin[] {
  const sorted = [...values].sort((a, b) => a - b);
  const min = sorted[0];
  const max = sorted[sorted.length - 1];
  if (min === max) return [{ x: min, count: values.length }];

  const step = (max - min) / binCount;
  const counts = new Array(binCount).fill(0);
  for (const v of values) {
    const bin = Math.min(Math.floor((v - min) / step), binCount - 1);
    counts[bin]++;
  }
  return counts.map((count, i) => ({ x: min + (i + 0.5) * step, count }));
}
