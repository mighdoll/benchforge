import type { BenchmarkSpec } from "../Benchmark.ts";
import type { MeasuredResults } from "../MeasuredResults.ts";
import {
  coefficientOfVariation,
  medianAbsoluteDeviation,
  percentile,
} from "../StatisticalUtils.ts";
import type { BenchRunner, RunnerOptions } from "./BenchRunner.ts";
import { msToNs } from "./RunnerUtils.ts";

const minTime = 1000;
const maxTime = 10000;
const targetConfidence = 95;
const fallbackThreshold = 80;
const windowSize = 50;
const stability = 0.05; // 5% drift threshold (was 2%, too strict for real benchmarks)
const initialBatch = 100;
const continueBatch = 100;
const continueIterations = 10;

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

export interface AdaptiveOptions extends RunnerOptions {
  adaptive?: boolean;
  minTime?: number;
  maxTime?: number;
  targetConfidence?: number;
  convergence?: number; // Confidence threshold (0-100)
}

/** @return adaptive sampling runner wrapper */
export function createAdaptiveWrapper(
  baseRunner: BenchRunner,
  options: AdaptiveOptions,
): BenchRunner {
  return {
    async runBench<T = unknown>(
      benchmark: BenchmarkSpec<T>,
      runnerOptions: RunnerOptions,
      params?: T,
    ): Promise<MeasuredResults[]> {
      return runAdaptiveBench(
        baseRunner,
        benchmark,
        runnerOptions,
        options,
        params,
      );
    },
  };
}

/** @return results using adaptive sampling strategy */
async function runAdaptiveBench<T>(
  baseRunner: BenchRunner,
  benchmark: BenchmarkSpec<T>,
  runnerOptions: RunnerOptions,
  options: AdaptiveOptions,
  params?: T,
): Promise<MeasuredResults[]> {
  const {
    minTime: min = options.minTime ?? minTime,
    maxTime: max = options.maxTime ?? maxTime,
    targetConfidence: target = options.convergence ?? targetConfidence,
  } = runnerOptions as AdaptiveOptions;
  const allSamples: number[] = [];

  // Collect initial batch (includes warmup + settle)
  const warmup = await collectInitial(
    baseRunner,
    benchmark,
    runnerOptions,
    params,
    allSamples,
  );

  // Start timing AFTER warmup - warmup time doesn't count against maxTime
  const startTime = performance.now();

  const limits = {
    minTime: min,
    maxTime: max,
    targetConfidence: target,
    startTime,
  };
  await collectAdaptive(
    baseRunner,
    benchmark,
    runnerOptions,
    params,
    allSamples,
    limits,
  );

  const convergence = checkConvergence(allSamples.map(s => s * msToNs));
  return buildResults(
    allSamples,
    startTime,
    convergence,
    benchmark.name,
    warmup,
  );
}

/** @return warmupSamples from initial batch */
async function collectInitial<T>(
  baseRunner: BenchRunner,
  benchmark: BenchmarkSpec<T>,
  runnerOptions: RunnerOptions,
  params: T | undefined,
  allSamples: number[],
): Promise<number[] | undefined> {
  // Don't pass adaptive flag to base runner to avoid double wrapping
  const opts = {
    ...(runnerOptions as any),
    maxTime: initialBatch,
    maxIterations: undefined,
  };
  const results = await baseRunner.runBench(benchmark, opts, params);
  appendSamples(results[0], allSamples);
  return results[0].warmupSamples;
}

/** @return samples until convergence or timeout */
async function collectAdaptive<T>(
  baseRunner: BenchRunner,
  benchmark: BenchmarkSpec<T>,
  runnerOptions: RunnerOptions,
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
        `\r◊ ${benchmark.name}: ${conf}% confident (${elapsedSec}s)   `,
      );
      lastLog = elapsed;
    }

    if (shouldStop(convergence, targetConfidence, elapsed, minTime)) {
      break;
    }

    // Skip warmup for continuation batches (warmup done in initial batch)
    const opts = {
      ...(runnerOptions as any),
      maxTime: continueBatch,
      maxIterations: continueIterations,
      skipWarmup: true,
    };
    const batchResults = await baseRunner.runBench(benchmark, opts, params);
    appendSamples(batchResults[0], allSamples);
  }
  process.stderr.write("\r" + " ".repeat(60) + "\r");
}

/** Append samples one-by-one to avoid stack overflow from spread on large arrays */
function appendSamples(result: MeasuredResults, samples: number[]): void {
  if (!result.samples?.length) return;
  for (const sample of result.samples) samples.push(sample);
}

