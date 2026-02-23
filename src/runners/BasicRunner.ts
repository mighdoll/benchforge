import { getHeapStatistics } from "node:v8";
import type { BenchmarkSpec } from "../Benchmark.ts";
import type {
  MeasuredResults,
  OptStatusInfo,
  PausePoint,
} from "../MeasuredResults.ts";
import type { BenchRunner, RunnerOptions } from "./BenchRunner.ts";
import { executeBenchmark } from "./BenchRunner.ts";

/**
 * Wait time after gc() for V8 to stabilize (ms).
 *
 * V8 has 4 compilation tiers: Ignition (interpreter) -> Sparkplug (baseline) ->
 * Maglev (mid-tier optimizer) -> TurboFan (full optimizer). Tiering thresholds:
 *   - Ignition -> Sparkplug: 8 invocations
 *   - Sparkplug -> Maglev: 500 invocations
 *   - Maglev -> TurboFan: 6000 invocations
 *
 * Optimization compilation happens on background threads and requires idle time
 * on the main thread to complete. Without sufficient warmup + settle time,
 * benchmarks exhibit bimodal timing: slow Sparkplug samples (~30% slower) mixed
 * with fast optimized samples.
 *
 * The warmup iterations trigger the optimization decision, then gcSettleTime
 * provides idle time for background compilation to finish before measurement.
 *
 * @see https://v8.dev/blog/sparkplug
 * @see https://v8.dev/blog/maglev
 * @see https://v8.dev/blog/background-compilation
 */
const gcSettleTime = 1000;

