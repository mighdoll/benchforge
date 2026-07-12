import { getHeapStatistics } from "node:v8";
import type { Rand } from "../stats/Bootstrap.ts";
import type { BenchmarkSpec } from "./BenchmarkSpec.ts";
import type { MeasuredResults, PausePoint } from "./MeasuredResults.ts";
import { computeStats, gcFunction } from "./SampleStats.ts";

/** Configuration for benchmark execution: timing limits, warmup, profiling, and V8 options. */
export interface RunnerOptions {
  /** Maximum time to run each benchmark (milliseconds) */
  maxTime?: number;
  /** Maximum iterations per benchmark */
  maxIterations?: number;
  /** Cap on retained timing samples per batch. A fast benchmark under a time
   *  budget produces millions of samples; beyond this the loop keeps running
   *  (so GC/JIT still land in the window) but reservoir-subsamples what it
   *  stores, bounding memory, IPC serialization, and downstream stats.
   *  0 (or negative) disables the cap; undefined applies the runner default. */
  maxSamples?: number;
  /** Warmup iterations before measurement (default: 0) */
  warmup?: number;
  /** Force GC after each iteration (requires --expose-gc) */
  gcForce?: boolean;
  /** Post-warmup settle time in ms for V8 background compilation (0 to skip) */
  pauseWarmup?: number;
  /** Iterations before first pause (then pauseInterval applies) */
  pauseFirst?: number;
  /** Iterations between pauses for V8 optimization (0 to disable) */
  pauseInterval?: number;
  /** Pause duration in ms for V8 optimization */
  pauseDuration?: number;
  /** Collect GC stats via --trace-gc-nvp (requires worker mode) */
  gcStats?: boolean;
  /** Allocation sampling attribution */
  alloc?: boolean;
  /** Allocation sampling interval in bytes */
  allocInterval?: number;
  /** Allocation sampling stack depth */
  allocDepth?: number;
  /** V8 CPU time sampling */
  profile?: boolean;
  /** CPU sampling interval in microseconds (default 1000) */
  profileInterval?: number;
  /** Collect per-function execution counts via V8 precise coverage */
  callCounts?: boolean;
}

/** Start/stop hooks for external profilers, fired around the measured loop only
 *  (after warmup), so warmup iterations stay out of the CPU/heap profile. */
export interface ProfileBoundary {
  start: () => Promise<void>;
  stop: () => Promise<void>;
}

/** A streaming reservoir over paired (sample, heap) readings. Under the cap it
 *  just appends; past it, Algorithm R keeps a uniform-random subset of size
 *  `cap` in one pass with no advance count. Replacement draws scatter later
 *  arrivals into earlier slots, so `finish` sorts the kept subset back into
 *  arrival order (by each slot's recorded arrival index) to keep the merged
 *  sample timeline and time-series plots ordered. */
export interface Reservoir {
  offer(sample: number, heap: number): void;
  finish(): {
    samples: number[];
    heapSamples: number[];

    /** True offered count, which exceeds the retained length once capped. */
    count: number;

    capped: boolean;
  };
}

type CollectParams<T = unknown> = RunnerOptions &
  Required<Pick<RunnerOptions, "maxTime" | "maxIterations" | "warmup">> & {
    benchmark: BenchmarkSpec<T>;
    params?: T;
    skipWarmup?: boolean;
    boundary?: ProfileBoundary;
  };

type CollectResult = {
  samples: number[];
  warmupSamples: number[];
  heapGrowth: number;
  heapSamples: number[];

  /** True iterations executed, which exceeds samples.length when the reservoir
   *  cap trimmed what was stored. Drives throughput and per-iteration heap. */
  iterations: number;

  startTime: number;

  /** performance.now() at loop start, sharing the clock of --trace-gc-nvp
   *  offsets, so GC events can be rebased to loop-relative time. */
  loopStartTime: number;

  /** performance.now() at loop end; bounds the in-loop GC event window so
   *  teardown GC (result/profile collection) isn't attributed to the loop. */
  loopEndTime: number;

  pausePoints: PausePoint[];
};

const defaultCollectOptions: Required<
  Pick<RunnerOptions, "maxTime" | "maxIterations" | "warmup">
