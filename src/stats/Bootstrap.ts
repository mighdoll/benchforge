import {
  nonPercentileStat,
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

/** Random source for resampling draws, returning values in [0, 1). */
export type Rand = () => number;

/** Options for bootstrap resampling */
export type BootstrapOptions = {
  /** Number of bootstrap resamples (default: 10000) */
  resamples?: number;
  /** Confidence level 0-1 (default: 0.95) */
  confidence?: number;
  /** Random source for resampling draws (default: a fixed-seed stream, so
   *  identical data yields identical CIs). Pass seededRng(n) for a specific
   *  seed, or Math.random for varied draws. */
  random?: Rand;
};

interface StatOp {
  origIndex: number;
  compute: (buf: number[]) => number;
  pointEstimate: (s: number[]) => number;
}

export const defaultConfidence = 0.95;
export const bootstrapSamples = 10000;
export const maxBootstrapInput = 10_000;

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
  const rand = options.random ?? defaultRand();
  const sub = subsample(samples, maxBootstrapInput, rand);
  const n = sub.length;
  const buf = new Array(n);
  const ops = buildStatOps(stats, n);
  const allStats = ops.map(() => new Array<number>(resamples));

  for (let i = 0; i < resamples; i++) {
    resampleInto(sub, buf, rand);
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
export function resampleInto(
  source: number[],
  buf: number[],
  rand: Rand,
): void {
  const n = source.length;
  for (let i = 0; i < n; i++) {
    buf[i] = source[Math.floor(rand() * n)];
  }
}

/** @return bootstrap resample with replacement */
export function createResample(samples: number[], rand: Rand): number[] {
  const n = samples.length;
  return Array.from({ length: n }, () => samples[Math.floor(rand() * n)]);
}

/** Random subsample without replacement via partial Fisher-Yates. Returns original if n <= max. */
export function subsample(
  samples: number[],
  max: number,
  rand: Rand,
): number[] {
  if (samples.length <= max) return samples;
  const copy = samples.slice();
  for (let i = 0; i < max; i++) {
    const j = i + Math.floor(rand() * (copy.length - i));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, max);
}

/** Fresh default random stream for resampling. A fixed seed makes every CI a
 *  pure function of its input data, so re-rendering a report or archive
 *  reproduces the same numbers. Each caller gets its own stream, so results
 *  don't depend on call order. */
export function defaultRand(): Rand {
  return seededRng(defaultSeed);
}

const defaultSeed = 0x5eed;

/** Deterministic mulberry32 PRNG stream, for reproducible resampling. */
export function seededRng(seed: number): Rand {
  let s = seed;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
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
  const ops = stats.map((s, i): StatOp & { order: number } => {
    if (typeof s === "object") {
      const p = s.percentile;
      const k = percentileIndex(n, p);
      return {
        order: p,
        origIndex: i,
        compute: (buf: number[]) => quickSelect(buf, k),
        pointEstimate: (v: number[]) => percentile(v, p),
      };
    }
    const np = nonPercentileStat(s)!;
    return {
      order: np.order,
      compute: np.fn,
      pointEstimate: np.fn,
      origIndex: i,
    };
  });
  ops.sort((a, b) => a.order - b.order);
  return ops;
}
