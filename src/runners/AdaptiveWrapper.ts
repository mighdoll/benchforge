import { percentile } from "../stats/StatisticalUtils.ts";
import { computeStats, outlierImpactRatio } from "./BasicRunner.ts";
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

/** Wrap a runner with adaptive sampling that collects until convergence or timeout. */
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

/** Check convergence by comparing stability between sliding windows of samples. */
export function checkConvergence(samples: number[]): ConvergenceResult {
  const windowSize = getWindowSize(samples);
  const minSamples = windowSize * 2;

  if (samples.length < minSamples) {
    const confidence = (samples.length / minSamples) * 100;
    const reason = `Collecting samples: ${samples.length}/${minSamples}`;
    return { converged: false, confidence, reason };
  }

  const metrics = getStability(samples, windowSize);
  return buildConvergence(metrics);
}

/** Run benchmark with adaptive sampling: collect batches until convergence or timeout. */
async function runAdaptiveBench<T>(
  runner: BenchRunner,
  bench: BenchmarkSpec<T>,
  opts: RunnerOptions,
  adaptive: AdaptiveOptions,
  params?: T,
): Promise<MeasuredResults[]> {
  const a = opts as AdaptiveOptions;
  const min = a.minTime ?? adaptive.minTime ?? minTime;
  const max = a.maxTime ?? adaptive.maxTime ?? maxTime;
  const target = a.convergence ?? adaptive.convergence ?? targetConfidence;
  const allSamples: number[] = [];

  const warmup = await collectInitial(runner, bench, opts, params, allSamples);

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
  return buildResults(allSamples, startTime, convergence, bench.name, warmup);
}

/** Scale window size inversely with execution time (fast ops need more samples). */
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

/** Compare median and outlier impact between recent and previous windows. */
function getStability(samples: number[], win: number): Metrics {
  const toMs = (s: number) => s / msToNs;
  const recentMs = samples.slice(-win).map(toMs);
  const prevMs = samples.slice(-win * 2, -win).map(toMs);

  const medRecent = percentile(recentMs, 0.5);
  const medPrev = percentile(prevMs, 0.5);
  const medianDrift = Math.abs(medRecent - medPrev) / medPrev;

  const impRecent = outlierImpactRatio(recentMs);
  const impPrev = outlierImpactRatio(prevMs);
  const impactDrift = Math.abs(impRecent - impPrev);

  return {
    medianDrift,
    impactDrift,
    medianStable: medianDrift < stability,
    impactStable: impactDrift < stability,
  };
}

/** Convert stability metrics to a convergence result with confidence score. */
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

/** Collect the initial batch (includes warmup + settle) and return warmup samples. */
async function collectInitial<T>(
  runner: BenchRunner,
  bench: BenchmarkSpec<T>,
  opts: RunnerOptions,
  params: T | undefined,
  allSamples: number[],
): Promise<number[] | undefined> {
  const batchOpts = {
    ...(opts as any),
    maxTime: initialBatch,
    maxIterations: undefined,
  };
  const results = await runner.runBench(bench, batchOpts, params);
  appendSamples(results[0], allSamples);
  return results[0].warmupSamples;
}

/** Collect continuation batches until convergence or timeout. */
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
      const sec = (elapsed / 1000).toFixed(1);
      const conf = convergence.confidence.toFixed(0);
      const msg = `\r◊ ${bench.name}: ${conf}% confident (${sec}s)   `;
      process.stderr.write(msg);
      lastLog = elapsed;
    }

    if (shouldStop(convergence, targetConfidence, elapsed, minTime)) {
      break;
    }

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

/** Build final MeasuredResults with time stats and convergence info. */
function buildResults(
  samples: number[],
  startTime: number,
  convergence: ConvergenceResult,
  name: string,
  warmupSamples?: number[],
): MeasuredResults[] {
  const totalTime = (performance.now() - startTime) / 1000;
  const time = computeStats(samples);
  return [{ name, samples, warmupSamples, time, totalTime, convergence }];
}

/** Append samples one-by-one to avoid stack overflow from spread on large arrays */
function appendSamples(result: MeasuredResults, samples: number[]): void {
  if (!result.samples?.length) return;
  for (const sample of result.samples) samples.push(sample);
}

/** True if convergence target met, or minTime elapsed with fallback confidence. */
function shouldStop(
  c: ConvergenceResult,
  target: number,
  elapsed: number,
  min: number,
): boolean {
  if (c.converged && c.confidence >= target) return true;
  const threshold = Math.max(target, fallbackThreshold);
  return elapsed >= min && c.confidence >= threshold;
}
