/** A single timing sample from a benchmark run */
export interface Sample {
  benchmark: string;
  value: number;
  iteration: number;
}

/** A sample with warmup/optimization metadata for time series plots */
export interface TimeSeriesPoint {
  benchmark: string;
  iteration: number;
  value: number;
  isWarmup: boolean;
  isBaseline?: boolean;
  isRejected?: boolean;
  /** V8 optimization status code (e.g. 17=turbofan, 33=maglev) */
  optStatus?: number;
}

/** Heap usage sample (in bytes) at a given iteration */
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

/** Shared Observable Plot layout: margins, dimensions, font size */
export const plotLayout = {
  marginTop: 24,
  marginLeft: 70,
  marginRight: 110,
  marginBottom: 60,
  width: 550,
  height: 300,
  style: { fontSize: "14px" },
} as const;

/** Format a number as a signed percentage string (e.g. "+1.2%", "-3.4%") */
export function formatPct(v: number, precision = 1): string {
  const sign = v >= 0 ? "+" : "";
  return `${sign}${v.toFixed(precision)}%`;
}

export interface TimeUnit {
  unitSuffix: string;
  convertValue: (ms: number) => number;
  formatValue: (d: number) => string;
}

/** Pick display unit (ns/us/ms) based on average value magnitude (in ms) */
export function getTimeUnit(values: number[]): TimeUnit {
  let sum = 0;
  for (const v of values) sum += v;
  const avg = sum / values.length;
  const locale = (digits: number) => (d: number) =>
    d.toLocaleString("en-US", { maximumFractionDigits: digits });
  const fmt0 = locale(0);
  const fmt1 = locale(1);
  if (avg < 0.001)
    return {
      unitSuffix: "ns",
      convertValue: (ms: number) => ms * 1e6,
      formatValue: fmt0,
    };
  if (avg < 1)
    return {
      unitSuffix: "\u00b5s",
      convertValue: (ms: number) => ms * 1e3,
      formatValue: fmt1,
    };
  return {
    unitSuffix: "ms",
    convertValue: (ms: number) => ms,
    formatValue: fmt1,
  };
}
