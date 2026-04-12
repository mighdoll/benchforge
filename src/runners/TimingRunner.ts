import { getHeapStatistics } from "node:v8";
import type { BenchmarkSpec } from "./BenchmarkSpec.ts";
import type { BenchRunner, RunnerOptions } from "./BenchRunner.ts";
import { executeBenchmark } from "./BenchRunner.ts";
import type {
  MeasuredResults,
  OptStatusInfo,
  PausePoint,
} from "./MeasuredResults.ts";
import {
  analyzeOptStatus,
  computeStats,
  createOptStatusGetter,
  gcFunction,
} from "./SampleStats.ts";

type CollectParams<T = unknown> = {
  benchmark: BenchmarkSpec<T>;
  maxTime: number;
  maxIterations: number;
  warmup: number;
  params?: T;
  skipWarmup?: boolean;
  traceOpt?: boolean;
  pauseWarmup?: number;
  pauseFirst?: number;
  pauseInterval?: number;
  pauseDuration?: number;
};

type CollectResult = {
  samples: number[];
  warmupSamples: number[];
  heapGrowth: number;
  heapSamples: number[];
  startTime: number;
  optStatus?: OptStatusInfo;
  optSamples?: number[];
  pausePoints: PausePoint[];
};

type SampleArrays = {
  samples: number[];
  heapSamples: number[];
  optStatuses: number[];
  pausePoints: PausePoint[];
};

const defaultCollectOptions = {
  maxTime: 5000,
  maxIterations: 1000000,
  warmup: 0,
  traceOpt: false,
  pauseWarmup: 0,
};

/**
 * Timing-based runner that collects samples within time/iteration limits.
 * Handles warmup, heap tracking, V8 optimization tracing, and periodic pauses.
 */
export class TimingRunner implements BenchRunner {
  async runBench<T = unknown>(
    benchmark: BenchmarkSpec<T>,
    options: RunnerOptions,
    params?: T,
  ): Promise<MeasuredResults[]> {
    const opts = { ...defaultCollectOptions, ...(options as any) };
    const collected = await collectSamples({ benchmark, params, ...opts });
    return [buildMeasuredResults(benchmark.name, collected)];
  }
}

/** Collect timing samples with warmup, heap tracking, and optional V8 opt tracing. */
async function collectSamples<T>(
  config: CollectParams<T>,
): Promise<CollectResult> {
  if (!config.maxIterations && !config.maxTime) {
    throw new Error(`At least one of maxIterations or maxTime must be set`);
  }
  const warmupSamples = config.skipWarmup ? [] : await runWarmup(config);
  const heapBefore = process.memoryUsage().heapUsed;
  const { samples, heapSamples, optStatuses, pausePoints, startTime } =
    await runSampleLoop(config);
  if (samples.length === 0)
    throw new Error(
      `No samples collected for benchmark: ${config.benchmark.name}`,
    );
  const heapAfter = process.memoryUsage().heapUsed;
  const heapGrowth =
    Math.max(0, heapAfter - heapBefore) / 1024 / samples.length;
  const optStatus = config.traceOpt
    ? analyzeOptStatus(samples, optStatuses)
    : undefined;
  const optSamples =
    config.traceOpt && optStatuses.length > 0 ? optStatuses : undefined;
  return {
    samples,
    warmupSamples,
    heapGrowth,
    heapSamples,
    startTime,
    optStatus,
    optSamples,
    pausePoints,
  };
}

/** Assemble CollectResult into a MeasuredResults record. */
function buildMeasuredResults(
  name: string,
  collected: CollectResult,
): MeasuredResults {
  const { samples, warmupSamples, heapSamples } = collected;
  const { optStatus, optSamples, pausePoints, heapGrowth, startTime } =
    collected;
  const time = computeStats(samples);
  const heapSize = { avg: heapGrowth, min: heapGrowth, max: heapGrowth };
  return {
    name,
    samples,
    warmupSamples,
    heapSamples,
    time,
    heapSize,
    startTime,
    optStatus,
    optSamples,
    pausePoints,
  };
}

