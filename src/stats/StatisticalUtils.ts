/** Bootstrap estimate with confidence interval and raw resample distribution */
export interface BootstrapResult {
  /** Point estimate from the original sample */
  estimate: number;
  /** Confidence interval [lower, upper] from bootstrap resampling */
  ci: [number, number];
  /** Bootstrap resample distribution (for visualization) */
  samples: number[];
}

export type CIDirection = "faster" | "slower" | "uncertain";

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
};
const defaultConfidence = 0.95;
const outlierMultiplier = 1.5; // Tukey's fence multiplier
const bootstrapSamples = 10000;

/** Swap direction labels for higher-is-better metrics (positive = faster) */
export function swapDirection(ci: DifferenceCI): DifferenceCI {
  const d = ci.direction === "faster" ? "slower"
    : ci.direction === "slower" ? "faster" : "uncertain";
  return { ...ci, direction: d };
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
  const q1 = percentile(samples, 0.25);
  const q3 = percentile(samples, 0.75);
  const iqr = q3 - q1;
  const lowerBound = q1 - outlierMultiplier * iqr;
  const upperBound = q3 + outlierMultiplier * iqr;

  const indices = samples
    .map((v, i) => (v < lowerBound || v > upperBound ? i : -1))
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
  const resample = makeResampler(samples, options.blocks);
  const stats = Array.from({ length: resamples }, () => statFn(resample()));
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

/** @return resampler using block bootstrap when offsets are provided, else standard */
function makeResampler(
  samples: number[],
  offsets?: number[],
): () => number[] {
  if (offsets) return () => createBlockResample(samples, offsets);
  return () => createResample(samples);
}

/** @return block bootstrap resample: pick blocks with replacement, concatenate */
function createBlockResample(
  samples: number[],
  offsets: number[],
): number[] {
  const n = offsets.length;
  const result: number[] = [];
  for (let i = 0; i < n; i++) {
    const pick = Math.floor(Math.random() * n);
    const start = offsets[pick];
    const end = pick + 1 < n ? offsets[pick + 1] : samples.length;
    for (let j = start; j < end; j++) result.push(samples[j]);
  }
  return result;
}

/**
 * @return bootstrap CI for percentage difference between baseline and current.
 * Resamples both distributions independently and computes the stat difference
 * distribution to derive a confidence interval. Uses median by default,
 * or a custom stat function via the statFn option.
 */
export function bootstrapDifferenceCI(
  a: number[],
  b: number[],
  options: DiffBootstrapOptions = {},
): DifferenceCI {
  const { resamples = bootstrapSamples, confidence: conf = defaultConfidence } =
    options;
  const fn = options.statFn ?? ((s: number[]) => percentile(s, 0.5));

  const baseVal = fn(a);
  const currVal = fn(b);
  const observedPct = ((currVal - baseVal) / baseVal) * 100;

  const resampleA = makeResampler(a, options.blocks);
  const resampleB = makeResampler(b, options.blocksB ?? options.blocks);

  const diffs: number[] = [];
  for (let i = 0; i < resamples; i++) {
    const valA = fn(resampleA());
    const valB = fn(resampleB());
    diffs.push(((valB - valA) / valA) * 100);
  }

  const ci = computeInterval(diffs, conf);
  const ciExcludesZero = ci[0] > 0 || ci[1] < 0;
  let direction: CIDirection = "uncertain";
  if (ciExcludesZero && observedPct < 0) direction = "faster";
  else if (ciExcludesZero) direction = "slower";
  return { percent: observedPct, ci, direction, histogram: binValues(diffs) };
}

/** Convert a BootstrapResult to BootstrapCIData with binned histogram */
export function binBootstrapResult(result: BootstrapResult): {
  estimate: number;
  ci: [number, number];
  histogram: HistogramBin[];
} {
  return {
    estimate: result.estimate,
    ci: result.ci,
    histogram: binValues(result.samples),
  };
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