> &
  Pick<RunnerOptions, "pauseWarmup"> = {
  maxTime: 5000,
  maxIterations: 1000000,
  warmup: 0,
  pauseWarmup: 0,
};

/** Default per-batch retained-sample cap. Chosen well above any normal
 *  benchmark (only sub-~microsecond fns under a time budget reach it) and low
 *  enough that even hundreds of batches stay within the 5M merge budget.
 *  The bootstrap CI already caps its input at 10K, so this loses no precision. */
const defaultMaxSamples = 100_000;

/**
 * Timing-based runner that collects samples within time/iteration limits.
 * Handles warmup, heap tracking, and periodic pauses.
 */
export class BenchRunner {
  async runBench<T = unknown>(
    benchmark: BenchmarkSpec<T>,
    options: RunnerOptions,
    params?: T,
    boundary?: ProfileBoundary,
  ): Promise<MeasuredResults[]> {
    const opts = { ...defaultCollectOptions, ...options };
    const collected = await collectSamples({
      ...opts,
      benchmark,
      params,
      boundary,
    });
    return [buildMeasuredResults(benchmark.name, collected)];
  }
}

/** Invoke the benchmark function, forwarding setup params. */
export function executeBenchmark<T>(
  benchmark: BenchmarkSpec<T>,
  params?: T,
): void {
  (benchmark.fn as (params?: T) => void)(params);
}

/** Create a reservoir holding at most `cap` paired readings, pre-sized to
 *  `initialSize` to avoid growth churn during the measured loop. */
export function createReservoir(
  cap: number,
  initialSize = 0,
  random: Rand = Math.random,
): Reservoir {
  const samples = new Array<number>(Math.min(cap, initialSize));
  const heapSamples = new Array<number>(Math.min(cap, initialSize));
  let origins: number[] | undefined; // arrival index per slot, only once capped
  let count = 0;

  function offer(sample: number, heap: number): void {
    if (count < cap) {
      samples[count] = sample;
      heapSamples[count] = heap;
    } else {
      origins ??= Array.from({ length: cap }, (_, i) => i);
      const j = Math.floor(random() * (count + 1));
      if (j < cap) {
        samples[j] = sample;
        heapSamples[j] = heap;
        origins[j] = count;
      }
    }
    count++;
  }

  function finish() {
    if (!origins) {
      samples.length = heapSamples.length = Math.min(count, cap);
      return { samples, heapSamples, count, capped: false };
    }
    const arrivals = origins;
    const order = arrivals
      .map((_, i) => i)
      .sort((a, b) => arrivals[a] - arrivals[b]);
    return {
      samples: order.map(i => samples[i]),
      heapSamples: order.map(i => heapSamples[i]),
      count,
      capped: true,
    };
  }

  return { offer, finish };
}

/** Collect timing samples with warmup and heap tracking. */
async function collectSamples<T>(
  config: CollectParams<T>,
): Promise<CollectResult> {
  if (!config.maxIterations && !config.maxTime) {
    throw new Error(`At least one of maxIterations or maxTime must be set`);
  }
  const warmupSamples = config.skipWarmup ? [] : await runWarmup(config);
  await config.boundary?.start();
  const heapBefore = process.memoryUsage().heapUsed;
  const loop = await runSampleLoop(config);
  const heapAfter = process.memoryUsage().heapUsed;
  await config.boundary?.stop();
  if (loop.samples.length === 0)
    throw new Error(
      `No samples collected for benchmark: ${config.benchmark.name}`,
    );
  const heapGrowth =
    Math.max(0, heapAfter - heapBefore) / 1024 / loop.iterations;
  return { ...loop, warmupSamples, heapGrowth };
}

/** Assemble CollectResult into a MeasuredResults record. */
function buildMeasuredResults(
  name: string,
  collected: CollectResult,
): MeasuredResults {
  const { samples, warmupSamples, heapSamples, pausePoints } = collected;
  const { heapGrowth, startTime, loopStartTime, loopEndTime, iterations } =
    collected;
  const time = computeStats(samples);
  const heapSize = { avg: heapGrowth, min: heapGrowth, max: heapGrowth };
  return {
    name,
    samples,
    iterations,
    warmupSamples,
    heapSamples,
    time,
    heapSize,
    startTime,
    loopStartTime,
    loopEndTime,
    pausePoints,
  };
}

