import {
  coefficientOfVariation,
  medianAbsoluteDeviation,
  percentile,
} from "../stats/StatisticalUtils.ts";
import type { BenchmarkSpec } from "./BenchmarkSpec.ts";
import type { BenchRunner, RunnerOptions } from "./BenchRunner.ts";
import type { MeasuredResults } from "./MeasuredResults.ts";
import { msToNs } from "./RunnerUtils.ts";

export interface AdaptiveOptions extends RunnerOptions {
  adaptive?: boolean;
  minTime?: number;
  maxTime?: number;
  targetConfidence?: number;
  convergence?: number; // Confidence threshold (0-100)
}

type Metrics = {
  medianDrift: number;
  impactDrift: number;
  medianStable: boolean;
  impactStable: boolean;
};

interface ConvergenceResult {
  converged: boolean;
  confidence: number;
  reason: string;
}

const minTime = 1000;
const maxTime = 10000;
const targetConfidence = 95;
const fallbackThreshold = 80;
const windowSize = 50;
const stability = 0.05; // 5% drift threshold (was 2%, too strict for real benchmarks)
const initialBatch = 100;
const continueBatch = 100;
const continueIterations = 10;

/** @return adaptive sampling runner wrapper */
export function createAdaptiveWrapper(
  baseRunner: BenchRunner,
  options: AdaptiveOptions,
): BenchRunner {
  return {
    async runBench<T = unknown>(
      bench: BenchmarkSpec<T>,
      opts: RunnerOptions,
      params?: T,
    ): Promise<MeasuredResults[]> {
      return runAdaptiveBench(baseRunner, bench, opts, options, params);
    },
  };
}

/** @return convergence based on window stability */
export function checkConvergence(samples: number[]): ConvergenceResult {
  const windowSize = getWindowSize(samples);
  const minSamples = windowSize * 2;

  if (samples.length < minSamples) {
    return {
      converged: false,
      confidence: (samples.length / minSamples) * 100,
      reason: `Collecting samples: ${samples.length}/${minSamples}`,
    };
  }

  const metrics = getStability(samples, windowSize);
  return buildConvergence(metrics);
}

/** @return results using adaptive sampling strategy */
async function runAdaptiveBench<T>(
  runner: BenchRunner,
  bench: BenchmarkSpec<T>,
  opts: RunnerOptions,
  adaptive: AdaptiveOptions,
  params?: T,
): Promise<MeasuredResults[]> {
  const {
    minTime: min = adaptive.minTime ?? minTime,
    maxTime: max = adaptive.maxTime ?? maxTime,
    targetConfidence: target = adaptive.convergence ?? targetConfidence,
  } = opts as AdaptiveOptions;
  const allSamples: number[] = [];

  // Collect initial batch (includes warmup + settle)
  const warmup = await collectInitial(runner, bench, opts, params, allSamples);

  // Start timing AFTER warmup - warmup time doesn't count against maxTime
  const startTime = performance.now();

  const limits = {
    minTime: min,
    maxTime: max,
    targetConfidence: target,
    startTime,
  };
  await collectAdaptive(runner, bench, opts, params, allSamples, limits);

  const samplesNs = allSamples.map(s => s * msToNs);
  const convergence = checkConvergence(samplesNs);
  return buildResults(allSamples, startTime, convergence, bench.name, warmup);
}

/** @return window size scaled to execution time */
function getWindowSize(samples: number[]): number {
  if (samples.length < 20) return windowSize; // Default for initial samples

  const recentMs = samples.slice(-20).map(s => s / msToNs);
  const recentMedian = percentile(recentMs, 0.5);

  // Inverse scaling with execution time
  if (recentMedian < 0.01) return 200; // <10μs
  if (recentMedian < 0.1) return 100; // <100μs
  if (recentMedian < 1) return 50; // <1ms
  if (recentMedian < 10) return 30; // <10ms
  return 20; // >10ms
}

/** @return stability metrics between windows */
function getStability(samples: number[], win: number): Metrics {
  const toMs = (s: number) => s / msToNs;
  const recentMs = samples.slice(-win).map(toMs);
  const prevMs = samples.slice(-win * 2, -win).map(toMs);

  const medRecent = percentile(recentMs, 0.5);
  const medPrev = percentile(prevMs, 0.5);
  const medianDrift = Math.abs(medRecent - medPrev) / medPrev;

  const impRecent = getOutlierImpact(recentMs);
  const impPrev = getOutlierImpact(prevMs);
  const impactDrift = Math.abs(impRecent.ratio - impPrev.ratio);

  return {
    medianDrift,
    impactDrift,
    medianStable: medianDrift < stability,
    impactStable: impactDrift < stability,
  };
}

/** @return convergence from stability metrics */
function buildConvergence(metrics: Metrics): ConvergenceResult {
  const { medianDrift, impactDrift, medianStable, impactStable } = metrics;

  if (medianStable && impactStable) {
    return {
      converged: true,
      confidence: 100,
      reason: "Stable performance pattern",
    };
  }

  const raw =
    (1 - medianDrift / stability) * 50 + (1 - impactDrift / stability) * 50;
  const confidence = Math.min(100, raw);
  const reason =
    medianDrift > impactDrift
      ? `Median drifting: ${(medianDrift * 100).toFixed(1)}%`
      : `Outlier impact changing: ${(impactDrift * 100).toFixed(1)}%`;

  return { converged: false, confidence: Math.max(0, confidence), reason };
}