type CollectParams<T = unknown> = {
  benchmark: BenchmarkSpec<T>;
  maxTime: number;
  maxIterations: number;
  warmup: number;
  params?: T;
  skipWarmup?: boolean;
  traceOpt?: boolean;
  noSettle?: boolean;
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

export type SampleTimeStats = {
  min: number;
  max: number;
  avg: number;
  p50: number;
  p75: number;
  p99: number;
  p999: number;
};

/** @return runner with time and iteration limits */
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

const defaultCollectOptions = {
  maxTime: 5000,
  maxIterations: 1000000,
  warmup: 0,
  traceOpt: false,
  noSettle: false,
};

function buildMeasuredResults(name: string, c: CollectResult): MeasuredResults {
  const time = computeStats(c.samples);
  return {
    name,
    samples: c.samples,
    warmupSamples: c.warmupSamples,
    heapSamples: c.heapSamples,
    timestamps: c.timestamps,
    time,
    heapSize: { avg: c.heapGrowth, min: c.heapGrowth, max: c.heapGrowth },
    optStatus: c.optStatus,
    optSamples: c.optSamples,
    pausePoints: c.pausePoints,
  };
}

/** @return timing samples and amortized allocation from benchmark execution */
async function collectSamples<T>(p: CollectParams<T>): Promise<CollectResult> {
  if (!p.maxIterations && !p.maxTime) {
    throw new Error(`At least one of maxIterations or maxTime must be set`);
  }
  const warmupSamples = p.skipWarmup ? [] : await runWarmup(p);
  const heapBefore = process.memoryUsage().heapUsed;
  const { samples, heapSamples, timestamps, optStatuses, pausePoints } =
    await runSampleLoop(p);
  const heapGrowth =
    Math.max(0, process.memoryUsage().heapUsed - heapBefore) /
    1024 /
    samples.length;
  if (samples.length === 0) {
    throw new Error(`No samples collected for benchmark: ${p.benchmark.name}`);
  }
  const optStatus = p.traceOpt
    ? analyzeOptStatus(samples, optStatuses)
    : undefined;
  const optSamples =
    p.traceOpt && optStatuses.length > 0 ? optStatuses : undefined;
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

/** Run warmup iterations with gc + settle time for V8 optimization */
async function runWarmup<T>(p: CollectParams<T>): Promise<number[]> {
  const gc = gcFunction();
  const samples = new Array<number>(p.warmup);
  for (let i = 0; i < p.warmup; i++) {
    const start = performance.now();
    executeBenchmark(p.benchmark, p.params);
    samples[i] = performance.now() - start;
  }
  gc();
  if (!p.noSettle) {
    await new Promise(r => setTimeout(r, gcSettleTime));
    gc();
  }
  return samples;
}

type SampleLoopResult = {
  samples: number[];
  heapSamples?: number[];
  timestamps?: number[];
  optStatuses: number[];
  pausePoints: PausePoint[];
};

/** Estimate sample count for pre-allocation */
function estimateSampleCount(maxTime: number, maxIterations: number): number {
  return maxIterations || Math.ceil(maxTime / 0.1); // assume 0.1ms per iteration minimum
}

type SampleArrays = {
  samples: number[];
  timestamps: number[];
  heapSamples: number[];
  optStatuses: number[];
  pausePoints: PausePoint[];
};

/** Pre-allocate arrays to reduce GC pressure during measurement */
function createSampleArrays(
  n: number,
  trackHeap: boolean,
  trackOpt: boolean,
): SampleArrays {
  const arr = (track: boolean) => (track ? new Array<number>(n) : []);
  return {
    samples: new Array<number>(n),
    timestamps: new Array<number>(n),
    heapSamples: arr(trackHeap),
    optStatuses: arr(trackOpt),
    pausePoints: [],
  };
}

/** Trim arrays to actual sample count */
function trimArrays(
  a: SampleArrays,
  count: number,
  trackHeap: boolean,
  trackOpt: boolean,
): void {
  a.samples.length = a.timestamps.length = count;
  if (trackHeap) a.heapSamples.length = count;
  if (trackOpt) a.optStatuses.length = count;
}

/** Collect timing samples with periodic pauses for V8 optimization */
async function runSampleLoop<T>(
  p: CollectParams<T>,
): Promise<SampleLoopResult> {
  const {
    maxTime,
    maxIterations,
    pauseFirst,
    pauseInterval = 0,
    pauseDuration = 100,
  } = p;
  const trackHeap = true; // Always track heap for charts
  const getOptStatus = p.traceOpt ? createOptStatusGetter() : undefined;
  const estimated = estimateSampleCount(maxTime, maxIterations);
  const a = createSampleArrays(estimated, trackHeap, !!getOptStatus);

  let count = 0;
  let elapsed = 0;
  let totalPauseTime = 0;
  const loopStart = performance.now();

  while (
    (!maxIterations || count < maxIterations) &&
    (!maxTime || elapsed < maxTime)
  ) {
    const start = performance.now();
    executeBenchmark(p.benchmark, p.params);
    const end = performance.now();
    a.samples[count] = end - start;
    a.timestamps[count] = Number(process.hrtime.bigint() / 1000n);
    if (trackHeap) a.heapSamples[count] = getHeapStatistics().used_heap_size;
    if (getOptStatus) a.optStatuses[count] = getOptStatus(p.benchmark.fn);
    count++;

    if (shouldPause(count, pauseFirst, pauseInterval)) {
      a.pausePoints.push({ sampleIndex: count - 1, durationMs: pauseDuration });
      const pauseStart = performance.now();
      await new Promise(r => setTimeout(r, pauseDuration));
      totalPauseTime += performance.now() - pauseStart;
    }
    elapsed = performance.now() - loopStart - totalPauseTime;
  }

  trimArrays(a, count, trackHeap, !!getOptStatus);
  return {
    samples: a.samples,
    heapSamples: trackHeap ? a.heapSamples : undefined,
    timestamps: a.timestamps,
    optStatuses: a.optStatuses,
    pausePoints: a.pausePoints,
  };
}

/** Check if we should pause at this iteration for V8 optimization */
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

/** @return percentiles and basic statistics */
export function computeStats(samples: number[]): SampleTimeStats {
  const sorted = [...samples].sort((a, b) => a - b);
  const avg = samples.reduce((sum, s) => sum + s, 0) / samples.length;
  return {
    min: sorted[0],
    max: sorted[sorted.length - 1],
    avg,
    p50: percentile(sorted, 0.5),
    p75: percentile(sorted, 0.75),
    p99: percentile(sorted, 0.99),
    p999: percentile(sorted, 0.999),
  };
}

/** @return percentile value with linear interpolation */
function percentile(sortedArray: number[], p: number): number {
  const index = (sortedArray.length - 1) * p;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  const weight = index % 1;

  if (upper >= sortedArray.length) return sortedArray[sortedArray.length - 1];

  return sortedArray[lower] * (1 - weight) + sortedArray[upper] * weight;
}

/** @return runtime gc() function, or no-op if unavailable */
function gcFunction(): () => void {
  const gc = globalThis.gc || (globalThis as any).__gc;
  if (gc) return gc;
  console.warn("gc() not available, run node/bun with --expose-gc");
  return () => {};
}

/** @return function to get V8 optimization status (requires --allow-natives-syntax) */
function createOptStatusGetter(): ((fn: unknown) => number) | undefined {
  try {
    // %GetOptimizationStatus returns a bitmask
    const getter = new Function("f", "return %GetOptimizationStatus(f)");
    getter(() => {});
    return getter as (fn: unknown) => number;
  } catch {
    return undefined;
  }
}

/**
 * V8 optimization status bit meanings:
 *   Bit 0 (1): is_function
 *   Bit 4 (16): is_optimized (TurboFan)
 *   Bit 5 (32): is_optimized (Maglev)
 *   Bit 7 (128): is_baseline (Sparkplug)
 *   Bit 3 (8): maybe_deoptimized
 */
const statusNames: Record<number, string> = {
  1: "interpreted",
  129: "sparkplug", // 1 + 128
  17: "turbofan", // 1 + 16
  33: "maglev", // 1 + 32
  49: "turbofan+maglev", // 1 + 16 + 32
  32769: "optimized", // common optimized status
};

/** @return analysis of V8 optimization status per sample */
function analyzeOptStatus(
  samples: number[],
  statuses: number[],
): OptStatusInfo | undefined {
  if (statuses.length === 0 || statuses[0] === undefined) return undefined;

  const byStatusCode = new Map<number, number[]>();
  let deoptCount = 0;

  for (let i = 0; i < samples.length; i++) {
    const status = statuses[i];
    if (status === undefined) continue;

    // Check deopt flag (bit 3)
    if (status & 8) deoptCount++;

    if (!byStatusCode.has(status)) byStatusCode.set(status, []);
    byStatusCode.get(status)!.push(samples[i]);
  }

  const byTier: Record<string, { count: number; medianMs: number }> = {};
  for (const [status, times] of byStatusCode) {
    const name = statusNames[status] || `status=${status}`;
    const sorted = [...times].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    byTier[name] = { count: times.length, medianMs: median };
  }

  return { byTier, deoptCount };
}
