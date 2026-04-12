import { median } from "../stats/StatisticalUtils.ts";
import type { BenchmarkSpec } from "./BenchmarkSpec.ts";
import type { BenchRunner, RunnerOptions } from "./BenchRunner.ts";
import type { MeasuredResults } from "./MeasuredResults.ts";
import { msToNs } from "./RunnerUtils.ts";
import { computeStats, outlierImpactRatio } from "./SampleStats.ts";

/** Options for adaptive sampling: collects until statistical convergence or timeout. */
export interface AdaptiveOptions extends RunnerOptions {
  /** Enable adaptive sampling (default: true when using adaptive runner) */
  adaptive?: boolean;
  /** Minimum measurement time in ms before convergence can stop sampling (default: 1000) */
  minTime?: number;
  /** Maximum measurement time in ms, hard stop (default: 10000) */
  maxTime?: number;
  /** Target confidence percentage to stop early (default: 95) */
  targetConfidence?: number;
  /** Confidence threshold 0-100 (alias for targetConfidence) */
  convergence?: number;
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

/** Wrap a runner with adaptive sampling (convergence detection or timeout). */
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

/** Check convergence by comparing sliding windows of samples for stability. */
export function checkConvergence(samples: number[]): ConvergenceResult {
  const windowSize = getWindowSize(samples);
  const minSamples = windowSize * 2;
  if (samples.length < minSamples) {
    const confidence = (samples.length / minSamples) * 100;
    const reason = `Collecting samples: ${samples.length}/${minSamples}`;
    return { converged: false, confidence, reason };
  }
  return buildConvergence(getStability(samples, windowSize));
}

/** Run benchmark with adaptive sampling until convergence or timeout. */
async function runAdaptiveBench<T>(
  runner: BenchRunner,
  bench: BenchmarkSpec<T>,
  opts: RunnerOptions,
  adaptive: AdaptiveOptions,
  params?: T,
): Promise<MeasuredResults[]> {
  const overrides = opts as AdaptiveOptions;
  const min = overrides.minTime ?? adaptive.minTime ?? minTime;
  const max = overrides.maxTime ?? adaptive.maxTime ?? maxTime;
  const target =
    overrides.convergence ?? adaptive.convergence ?? targetConfidence;
  const allSamples: number[] = [];

  const { warmup, startTime: hrtimeStart } = await collectInitial(
    runner,
    bench,
    opts,
    params,
    allSamples,
  );
  // Start timing after warmup so warmup time doesn't count against maxTime
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
  return buildResults(
    allSamples,
    startTime,
    convergence,
    bench.name,
    warmup,
    hrtimeStart,
  );
}

/** Scale window size inversely with execution time -- fast ops need more samples. */
function getWindowSize(samples: number[]): number {
  if (samples.length < 20) return windowSize;

  const recentMs = samples.slice(-20).map(s => s / msToNs);
  const recentMedian = median(recentMs);

  if (recentMedian < 0.01) return 200; // <10μs
  if (recentMedian < 0.1) return 100; // <100μs
  if (recentMedian < 1) return 50; // <1ms
  if (recentMedian < 10) return 30; // <10ms
  return 20; // >10ms
}

/** Convert stability metrics to a convergence result with confidence score. */
function buildConvergence(metrics: Metrics): ConvergenceResult {
  const { medianDrift, impactDrift, medianStable, impactStable } = metrics;
  if (medianStable && impactStable)
    return {
      converged: true,
      confidence: 100,
      reason: "Stable performance pattern",
    };
  const raw =
    (1 - medianDrift / stability) * 50 + (1 - impactDrift / stability) * 50;
  const confidence = Math.max(0, Math.min(100, raw));
  const reason =
    medianDrift > impactDrift
      ? `Median drifting: ${(medianDrift * 100).toFixed(1)}%`
      : `Outlier impact changing: ${(impactDrift * 100).toFixed(1)}%`;
  return { converged: false, confidence, reason };
}

/** Compare median and outlier-impact drift between recent and previous windows. */
function getStability(samples: number[], windowSize: number): Metrics {
  const toMs = (s: number) => s / msToNs;
  const recentMs = samples.slice(-windowSize).map(toMs);
  const previousMs = samples.slice(-windowSize * 2, -windowSize).map(toMs);

  const medianRecent = median(recentMs);
  const medianPrevious = median(previousMs);
  const medianDrift = Math.abs(medianRecent - medianPrevious) / medianPrevious;

  const impactRecent = outlierImpactRatio(recentMs);
  const impactPrevious = outlierImpactRatio(previousMs);
  const impactDrift = Math.abs(impactRecent - impactPrevious);

  const medianStable = medianDrift < stability;
  const impactStable = impactDrift < stability;
  return { medianDrift, impactDrift, medianStable, impactStable };
}

/** Collect the initial batch (warmup + settle), returning warmup samples. */
async function collectInitial<T>(
  runner: BenchRunner,
  bench: BenchmarkSpec<T>,
  opts: RunnerOptions,
  params: T | undefined,
  allSamples: number[],
): Promise<{ warmup?: number[]; startTime?: number }> {
  const batchOpts = {
    ...(opts as any),
    maxTime: initialBatch,
    maxIterations: undefined,
  };
  const results = await runner.runBench(bench, batchOpts, params);
  appendSamples(results[0], allSamples);
  return { warmup: results[0].warmupSamples, startTime: results[0].startTime };
}

/** Collect batches until convergence or timeout, with progress logging. */
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

    lastLog = logProgress(bench.name, convergence, elapsed, lastLog);
    if (shouldStop(convergence, targetConfidence, elapsed, minTime)) break;

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

/** Build final MeasuredResults from collected samples and convergence state. */
function buildResults(
  samples: number[],
  elapsedStart: number,
  convergence: ConvergenceResult,
  name: string,
  warmupSamples?: number[],
  startTime?: number,
): MeasuredResults[] {
  const totalTime = (performance.now() - elapsedStart) / 1000;
  const time = computeStats(samples);
  return [
    { name, samples, warmupSamples, time, totalTime, startTime, convergence },
  ];
}

/** Append samples one-by-one to avoid stack overflow from spread on large arrays. */
function appendSamples(result: MeasuredResults, samples: number[]): void {
  if (!result.samples?.length) return;
  for (const sample of result.samples) samples.push(sample);
}

/** Log adaptive sampling progress at ~1s intervals. */
function logProgress(
  name: string,
  convergence: ConvergenceResult,
  elapsed: number,
  lastLog: number,
): number {
  if (elapsed - lastLog <= 1000) return lastLog;
  const sec = (elapsed / 1000).toFixed(1);
  const conf = convergence.confidence.toFixed(0);
  process.stderr.write(`\r◊ ${name}: ${conf}% confident (${sec}s)   `);
  return elapsed;
}

/** @return true if convergence target met, or minTime elapsed with fallback confidence. */
function shouldStop(
  convergence: ConvergenceResult,
  target: number,
  elapsed: number,
  minElapsed: number,
): boolean {
  if (convergence.converged && convergence.confidence >= target) return true;
  return (
    elapsed >= minElapsed &&
    convergence.confidence >= Math.max(target, fallbackThreshold)
  );
}
