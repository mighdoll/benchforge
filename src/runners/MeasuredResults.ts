import type { NavTiming } from "../profiling/browser/BrowserProfiler.ts";
import type { CoverageData } from "../profiling/node/CoverageTypes.ts";
import type { HeapProfile } from "../profiling/node/HeapSampler.ts";
import type { TimeProfile } from "../profiling/node/TimeSampler.ts";
import type { GcStats } from "../runners/GcStats.ts";
import type { NodeGCTime } from "../runners/NodeGC.ts";

/** Benchmark results: times in milliseconds, sizes in kilobytes */
export interface MeasuredResults {
  name: string;

  /** Raw execution time samples for custom statistics */
  samples: number[];

  /** Warmup iteration timings (ms) - captured before gc/pause-warmup */
  warmupSamples?: number[];

  /** Raw allocation samples per iteration (KB) */
  allocationSamples?: number[];

  /** Heap size per sample (bytes) - used for charts */
  heapSamples?: number[];

  /** Execution time in milliseconds */
  time: {
    min: number;
    max: number;
    avg: number;
    p25?: number;
    p50: number;
    p75: number;
    p95?: number;
    p99: number;
    p999: number;
    cv?: number;
    mad?: number;
    outlierRate?: number;
  };

  /** Heap size increase during test run (kilobytes) */
  heapSize?: {
    avg: number;
    min: number;
    max: number;
  };

  /** Time for explicit gc() call after test execution (ms), excludes in-run GC. */
  gcTime?: {
    avg: number;
    min: number;
    max: number;
  };

  /** Stop-the-world GC pause time (ms) via Node perf hooks (nodeObserveGC). */
  nodeGcTime?: NodeGCTime;

  /** Total time spent collecting samples (seconds) */
  totalTime?: number;

  /** Monotonic start time (μs, hrtime-based) for Perfetto trace alignment. */
  startTime?: number;

  /** Convergence information for adaptive mode */
  convergence?: {
    converged: boolean;
    confidence: number;
    reason: string;
  };

  /** V8 optimization tier tracking (requires --allow-natives-syntax) */
  optStatus?: OptStatusInfo;

  /** Per-sample V8 optimization status codes (for chart visualization) */
  optSamples?: number[];

  /** Points where pauses occurred for V8 optimization */
  pausePoints?: PausePoint[];

  /** Batch boundaries for block bootstrap (indices into samples where each batch starts) */
  batchOffsets?: number[];

  /** GC stats from V8's --trace-gc-nvp (requires --gc-stats and worker mode) */
  gcStats?: GcStats;

  /** Heap sampling allocation profile (requires --heap-sample and worker mode) */
  heapProfile?: HeapProfile;

  /** V8 CPU time sampling profile (requires --profile and worker mode) */
  timeProfile?: TimeProfile;

  /** Per-function execution counts (requires --call-counts) */
  coverage?: CoverageData;

  /** Navigation timings from page-load mode (one per iteration) */
  navTimings?: NavTiming[];
}

/** Pause inserted during sample collection for V8 optimization settling. */
export interface PausePoint {
  sampleIndex: number;
  durationMs: number;
}

/** V8 optimization tier distribution */
export interface OptTierInfo {
  count: number;
  medianMs: number;
}

/** V8 optimization status summary */
export interface OptStatusInfo {
  /** Samples by tier name (e.g., "turbofan", "sparkplug") */
  byTier: Record<string, OptTierInfo>;
  /** Number of samples with deopt flag set */
  deoptCount: number;
}

/**
 * V8 GetOptimizationStatus() return codes ==> human-readable tier names.
 *   Bit 0 (1): is_function
 *   Bit 4 (16): is_optimized (TurboFan)
 *   Bit 5 (32): is_optimized (Maglev)
 *   Bit 7 (128): is_baseline (Sparkplug)
 *   Bit 3 (8): maybe_deoptimized
 */
export const optStatusNames: Record<number, string> = {
  1: "interpreted",
  129: "sparkplug", // 1 + 128
  17: "turbofan", // 1 + 16
  33: "maglev", // 1 + 32
  49: "turbofan+maglev", // 1 + 16 + 32
  32769: "optimized", // common optimized status
};