/**
 * Run warmup iterations with gc + settle time for V8 optimization. Returns warmup timings.
 *
 * V8 has 4 compilation tiers: Ignition (interpreter) ==> Sparkplug (baseline) ==>
 * Maglev (mid-tier optimizer) ==> TurboFan (full optimizer). Tiering thresholds:
 *   - Ignition ==> Sparkplug: 8 invocations
 *   - Sparkplug ==> Maglev: 500 invocations
 *   - Maglev ==> TurboFan: 6000 invocations
 *
 * Optimization compilation happens on background threads and requires idle time
 * on the main thread to complete. Without sufficient warmup + settle time,
 * benchmarks exhibit bimodal timing: slow Sparkplug samples (~30% slower) mixed
 * with fast optimized samples.
 *
 * The warmup iterations trigger the optimization decision, then settle time
 * provides idle time for background compilation to finish before measurement.
 *
 * @see https://v8.dev/blog/sparkplug
 * @see https://v8.dev/blog/maglev
 * @see https://v8.dev/blog/background-compilation
 */
async function runWarmup<T>(config: CollectParams<T>): Promise<number[]> {
  const gc = gcFunction();
  const samples = new Array<number>(config.warmup);
  for (let i = 0; i < config.warmup; i++) {
    const start = performance.now();
    executeBenchmark(config.benchmark, config.params);
    samples[i] = performance.now() - start;
  }
  gc();
  if (config.pauseWarmup) {
    await new Promise(r => setTimeout(r, config.pauseWarmup));
    gc();
  }
  return samples;
}

/** Collect timing samples with optional periodic pauses for V8 background compilation to complete. */
async function runSampleLoop<T>(
  config: CollectParams<T>,
): Promise<SampleArrays & { startTime: number }> {
  const { maxTime, maxIterations, pauseFirst } = config;
  const { pauseInterval = 0, pauseDuration = 100 } = config;
  const getOptStatus = config.traceOpt ? createOptStatusGetter() : undefined;
  const trackOpt = !!getOptStatus;
  const estimated = maxIterations || Math.ceil(maxTime / 0.1);
  const arrays = createSampleArrays(estimated, trackOpt);

  let count = 0;
  let elapsed = 0;
  let totalPauseTime = 0;
  const startTime = Number(process.hrtime.bigint() / 1000n);
  const loopStart = performance.now();

  while (
    (!maxIterations || count < maxIterations) &&
    (!maxTime || elapsed < maxTime)
  ) {
    const start = performance.now();
    executeBenchmark(config.benchmark, config.params);
    const end = performance.now();
    arrays.samples[count] = end - start;
    arrays.heapSamples[count] = getHeapStatistics().used_heap_size;
    if (getOptStatus)
      arrays.optStatuses[count] = getOptStatus(config.benchmark.fn);
    count++;

    if (shouldPause(count, pauseFirst, pauseInterval)) {
      const sampleIndex = count - 1;
      arrays.pausePoints.push({ sampleIndex, durationMs: pauseDuration });
      const pauseStart = performance.now();
      await new Promise(r => setTimeout(r, pauseDuration));
      totalPauseTime += performance.now() - pauseStart;
    }
    elapsed = performance.now() - loopStart - totalPauseTime;
  }

  trimArrays(arrays, count, trackOpt);
  return { ...arrays, startTime };
}

/** Pre-allocate sample arrays to reduce GC pressure during measurement. */
function createSampleArrays(n: number, trackOpt: boolean): SampleArrays {
  const arr = () => new Array<number>(n);
  return {
    samples: arr(),
    heapSamples: arr(),
    optStatuses: trackOpt ? arr() : [],
    pausePoints: [],
  };
}

/** @return true if this iteration should pause for V8 background compilation. */
function shouldPause(
  iter: number,
  first: number | undefined,
  interval: number,
): boolean {
  if (first !== undefined && iter === first) return true;
  if (interval <= 0) return false;
  if (first === undefined) return iter % interval === 0;
  return (iter - first) % interval === 0;
}

/** Trim pre-allocated arrays to the actual sample count. */
function trimArrays(
  arrays: SampleArrays,
  count: number,
  trackOpt: boolean,
): void {
  arrays.samples.length = arrays.heapSamples.length = count;
  if (trackOpt) arrays.optStatuses.length = count;
}
