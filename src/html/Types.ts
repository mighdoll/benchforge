/** Data passed to the HTML report generator */
export interface ReportData {
  groups: GroupData[];
  metadata: {
    timestamp: string;
    bencherVersion: string;
    cliArgs?: Record<string, unknown>;
    gcTrackingEnabled?: boolean;
    currentVersion?: GitVersion;
    baselineVersion?: GitVersion;
  };
}

export interface GroupData {
  name: string;
  baseline?: BenchmarkData;
  benchmarks: BenchmarkData[];
}

export interface BenchmarkData {
  name: string;
  samples: number[];
  warmupSamples?: number[];
  allocationSamples?: number[];
  heapSamples?: number[];
  gcEvents?: GcEvent[];
  optSamples?: number[];
  pausePoints?: PausePoint[];
  stats: {
    min: number;
    max: number;
    avg: number;
    p50: number;
    p75: number;
    p99: number;
    p999: number;
  };
  heapSize?: { min: number; max: number; avg: number };
  sectionStats?: FormattedStat[];
  comparisonCI?: DifferenceCI;
}

export interface FormattedStat {
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

export type CIDirection = "faster" | "slower" | "uncertain";

export interface HistogramBin {
  x: number;
  count: number;
}

export interface DifferenceCI {
  percent: number;
  ci: [number, number];
  direction: CIDirection;
  histogram?: HistogramBin[];
}

export interface HtmlReportOptions {
  openBrowser: boolean;
  outputPath?: string;
}

export interface HtmlReportResult {
  reportDir: string;
  server?: import("node:http").Server;
  closeServer?: () => void;
}