/** @return warmupSamples from initial batch */
async function collectInitial<T>(
  runner: BenchRunner,
  bench: BenchmarkSpec<T>,
  opts: RunnerOptions,
  params: T | undefined,
  allSamples: number[],
): Promise<number[] | undefined> {
  // Don't pass adaptive flag to base runner to avoid double wrapping
  const batchOpts = {
    ...(opts as any),
    maxTime: initialBatch,
    maxIterations: undefined,
  };
  const results = await runner.runBench(bench, batchOpts, params);
  appendSamples(results[0], allSamples);
  return results[0].warmupSamples;
}

/** @return samples until convergence or timeout */
async function collectAdaptive<T>(
  runner: BenchRunner,
  bench: BenchmarkSpec<T>,
  opts: RunnerOptions,
  params: T | undefined,
  allSamples: number[],
  limits: {
    minTime: number;
    maxTime: number;
    targetConfidence: number;
    startTime: number;
  },
): Promise<void> {
  const { minTime, maxTime, targetConfidence, startTime } = limits;
  let lastLog = 0;
  while (performance.now() - startTime < maxTime) {
    const samplesNs = allSamples.map(s => s * msToNs);
    const convergence = checkConvergence(samplesNs);
    const elapsed = performance.now() - startTime;

    if (elapsed - lastLog > 1000) {
      const elapsedSec = (elapsed / 1000).toFixed(1);
      const conf = convergence.confidence.toFixed(0);
      process.stderr.write(
        `\r◊ ${bench.name}: ${conf}% confident (${elapsedSec}s)   `,
      );
      lastLog = elapsed;
    }

    if (shouldStop(convergence, targetConfidence, elapsed, minTime)) {
      break;
    }

    // Skip warmup for continuation batches (warmup done in initial batch)
    const batch = {
      ...(opts as any),
      maxTime: continueBatch,
      maxIterations: continueIterations,
      skipWarmup: true,
    };
    const results = await runner.runBench(bench, batch, params);
    appendSamples(results[0], allSamples);
  }
  process.stderr.write("\r" + " ".repeat(60) + "\r");
}

/** @return measured results with convergence metrics */
function buildResults(
  samples: number[],
  startTime: number,
  convergence: ConvergenceResult,
  name: string,
  warmupSamples?: number[],
): MeasuredResults[] {
  const totalTime = (performance.now() - startTime) / 1000;
  const time = computeTimeStats(samples.map(s => s * msToNs));
  return [{ name, samples, warmupSamples, time, totalTime, convergence }];
}

/** @return outlier impact as proportion of total time */
function getOutlierImpact(samples: number[]): { ratio: number; count: number } {
  if (samples.length === 0) return { ratio: 0, count: 0 };

  const median = percentile(samples, 0.5);
  const q75 = percentile(samples, 0.75);
  const threshold = median + 1.5 * (q75 - median);

  let excessTime = 0;
  let count = 0;

  for (const sample of samples) {
    if (sample > threshold) {
      excessTime += sample - median;
      count++;
    }
  }

  const total = samples.reduce((a, b) => a + b, 0);
  return { ratio: total > 0 ? excessTime / total : 0, count };
}

/** Append samples one-by-one to avoid stack overflow from spread on large arrays */
function appendSamples(result: MeasuredResults, samples: number[]): void {
  if (!result.samples?.length) return;
  for (const sample of result.samples) samples.push(sample);
}

/** @return true if convergence reached or timeout */
function shouldStop(
  c: ConvergenceResult,
  target: number,
  elapsed: number,
  min: number,
): boolean {
  if (c.converged && c.confidence >= target) return true;
  // After minTime, accept whichever is higher: targetConfidence or fallbackThreshold
  const threshold = Math.max(target, fallbackThreshold);
  return elapsed >= min && c.confidence >= threshold;
}

/** @return time percentiles and statistics in ms */
function computeTimeStats(samplesNs: number[]) {
  const samplesMs = samplesNs.map(s => s / msToNs);
  const min = samplesNs.reduce(
    (a, b) => Math.min(a, b),
    Number.POSITIVE_INFINITY,
  );
  const max = samplesNs.reduce(
    (a, b) => Math.max(a, b),
    Number.NEGATIVE_INFINITY,
  );
  const sum = samplesNs.reduce((a, b) => a + b, 0);

  return {
    min: min / msToNs,
    max: max / msToNs,
    avg: sum / samplesNs.length / msToNs,
    p25: percentile(samplesNs, 0.25) / msToNs,
    p50: percentile(samplesNs, 0.5) / msToNs,
    p75: percentile(samplesNs, 0.75) / msToNs,
    p95: percentile(samplesNs, 0.95) / msToNs,
    p99: percentile(samplesNs, 0.99) / msToNs,
    p999: percentile(samplesNs, 0.999) / msToNs,
    cv: coefficientOfVariation(samplesMs),
    mad: medianAbsoluteDeviation(samplesMs),
    outlierRate: getOutlierImpact(samplesMs).ratio,
  };
}
