export interface Sample {
  benchmark: string;
  value: number;
  iteration: number;
}

export interface TimeSeriesPoint {
  benchmark: string;
  iteration: number;
  value: number;
  isWarmup: boolean;
  optStatus?: number;
}

export interface GcEvent {
  benchmark: string;
  sampleIndex: number;
  duration: number;
}

export interface PausePoint {
  benchmark: string;
  sampleIndex: number;
  durationMs: number;
}

export interface HeapPoint {
  benchmark: string;
  iteration: number;
  value: number;
}

export interface BenchmarkStats {
  min: number;
  max: number;
  avg: number;
  p50: number;
  p75: number;
  p99: number;
}

export interface SectionStat {
  groupTitle?: string;
  label: string;
  value: string;
}

export interface HistogramBin {
  x: number;
  count: number;
}

/** Bootstrap confidence interval for A/B comparison */
export interface ComparisonCI {
  percent: number;
  ci: [number, number];
  direction: "faster" | "slower" | "uncertain";
  histogram?: HistogramBin[];
}

/** One benchmark's raw data, statistics, and optional comparison results */
export interface BenchmarkEntry {
  name: string;
  samples: number[];
  warmupSamples?: number[];
  heapSamples?: number[];
  gcEvents?: { offset: number; duration: number }[];
  optSamples?: number[];
  pausePoints?: { sampleIndex: number; durationMs: number }[];
  stats: BenchmarkStats;
  sectionStats?: SectionStat[];
  comparisonCI?: ComparisonCI;
  isBaseline: boolean;
}

export interface BenchmarkGroup {
  baseline?: BenchmarkEntry;
  benchmarks: BenchmarkEntry[];
}

export interface GitVersion {
  hash: string;
  date: string;
  dirty?: boolean;
}

/** Top-level data structure for the HTML benchmark report */
export interface ReportData {
  metadata: {
    cliArgs?: Record<string, unknown>;
    gcTrackingEnabled?: boolean;
    currentVersion?: GitVersion;
    baselineVersion?: GitVersion;
  };
  groups: BenchmarkGroup[];
}
