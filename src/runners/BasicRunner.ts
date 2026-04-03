import { getHeapStatistics } from "node:v8";
import {
  coefficientOfVariation,
  medianAbsoluteDeviation,
  percentile,
} from "../stats/StatisticalUtils.ts";
import type { BenchmarkSpec } from "./BenchmarkSpec.ts";
import type { BenchRunner, RunnerOptions } from "./BenchRunner.ts";
import { executeBenchmark } from "./BenchRunner.ts";
import {
  type MeasuredResults,
  type OptStatusInfo,
  optStatusNames,
  type PausePoint,
} from "./MeasuredResults.ts";

type CollectParams<T = unknown> = {
  benchmark: BenchmarkSpec<T>;
  maxTime: number;
  maxIterations: number;
  warmup: number;
  params?: T;
  skipWarmup?: boolean;
  traceOpt?: boolean;
  settle?: number;
  pauseFirst?: number;
  pauseInterval?: number;
  pauseDuration?: number;
};

type CollectResult = {
  samples: number[];
  warmupSamples: number[]; // timing of warmup iterations
  heapGrowth: number; // amortized KB per sample
  heapSamples?: number[]; // heap size per sample (bytes)
  timestamps?: number[]; // wall-clock μs per sample for Perfetto
  optStatus?: OptStatusInfo;
  optSamples?: number[]; // per-sample V8 opt status codes
  pausePoints: PausePoint[]; // where pauses occurred
};

type SampleLoopResult = {
  samples: number[];
  heapSamples?: number[];
  timestamps?: number[];
  optStatuses: number[];
  pausePoints: PausePoint[];
};

type SampleArrays = {
  samples: number[];
  timestamps: number[];
  heapSamples: number[];
  optStatuses: number[];
  pausePoints: PausePoint[];
};

const defaultCollectOptions = {
  maxTime: 5000,
  maxIterations: 1000000,
  warmup: 0,
  traceOpt: false,
  settle: 0,
};

/**
 * Timing-based runner that collects samples within time/iteration limits.
 * Handles warmup, heap tracking, V8 optimization tracing, and periodic pauses.
 */
export class BasicRunner implements BenchRunner {
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

/** Compute percentiles, CV, MAD, and outlier rate from timing samples (ms). */
export function computeStats(samples: number[]): MeasuredResults["time"] {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  let sum = 0;
  for (const s of samples) {
    if (s < min) min = s;
    if (s > max) max = s;
    sum += s;
  }
  return {
    min,
    max,
    avg: sum / samples.length,
    p25: percentile(samples, 0.25),
    p50: percentile(samples, 0.5),
    p75: percentile(samples, 0.75),
    p95: percentile(samples, 0.95),
    p99: percentile(samples, 0.99),
    p999: percentile(samples, 0.999),
    cv: coefficientOfVariation(samples),
    mad: medianAbsoluteDeviation(samples),
    outlierRate: outlierImpactRatio(samples),
  };
}

/** Measure outlier impact as proportion of excess time above the 1.5*IQR threshold. */
export function outlierImpactRatio(samples: number[]): number {
  if (samples.length === 0) return 0;
  const median = percentile(samples, 0.5);
  const q75 = percentile(samples, 0.75);
  const threshold = median + 1.5 * (q75 - median);

  let excessTime = 0;
  for (const sample of samples) {
    if (sample > threshold) excessTime += sample - median;
  }
  const total = samples.reduce((a, b) => a + b, 0);
  return total > 0 ? excessTime / total : 0;
}

/** Collect timing samples with warmup, heap tracking, and optional V8 optimization tracing. */
async function collectSamples<T>(
  config: CollectParams<T>,
): Promise<CollectResult> {
  if (!config.maxIterations && !config.maxTime) {
    throw new Error(`At least one of maxIterations or maxTime must be set`);
  }
  const warmupSamples = config.skipWarmup ? [] : await runWarmup(config);
  const heapBefore = process.memoryUsage().heapUsed;
  const loop = await runSampleLoop(config);
  const { samples, heapSamples, timestamps, optStatuses, pausePoints } = loop;
  if (samples.length === 0) {
    throw new Error(
      `No samples collected for benchmark: ${config.benchmark.name}`,
    );
  }
  const heapDelta = process.memoryUsage().heapUsed - heapBefore;
  const heapGrowth = Math.max(0, heapDelta) / 1024 / samples.length;
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
    timestamps,
    optStatus,
    optSamples,
    pausePoints,
  };
}

