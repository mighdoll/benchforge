import type { GitVersion } from "../report/GitUtils.ts";
import type { PausePoint } from "../runners/MeasuredResults.ts";
import type {
  CILevel,
  DifferenceCI,
  HistogramBin,
} from "../stats/StatisticalUtils.ts";

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

/** A named group of benchmarks, optionally compared against a baseline. */
export interface BenchmarkGroup {
  name: string;
  baseline?: BenchmarkEntry;
  benchmarks: BenchmarkEntry[];
  warnings?: string[];
}

/** One benchmark's raw data, statistics, and optional comparison results.
 *  sections / comparisonCI hold the trimmed (slow-outlier-removed) view.
 *  rawSections / rawComparisonCI hold the untrimmed view, present when
 *  trimming had any effect (otherwise the two views are identical). */
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
  optSamples?: number[];
  pausePoints?: PausePoint[];
  batchOffsets?: number[];
  stats: BenchmarkStats;
  heapSize?: { min: number; max: number; avg: number };
  totalTime?: number;
  sections?: ViewerSection[];
  rawSections?: ViewerSection[];
  coverageSummary?: CoverageSummary;
  heapSummary?: HeapSummary;
  comparisonCI?: DifferenceCI;
  rawComparisonCI?: DifferenceCI;
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
}

/** A stat row with per-run values and optional comparison CI. */
export interface ViewerRow {
  label: string;
  entries: ViewerEntry[];
  comparisonCI?: DifferenceCI;
  shared?: boolean;

  /** First comparable row with a statKind in the section. */
  primary?: boolean;

  /** Per-percentile diff distribution for the shift-function plot, present on
   *  the primary row of a comparable section when a baseline exists. */
  shiftFunction?: ShiftFunction;
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

/** A single run's value for a stat. */
export interface ViewerEntry {
  runName: string;
  value: string;
  bootstrapCI?: BootstrapCIData;
}

/** Bootstrap CI data for inline visualization. */
export interface BootstrapCIData {
  estimate: number;
  ci: [number, number];
  histogram: HistogramBin[];

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
}
