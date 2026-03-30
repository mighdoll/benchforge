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

export interface BenchmarkStats {
  min: number;
  max: number;
  avg: number;
  p50: number;
  p75: number;
  p99: number;
  p999: number;
}

export interface SectionStat {
  label: string;
  value: string;
  groupTitle?: string;
}

export interface GcEvent {
  offset: number;
  duration: number;
}

export interface PausePoint {
  sampleIndex: number;
  durationMs: number;
}

export interface GitVersion {
  hash: string;
  date: string;
  dirty?: boolean;
}