/** Assemble collected data into a MeasuredResults record. */
function buildMeasuredResults(
  name: string,
  collected: CollectResult,
): MeasuredResults {
  const {
    samples,
    warmupSamples,
    heapSamples,
    timestamps,
    optStatus,
    optSamples,
    pausePoints,
  } = collected;
  const time = computeStats(samples);
  const heapGrowth = collected.heapGrowth;
  const heapSize = { avg: heapGrowth, min: heapGrowth, max: heapGrowth };
  return {
    name,
    samples,
    warmupSamples,
    heapSamples,
    timestamps,
    time,
    heapSize,
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
  if (config.settle) {
    await new Promise(r => setTimeout(r, config.settle));
    gc();
  }
  return samples;
}

/** Collect timing samples with optional periodic pauses for V8 background compilation. */
async function runSampleLoop<T>(
  config: CollectParams<T>,
): Promise<SampleLoopResult> {
  const { maxTime, maxIterations, pauseFirst } = config;
  const { pauseInterval = 0, pauseDuration = 100 } = config;
  const trackHeap = true;
  const getOptStatus = config.traceOpt ? createOptStatusGetter() : undefined;
  const estimated = maxIterations || Math.ceil(maxTime / 0.1);
  const arrays = createSampleArrays(estimated, trackHeap, !!getOptStatus);

  let count = 0;
  let elapsed = 0;
  let totalPauseTime = 0;
  const loopStart = performance.now();

  while (
    (!maxIterations || count < maxIterations) &&
    (!maxTime || elapsed < maxTime)
  ) {
    const start = performance.now();
    executeBenchmark(config.benchmark, config.params);
    const end = performance.now();
    arrays.samples[count] = end - start;
    arrays.timestamps[count] = Number(process.hrtime.bigint() / 1000n);
    if (trackHeap)
      arrays.heapSamples[count] = getHeapStatistics().used_heap_size;
    if (getOptStatus)
      arrays.optStatuses[count] = getOptStatus(config.benchmark.fn);
    count++;

    if (shouldPause(count, pauseFirst, pauseInterval)) {
      arrays.pausePoints.push({
        sampleIndex: count - 1,
        durationMs: pauseDuration,
      });
      const pauseStart = performance.now();
      await new Promise(r => setTimeout(r, pauseDuration));
      totalPauseTime += performance.now() - pauseStart;
    }
    elapsed = performance.now() - loopStart - totalPauseTime;
  }

  trimArrays(arrays, count, trackHeap, !!getOptStatus);
  const { samples, timestamps, optStatuses, pausePoints } = arrays;
  const heapSamples = trackHeap ? arrays.heapSamples : undefined;
  return { samples, heapSamples, timestamps, optStatuses, pausePoints };
}

/** Group samples by V8 optimization tier and count deoptimizations. */
function analyzeOptStatus(
  samples: number[],
  statuses: number[],
): OptStatusInfo | undefined {
  if (statuses.length === 0 || statuses[0] === undefined) return undefined;

  const samplesByStatus = new Map<number, number[]>();
  let deoptCount = 0;

  for (let i = 0; i < samples.length; i++) {
    const status = statuses[i];
    if (status === undefined) continue;
    if (status & 8) deoptCount++; // Check deopt flag (bit 3)
    if (!samplesByStatus.has(status)) samplesByStatus.set(status, []);
    samplesByStatus.get(status)!.push(samples[i]);
  }

  const byTier: Record<string, { count: number; medianMs: number }> = {};
  for (const [status, times] of samplesByStatus) {
    const name = optStatusNames[status] || `status=${status}`;
    const sorted = [...times].sort((a, b) => a - b);
    const medianMs = sorted[Math.floor(sorted.length / 2)];
    byTier[name] = { count: times.length, medianMs };
  }

  return { byTier, deoptCount };
}

/** Get the runtime gc() function, or a no-op if --expose-gc wasn't passed. */
function gcFunction(): () => void {
  const gc = globalThis.gc ?? (globalThis as any).__gc;
  if (gc) return gc;
  console.warn("gc() not available, run node/bun with --expose-gc");
  return () => {};
}

/** Create a function that reads V8 optimization status via %GetOptimizationStatus. */
function createOptStatusGetter(): ((fn: unknown) => number) | undefined {
  try {
    // %GetOptimizationStatus returns a bitmask
    const fn = new Function("f", "return %GetOptimizationStatus(f)");
    fn(() => {});
    return fn as (fn: unknown) => number;
  } catch {
    return undefined;
  }
}

/** Pre-allocate arrays to reduce GC pressure during measurement. */
function createSampleArrays(
  n: number,
  trackHeap: boolean,
  trackOpt: boolean,
): SampleArrays {
  return {
    samples: new Array<number>(n),
    timestamps: new Array<number>(n),
    heapSamples: trackHeap ? new Array<number>(n) : [],
    optStatuses: trackOpt ? new Array<number>(n) : [],
    pausePoints: [],
  };
}

/** Check if we should pause at this iteration for V8 background compilation. */
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

/** Trim pre-allocated arrays to actual sample count. */
function trimArrays(
  arrays: SampleArrays,
  count: number,
  trackHeap: boolean,
  trackOpt: boolean,
): void {
  arrays.samples.length = arrays.timestamps.length = count;
  if (trackHeap) arrays.heapSamples.length = count;
  if (trackOpt) arrays.optStatuses.length = count;
}
