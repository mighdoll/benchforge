import type { HeapProfile } from "./heap-sample/HeapSampler.ts";
import type { NodeGCTime } from "./NodeGC.ts";
import type { GcStats } from "./runners/GcStats.ts";
import type { TimeProfile } from "./time-sample/TimeSampler.ts";

/** Benchmark results: times in milliseconds, sizes in kilobytes */
export interface MeasuredResults {
  name: string;

  /** Raw execution time samples for custom statistics */
  samples: number[];

  /** Warmup iteration timings (ms) - captured before gc/settle */
  warmupSamples?: number[];

  /** Raw allocation samples per iteration (KB) */
  allocationSamples?: number[];

  /** Heap size per sample (bytes) - used for charts */
  heapSamples?: number[];

  /** Wall-clock timestamps per sample (μs since process start) - for Perfetto export */
  timestamps?: number[];

  /** Execution time in milliseconds (measurement overhead excluded by mitata) */
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

  /**
   * Time for explicit gc() call after test execution (milliseconds).
   * Does not include GC time during test execution.
   * Only reported by mitata runner.
   */
  gcTime?: {
    avg: number;
    min: number;
    max: number;
  };

  /**
   * Stop-the-world GC time blocking main thread (milliseconds).
   * Measured via Node's performance hooks when nodeObserveGC is true.
   * Excludes parallel thread collection time and indirect slowdowns.
   */
  nodeGcTime?: NodeGCTime;

  /** Total time spent collecting samples (seconds) */
  totalTime?: number;

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

  /** GC stats from V8's --trace-gc-nvp (requires --gc-stats and worker mode) */
  gcStats?: GcStats;

  /** Heap sampling allocation profile (requires --heap-sample and worker mode) */
  heapProfile?: HeapProfile;

  /** V8 CPU time sampling profile (requires --time-sample and worker mode) */
  timeProfile?: TimeProfile;
}

/** A pause point during sample collection for V8 optimization */
export interface PausePoint {
  /** Sample index where pause occurred (after this iteration) */
  sampleIndex: number;
  /** Pause duration in milliseconds */
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
