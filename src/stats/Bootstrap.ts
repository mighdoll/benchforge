import {
  maxOf,
  mean,
  minOf,
  percentile,
  percentileIndex,
  quickSelect,
  type StatKind,
} from "./CoreStats.ts";

/** Whether CI was computed from block-level or sample-level resampling */
export type CILevel = "block" | "sample";

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
export type BootstrapOptions = {
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
 *  then percentiles ascending (quickSelect mutates buf). */
function buildStatOps(stats: StatKind[], n: number): StatOp[] {
  const nonDestructive = (
    order: number,
    i: number,
    fn: (s: number[]) => number,
  ) => ({
    order,
    compute: fn,
    pointEstimate: fn,
    origIndex: i,
  });
  const ops = stats.map((s, i): StatOp & { order: number } => {
    if (s === "mean") return nonDestructive(-3, i, mean);
    if (s === "min") return nonDestructive(-2, i, minOf);
    if (s === "max") return nonDestructive(-1, i, maxOf);
    const p = s.percentile;
    const k = percentileIndex(n, p);
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
