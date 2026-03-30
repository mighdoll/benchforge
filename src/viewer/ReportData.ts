import type { GitVersion } from "../report/GitUtils.ts";
import type { DifferenceCI } from "../stats/StatisticalUtils.ts";

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
  sectionStats?: SectionStat[];
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
}

/** A labeled value displayed in a report section card. */
export interface SectionStat {
  label: string;
  value: string;
  groupTitle?: string;
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
