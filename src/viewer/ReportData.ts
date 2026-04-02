import type { GitVersion } from "../report/GitUtils.ts";
import type { DifferenceCI, HistogramBin } from "../stats/StatisticalUtils.ts";

/** Top-level data structure for the HTML benchmark report */
export interface ReportData {
  groups: BenchmarkGroup[];
  metadata: {
    timestamp: string;
    bencherVersion: string;
    cliArgs?: Record<string, unknown>;
    gcTrackingEnabled?: boolean;
    currentVersion?: GitVersion;
    baselineVersion?: GitVersion;
  };
}

/** A named group of benchmarks, optionally compared against a baseline. */
export interface BenchmarkGroup {
  name: string;
  baseline?: BenchmarkEntry;
  benchmarks: BenchmarkEntry[];
}

/** One benchmark's raw data, statistics, and optional comparison results */
export interface BenchmarkEntry {
  name: string;
  samples: number[];
  warmupSamples?: number[];
  allocationSamples?: number[];
  heapSamples?: number[];
  gcEvents?: GcEvent[];
  optSamples?: number[];
  pausePoints?: PausePoint[];
  stats: BenchmarkStats;
  heapSize?: { min: number; max: number; avg: number };
  totalTime?: number;
  sections?: ViewerSection[];
  coverageSummary?: CoverageSummary;
  heapSummary?: HeapSummary;
  comparisonCI?: DifferenceCI;
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

/** A section of related stats for the viewer (e.g., "Lines / Sec", "GC") */
export interface ViewerSection {
  title: string;
  tabLink?: string;
  rows: ViewerRow[];
}

/** A stat row with per-run values and optional comparison CI */
export interface ViewerRow {
  label: string;
  entries: ViewerEntry[];
  comparisonCI?: DifferenceCI;
  shared?: boolean;
}

/** A single run's value for a stat */
export interface ViewerEntry {
  runName: string;
  value: string;
  bootstrapCI?: BootstrapCIData;
}

/** Bootstrap CI data for inline visualization */
export interface BootstrapCIData {
  estimate: number;
  ci: [number, number];
  histogram: HistogramBin[];
  /** Formatted CI bounds for display (e.g., ["0.12ms", "0.15ms"]) */
  ciLabels?: [string, string];
}

/** Summary of coverage/call-count data */
export interface CoverageSummary {
  functionCount: number;
  totalCalls: number;
}

/** Summary of heap allocation profile */
export interface HeapSummary {
  totalBytes: number;
  userBytes: number;
}

/** A garbage collection event with timing relative to the benchmark start. */
export interface GcEvent {
  offset: number;
  duration: number;
}

/** Marks a sample where adaptive sampling paused for convergence analysis. */
export interface PausePoint {
  sampleIndex: number;
  durationMs: number;
}
