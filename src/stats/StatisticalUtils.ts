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
};
const defaultConfidence = 0.95;
const outlierMultiplier = 1.5; // Tukey's fence multiplier
const bootstrapSamples = 10000;

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
  const { resamples = bootstrapSamples, confidence: conf = defaultConfidence } =
    options;
  const medians = Array.from({ length: resamples }, () =>
    percentile(createResample(samples), 0.5),
  );
  const ci = computeInterval(medians, conf);

  return {
    estimate: percentile(samples, 0.5),
    ci,
    samples: medians,
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

/**
 * @return bootstrap CI for percentage difference between baseline and current medians.
 * Resamples both distributions independently and computes the median difference
 * distribution to derive a confidence interval.
 */
export function bootstrapDifferenceCI(
  baseline: number[],
  current: number[],
  options: BootstrapOptions = {},
): DifferenceCI {
  const { resamples = bootstrapSamples, confidence: conf = defaultConfidence } =
    options;

  const baseMed = percentile(baseline, 0.5);
  const currMed = percentile(current, 0.5);
  const observedPct = ((currMed - baseMed) / baseMed) * 100;

  const diffs: number[] = [];
  for (let i = 0; i < resamples; i++) {
    const resB = createResample(baseline);
    const resC = createResample(current);
    const medB = percentile(resB, 0.5);
    const medC = percentile(resC, 0.5);
    diffs.push(((medC - medB) / medB) * 100);
  }

  const ci = computeInterval(diffs, conf);
  const ciExcludesZero = ci[0] > 0 || ci[1] < 0;
  let direction: CIDirection = "uncertain";
  if (ciExcludesZero && observedPct < 0) direction = "faster";
  else if (ciExcludesZero) direction = "slower";
  const histogram = binValues(diffs);
  return { percent: observedPct, ci, direction, histogram };
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
