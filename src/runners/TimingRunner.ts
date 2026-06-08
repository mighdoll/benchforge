import { getHeapStatistics } from "node:v8";
import type { BenchmarkSpec } from "./BenchmarkSpec.ts";
import type { BenchRunner, RunnerOptions } from "./BenchRunner.ts";
import { executeBenchmark } from "./BenchRunner.ts";
import type { MeasuredResults, PausePoint } from "./MeasuredResults.ts";
import { computeStats, gcFunction } from "./SampleStats.ts";

type CollectParams<T = unknown> = RunnerOptions &
  Required<Pick<RunnerOptions, "maxTime" | "maxIterations" | "warmup">> & {
    benchmark: BenchmarkSpec<T>;
    params?: T;
    skipWarmup?: boolean;
  };

type CollectResult = {
  samples: number[];
  warmupSamples: number[];
  heapGrowth: number;
  heapSamples: number[];
  startTime: number;
  /** performance.now() at loop start, sharing the clock of --trace-gc-nvp
   *  offsets, so GC events can be rebased to loop-relative time. */
  loopStartTime: number;
  pausePoints: PausePoint[];
};

type SampleArrays = {
  samples: number[];
  heapSamples: number[];
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

/**
 * Timing-based runner that collects samples within time/iteration limits.
 * Handles warmup, heap tracking, and periodic pauses.
 */
export class TimingRunner implements BenchRunner {
  async runBench<T = unknown>(
    benchmark: BenchmarkSpec<T>,
    options: RunnerOptions,
    params?: T,
  ): Promise<MeasuredResults[]> {
    const opts = { ...defaultCollectOptions, ...options };
    const collected = await collectSamples({ ...opts, benchmark, params });
    return [buildMeasuredResults(benchmark.name, collected)];
  }
}

/** Collect timing samples with warmup and heap tracking. */
async function collectSamples<T>(
  config: CollectParams<T>,
): Promise<CollectResult> {
  if (!config.maxIterations && !config.maxTime) {
    throw new Error(`At least one of maxIterations or maxTime must be set`);
  }
  const warmupSamples = config.skipWarmup ? [] : await runWarmup(config);
  const heapBefore = process.memoryUsage().heapUsed;
  const loop = await runSampleLoop(config);
  if (loop.samples.length === 0)
    throw new Error(
      `No samples collected for benchmark: ${config.benchmark.name}`,
    );
  const heapAfter = process.memoryUsage().heapUsed;
  const heapGrowth =
    Math.max(0, heapAfter - heapBefore) / 1024 / loop.samples.length;
  return { ...loop, warmupSamples, heapGrowth };
}

/** Assemble CollectResult into a MeasuredResults record. */
function buildMeasuredResults(
  name: string,
  collected: CollectResult,
): MeasuredResults {
  const { samples, warmupSamples, heapSamples } = collected;
  const { pausePoints, heapGrowth } = collected;
  const { startTime, loopStartTime } = collected;
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
    loopStartTime,
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

/** Collect timing samples with optional periodic pauses for V8 background compilation to complete. */
async function runSampleLoop<T>(
  config: CollectParams<T>,
): Promise<SampleArrays & { startTime: number; loopStartTime: number }> {
  const { maxTime, maxIterations, pauseFirst } = config;
  const { pauseInterval = 0, pauseDuration = 100 } = config;
  const forceGc = config.gcForce ? gcFunction() : () => {};
  const estimated = maxIterations || Math.ceil(maxTime / 0.1);
  const arrays = createSampleArrays(estimated);

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
    count++;
    forceGc();

    if (shouldPause(count, pauseFirst, pauseInterval)) {
      const sampleIndex = count - 1;
      arrays.pausePoints.push({ sampleIndex, durationMs: pauseDuration });
      const pauseStart = performance.now();
      await new Promise(r => setTimeout(r, pauseDuration));
      totalPauseTime += performance.now() - pauseStart;
    }
    elapsed = performance.now() - loopStart - totalPauseTime;
  }

  trimArrays(arrays, count);
  return { ...arrays, startTime, loopStartTime: loopStart };
}

/** Pre-allocate sample arrays to reduce GC pressure during measurement. */
function createSampleArrays(n: number): SampleArrays {
  const arr = () => new Array<number>(n);
  return {
    samples: arr(),
    heapSamples: arr(),
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
function trimArrays(arrays: SampleArrays, count: number): void {
  arrays.samples.length = arrays.heapSamples.length = count;
}
