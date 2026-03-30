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

export interface HeapPoint {
  benchmark: string;
  iteration: number;
  value: number;
}

/** GcEvent flattened with benchmark name for multi-series plots */
export interface FlatGcEvent {
  benchmark: string;
  sampleIndex: number;
  duration: number;
}

/** PausePoint flattened with benchmark name for multi-series plots */
export interface FlatPausePoint {
  benchmark: string;
  sampleIndex: number;
  durationMs: number;
}

/** Format a number as a signed percentage string (e.g. "+1.2%", "-3.4%") */
export function formatPct(v: number, precision = 1): string {
  const sign = v >= 0 ? "+" : "";
  return `${sign}${v.toFixed(precision)}%`;
}
