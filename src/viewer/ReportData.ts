import type { GcByBatchSummary } from "../report/GcByBatch.ts";
import type { GitVersion } from "../report/GitUtils.ts";
import type { WarmupShape } from "../report/WarmupShape.ts";
import type { PausePoint } from "../runners/MeasuredResults.ts";
import type {
  CILevel,
  DifferenceCI,
  HistogramBin,
} from "../stats/Bootstrap.ts";

/** Top-level data structure for the HTML benchmark report. */
export interface ReportData {
  groups: BenchmarkGroup[];
  metadata: {
    timestamp: string;
    bencherVersion: string;
    cliArgs?: Record<string, unknown>;
    cliDefaults?: Record<string, unknown>;
    gcTrackingEnabled?: boolean;
    currentVersion?: GitVersion;
    baselineVersion?: GitVersion;
    environment?: {
      node: string;
      platform: string;
      arch: string;
    };
  };
}

/** A named group of benchmarks (a matrix case), optionally compared against a
 *  baseline. Its sections are track-columned: one ViewerEntry per display track
 *  (baseline + comparison variants), built once in the prep layer. */
export interface BenchmarkGroup {
  name: string;
  baseline?: BenchmarkEntry;
  benchmarks: BenchmarkEntry[];
  warnings?: string[];

  /** Case-level report sections, one ViewerEntry per track. The trimmed
   *  (slow-outlier-removed) view; rawSections holds the untrimmed view, present
   *  when trimming changed something (otherwise the two views are identical). */
  sections?: ViewerSection[];
  rawSections?: ViewerSection[];
}

/** One benchmark's raw per-series data and statistics: the samples and
 *  profiling streams the Samples tab, the detail modal, and the analyze command
 *  read. Derived comparison sections live on the enclosing BenchmarkGroup
 *  (track-columned), not here. */
export interface BenchmarkEntry {
  name: string;

  /** Per-benchmark metadata (e.g. linesOfCode) for display transforms and for
   *  agents reading the archive without recomputing stats. */
  metadata?: Record<string, unknown>;
  samples: number[];
  warmupSamples?: number[];
  allocationSamples?: number[];
  heapSamples?: number[];
  gcEvents?: GcEvent[];
  pausePoints?: PausePoint[];
  batchOffsets?: number[];
  /** Per-batch full-GC diagnostic summary (worker-mode --gc-stats runs). */
  gcByBatch?: GcByBatchSummary;
  /** Per-batch time-by-position summary surfacing the JIT/heap warmup ramp. */
  warmupShape?: WarmupShape;
  stats: BenchmarkStats;
  heapSize?: { min: number; max: number; avg: number };
  totalTime?: number;
  coverageSummary?: CoverageSummary;
  heapSummary?: HeapSummary;
  /** This benchmark's own paired baseline (matrix variants each compare against
   *  their own), for the analyze command's per-batch diagnostics. */
  baseline?: BenchmarkEntry;
}

/** Summary percentile statistics for a benchmark's samples. */
export interface BenchmarkStats {
  min: number;
  max: number;
  avg: number;
  p50: number;
  p75: number;
  p99: number;
  p999: number;
  cv?: number;
  mad?: number;
  outlierRate?: number;
}

/** A section of related stats for the viewer (e.g., "Lines / Sec", "GC"). */
export interface ViewerSection {
  title: string;
  tabLink?: string;
  rows: ViewerRow[];

  /** Rendering layout hint; "matrix" packs scalar metrics into a dense table. */
  layout?: "matrix";

  /** Placement hint; "footer" renders once per group in a bottom strip. */
  placement?: "footer";
}

/** A stat row: one ViewerEntry per track (baseline + comparison variants). */
export interface ViewerRow {
  label: string;
  entries: ViewerEntry[];
  shared?: boolean;

  /** The metric row of a metric section: drives the headline and shift fan. */
  primary?: boolean;

  /** Short stat label for the headline, e.g. "mean", "p50". Set on metric rows. */
  statLabel?: string;
}

/** Diff across the whole distribution: one entry per displayed percentile.
 *  Computed from raw samples; percentiles are labeled in the displayed metric
 *  (for higherIsBetter metrics this inverts vs the timing percentile). */
export interface ShiftFunction {
  /** Displayed metric label, e.g. "lines / sec" or "mean". */
  metric: string;
  /** Equivalence margin in percent, when set on the run (draws a +/- band). */
  equivMargin?: number;
  points: ShiftPercentile[];
}

/** One percentile's diff distribution plus per-run absolute distributions. */
export interface ShiftPercentile {
  /** true for the leading mean point (a summary stat, not a percentile);
   *  the plot gives it its own slot ahead of p1, set off by a divider. */
  isMean?: boolean;

  /** true for the point matching the section's configured verdict stat (the
   *  selected verdict); rendered with a larger label. */
  isPrimary?: boolean;

  /** Displayed-metric percentile in [0, 1] (e.g. 0.5 for the median). */
  percentile: number;
  /** Short label, e.g. "p50", "p99", "p0.1". */
  label: string;
  /** Diff CI in percent (direction respects higherIsBetter). */
  diff: DifferenceCI;
  /** Absolute distributions per run (current first, then baseline). */
  runs: ShiftRun[];

  /** false when too few tail samples/batches support a stable estimate. */
  reliable: boolean;
  /** Samples beyond this percentile (min across runs); drives reliability. */
  tailCount: number;
  /** Distinct batches contributing tail samples (min across runs). */
  tailBatches: number;
}

/** A single run's absolute distribution at one percentile. */
export interface ShiftRun {
  runName: string;
  bootstrapCI: BootstrapCIData;
}

/** A single track's cell in a row: its value and distribution, plus (for a
 *  comparison track) its diff vs the case baseline. */
export interface ViewerEntry {
  runName: string;
  value: string;
  bootstrapCI?: BootstrapCIData;

  /** True for the reference (baseline) track: carries no Δ% or shift. */
  isBaseline?: boolean;

  /** This track's comparison vs the case baseline. Absent on the baseline track
   *  and on non-comparable rows. */
  comparisonCI?: DifferenceCI;

  /** This track's per-percentile diff distribution for the shift-function plot,
   *  present on the primary metric row of a comparison track. */
  shiftFunction?: ShiftFunction;
}

/** Bootstrap CI data for inline visualization. */
export interface BootstrapCIData {
  estimate: number;
  ci: [number, number];
  histogram: HistogramBin[];

  /** Formatted point estimate for display (e.g. "381,729") */
  estimateLabel?: string;

  /** Formatted CI bounds for display (e.g., ["0.12ms", "0.15ms"]) */
  ciLabels?: [string, string];

  /** Block-level (between-run) or sample-level (within-run) resampling */
  ciLevel?: CILevel;

  /** false when batch count is too low for reliable CI */
  ciReliable?: boolean;
}

/** Summary of coverage/call-count data. */
export interface CoverageSummary {
  functionCount: number;
  totalCalls: number;
}

/** Summary of heap allocation profile. */
export interface HeapSummary {
  totalBytes: number;
  userBytes: number;
}

/** A garbage collection event with timing relative to the benchmark start. */
export interface GcEvent {
  offset: number;
  duration: number;
  /** GC kind, so the viewer can mark full GCs (mark-compact) distinctly from
   *  the periodic scavenge texture. */
  type: "scavenge" | "mark-compact" | "minor-ms" | "unknown";
  /** Bytes freed by this collection (for the tooltip). */
  collected: number;
}
