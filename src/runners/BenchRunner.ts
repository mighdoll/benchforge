import type { BenchmarkSpec } from "./BenchmarkSpec.ts";
import type { MeasuredResults } from "./MeasuredResults.ts";

/** Benchmark execution strategy. Implementations collect timing samples from benchmark functions. */
export interface BenchRunner {
  runBench<T = unknown>(
    benchmark: BenchmarkSpec<T>,
    options: RunnerOptions,
    params?: T,
  ): Promise<MeasuredResults[]>;
}

export interface RunnerOptions {
  /** Minimum time to run each benchmark (milliseconds) */
  minTime?: number;
  /** Maximum time to run each benchmark - ignored by mitata (milliseconds) */
  maxTime?: number;
  /** Maximum iterations per benchmark - ignored by TinyBench */
  maxIterations?: number;
  /** Warmup iterations before measurement (default: 0) */
  warmup?: number;
  /** Warmup time before measurement (milliseconds) */
  warmupTime?: number;
  /** Warmup samples - mitata only, for reducing test time */
  warmupSamples?: number;
  /** Warmup threshold - mitata only (nanoseconds) */
  warmupThreshold?: number;
  /** Minimum samples required - mitata only */
  minSamples?: number;
  /** Force GC after each iteration (requires --expose-gc) */
  gcForce?: boolean;
  /** Trace V8 optimization tiers (requires --allow-natives-syntax) */
  traceOpt?: boolean;
  /** Skip post-warmup settle time (default: false) */
  noSettle?: boolean;
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
  timeSample?: boolean;
  /** CPU sampling interval in microseconds (default 1000) */
  timeInterval?: number;
  /** Collect per-function execution counts via V8 precise coverage */
  callCounts?: boolean;
}

/** Invoke the benchmark function, forwarding setup params if provided. */
export function executeBenchmark<T>(
  benchmark: BenchmarkSpec<T>,
  params?: T,
): void {
  (benchmark.fn as (params?: T) => void)(params);
}