/**
 * Run warmup iterations so V8 tiers the hot code up to its optimized steady state
 * (Ignition ==> Sparkplug ==> Maglev ==> TurboFan) before measurement. Returns
 * warmup timings.
 *
 * The gc runs BEFORE the warmup loop, not after, so measurement starts on a warm
 * heap. What carries across is NOT the heap contents (each call drops its objects
 * as garbage) -- it is the optimized code AND the allocation-site pretenuring
 * assumptions that code was compiled against (new-gen vs old-gen per alloc site,
 * baked into the machine code). A gc placed AFTER warmup re-evaluates pretenuring
 * on a just-collected heap; a flipped decision invalidates the dependent optimized
 * code (V8: "dependent allocation site tenuring changed"), deopting the parser hot
 * set so the first measured iterations run un-optimized. Refill scavenges add
 * single-iteration pauses on top. Both are heap-state transients, not object reuse,
 * and gc-before avoids both -- the ramp survives even a long warmup with gc-after.
 * With warmup=0 this is just a clean-heap gc before measurement (unchanged).
 *
 * Tiering is invocation-gated (it needs enough calls, not main-thread idle time),
 * so a settle pause does not speed it up; bevy/link needs ~40-50 warmup iters to
 * reach plateau. pauseWarmup is kept as an optional settle delay only.
 */
async function runWarmup<T>(config: CollectParams<T>): Promise<number[]> {
  gcFunction()();
  const samples = new Array<number>(config.warmup);
  for (let i = 0; i < config.warmup; i++) {
    const start = performance.now();
    executeBenchmark(config.benchmark, config.params);
    samples[i] = performance.now() - start;
  }
  if (config.pauseWarmup) {
    await new Promise(r => setTimeout(r, config.pauseWarmup));
  }
  return samples;
}

/** Loop timings and the true iteration count, plus the loop's clock anchors. */
type LoopResult = {
  samples: number[];
  heapSamples: number[];
  pausePoints: PausePoint[];
  iterations: number;
  startTime: number;
  loopStartTime: number;
  loopEndTime: number;
};

/** Collect timing samples with optional periodic pauses for V8 background compilation to complete. */
async function runSampleLoop<T>(config: CollectParams<T>): Promise<LoopResult> {
  const { maxTime, maxIterations, pauseFirst } = config;
  const { pauseInterval = 0, pauseDuration = 100 } = config;
  const forceGc = config.gcForce ? gcFunction() : () => {};
  const cap = sampleCap(config.maxSamples);
  const estimated = maxIterations || Math.ceil(maxTime / 0.1);
  const reservoir = createReservoir(cap, Math.min(estimated, cap));
  const pausePoints: PausePoint[] = [];

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
    reservoir.offer(end - start, getHeapStatistics().used_heap_size);
    count++;
    forceGc();

    if (shouldPause(count, pauseFirst, pauseInterval)) {
      pausePoints.push({ sampleIndex: count - 1, durationMs: pauseDuration });
      const pauseStart = performance.now();
      await new Promise(r => setTimeout(r, pauseDuration));
      totalPauseTime += performance.now() - pauseStart;
    }
    elapsed = performance.now() - loopStart - totalPauseTime;
  }
  const loopEnd = performance.now();

  const {
    samples,
    heapSamples,
    count: iterations,
    capped,
  } = reservoir.finish();
  return {
    samples,
    heapSamples,
    // Pause sampleIndexes point into the full stream, which no longer maps once
    // the reservoir dropped samples; matches the merge-subsample precedent.
    pausePoints: capped ? [] : pausePoints,
    iterations,
    startTime,
    loopStartTime: loopStart,
    loopEndTime: loopEnd,
  };
}

/** Resolve the per-batch retained-sample cap. A flag of 0 (or negative) means
 *  unlimited; otherwise the caller's value, else the runner default. */
function sampleCap(maxSamples: number | undefined): number {
  if (maxSamples === undefined) return defaultMaxSamples;
  return maxSamples > 0 ? maxSamples : Number.POSITIVE_INFINITY;
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
