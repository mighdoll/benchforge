import type { NavTiming } from "../profiling/browser/BrowserProfiler.ts";
import type { CoverageData } from "../profiling/node/CoverageTypes.ts";
import type { HeapProfile } from "../profiling/node/HeapSampler.ts";
import type { TimeProfile } from "../profiling/node/TimeSampler.ts";
import type { GcEvent, GcStats } from "../runners/GcStats.ts";

/** Benchmark results: times in milliseconds, sizes in kilobytes */
export interface MeasuredResults {
  name: string;

  /** Raw execution time samples for custom statistics */
  samples: number[];

  /** Total iterations actually measured. Equals samples.length unless
   *  MergeBatches subsampled to fit V8 array limits. */
  iterations?: number;

  /** Per-batch GC stats, preserved through merge so distribution (min/max/p50
   *  full GCs per batch) can be inspected. Order matches batchOffsets. */
  batchGcStats?: GcStats[];

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

  /** Total time spent collecting samples (seconds) */
  totalTime?: number;

  /** Monotonic start time (μs, hrtime-based) for Perfetto trace alignment. */
  startTime?: number;

  /** performance.now() at sample-loop start, sharing the clock of
   *  --trace-gc-nvp offsets. Used to rebase GC events to loop-relative time. */
  loopStartTime?: number;

  /** Points where pauses occurred for V8 optimization */
  pausePoints?: PausePoint[];

  /** Batch boundaries for block bootstrap (indices into samples where each batch starts) */
  batchOffsets?: number[];

  /** Aggregate GC stats. The portable form: produced by both the Node worker
   *  (--trace-gc-nvp, needs --gc-stats) and the browser (CDP trace events), and
   *  the only GC data that survives subsample/merge. */
  gcStats?: GcStats;

  /** Per-event GC records with loop-relative offsets, for placing GC markers on
   *  the time-series plot. From the Node worker (--trace-gc-nvp) or, in browser
   *  bench mode, CDP trace events rebased via a loop-start mark; needs
   *  --gc-stats. Dropped on subsample since strided samples break the offset
   *  mapping. */
  gcEvents?: GcEvent[];

  /** Heap sampling allocation profile (requires --heap-sample and worker mode) */
  heapProfile?: HeapProfile;

  /** V8 CPU time sampling profile (requires --profile and worker mode). On a
   *  merged batched result this is the last batch's profile (the single profile
   *  the speedscope/flamegraph export expects); {@link timeProfiles} holds them
   *  all for the pooled self-time summary. */
  timeProfile?: TimeProfile;

  /** Every batch's CPU profile, kept in memory so the self-time summary can pool
   *  all the sampled ticks (the per-function baseline delta is noise-limited by
   *  total ticks). Set only on a merged batched result; not serialized. */
  timeProfiles?: TimeProfile[];

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