/** @return true if convergence reached or timeout */
function shouldStop(
  convergence: ConvergenceResult,
  targetConfidence: number,
  elapsedTime: number,
  minTime: number,
): boolean {
  if (convergence.converged && convergence.confidence >= targetConfidence) {
    return true;
  }
  // After minTime, accept whichever is higher: targetConfidence or fallbackThreshold
  const threshold = Math.max(targetConfidence, fallbackThreshold);
  return elapsedTime >= minTime && convergence.confidence >= threshold;
}

/** @return measured results with convergence metrics */
function buildResults(
  samplesMs: number[],
  startTime: number,
  convergence: ConvergenceResult,
  name: string,
  warmupSamples?: number[],
): MeasuredResults[] {
  const totalTime = (performance.now() - startTime) / 1000;
  const samplesNs = samplesMs.map(s => s * msToNs);
  const timeStats = computeTimeStats(samplesNs);

  return [
    {
      name,
      samples: samplesMs,
      warmupSamples,
      time: timeStats,
      totalTime,
      convergence,
    },
  ];
}

/** @return time percentiles and statistics in ms */
function computeTimeStats(samplesNs: number[]) {
  const samplesMs = samplesNs.map(s => s / msToNs);
  const { min, max, sum } = getMinMaxSum(samplesNs);
  const percentiles = getPercentiles(samplesNs);
  const robust = getRobustMetrics(samplesMs);

  return {
    min: min / msToNs,
    max: max / msToNs,
    avg: sum / samplesNs.length / msToNs,
    ...percentiles,
    ...robust,
  };
}

/** @return min, max, sum of samples */
function getMinMaxSum(samples: number[]) {
  const min = samples.reduce(
    (a, b) => Math.min(a, b),
    Number.POSITIVE_INFINITY,
  );
  const max = samples.reduce(
    (a, b) => Math.max(a, b),
    Number.NEGATIVE_INFINITY,
  );
  const sum = samples.reduce((a, b) => a + b, 0);
  return { min, max, sum };
}

/** @return percentiles in ms */
function getPercentiles(samples: number[]) {
  return {
    p25: percentile(samples, 0.25) / msToNs,
    p50: percentile(samples, 0.5) / msToNs,
    p75: percentile(samples, 0.75) / msToNs,
    p95: percentile(samples, 0.95) / msToNs,
    p99: percentile(samples, 0.99) / msToNs,
    p999: percentile(samples, 0.999) / msToNs,
  };
}

/** @return robust variability metrics */
function getRobustMetrics(samplesMs: number[]) {
  const impact = getOutlierImpact(samplesMs);
  return {
    cv: coefficientOfVariation(samplesMs),
    mad: medianAbsoluteDeviation(samplesMs),
    outlierRate: impact.ratio,
  };
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

  const totalTime = samples.reduce((a, b) => a + b, 0);
  return {
    ratio: totalTime > 0 ? excessTime / totalTime : 0,
    count,
  };
}

/** @return convergence based on window stability */
export function checkConvergence(samples: number[]): ConvergenceResult {
  const windowSize = getWindowSize(samples);
  const minSamples = windowSize * 2;

  if (samples.length < minSamples) {
    return buildProgressResult(samples.length, minSamples);
  }

  const metrics = getStability(samples, windowSize);
  return buildConvergence(metrics);
}

/** @return progress when samples insufficient */
function buildProgressResult(
  currentSamples: number,
  minSamples: number,
): ConvergenceResult {
  return {
    converged: false,
    confidence: (currentSamples / minSamples) * 100,
    reason: `Collecting samples: ${currentSamples}/${minSamples}`,
  };
}

/** @return stability metrics between windows */
function getStability(samples: number[], windowSize: number): Metrics {
  const recent = samples.slice(-windowSize);
  const previous = samples.slice(-windowSize * 2, -windowSize);

  const recentMs = recent.map(s => s / msToNs);
  const previousMs = previous.map(s => s / msToNs);

  const medianRecent = percentile(recentMs, 0.5);
  const medianPrevious = percentile(previousMs, 0.5);
  const medianDrift = Math.abs(medianRecent - medianPrevious) / medianPrevious;

  const impactRecent = getOutlierImpact(recentMs);
  const impactPrevious = getOutlierImpact(previousMs);
  const impactDrift = Math.abs(impactRecent.ratio - impactPrevious.ratio);

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

  const confidence = Math.min(
    100,
    (1 - medianDrift / stability) * 50 + (1 - impactDrift / stability) * 50,
  );

  const reason =
    medianDrift > impactDrift
      ? `Median drifting: ${(medianDrift * 100).toFixed(1)}%`
      : `Outlier impact changing: ${(impactDrift * 100).toFixed(1)}%`;

  return { converged: false, confidence: Math.max(0, confidence), reason };
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
