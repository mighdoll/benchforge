import type {
  CIDirection,
  HistogramBin,
} from "../../stats/StatisticalUtils.ts";

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
}

/** Heap usage sample (in bytes) at a given iteration */
export interface HeapPoint {
  benchmark: string;
  iteration: number;
  value: number;
}

/** Full-GC (mark-compact) event flattened with benchmark name for multi-series
 *  plots. Scavenges are filtered out upstream (they're periodic texture, not
 *  locatable spikes). `duration` is the pause in ms; `bytes` is collected. */
export interface FlatGcEvent {
  benchmark: string;
  sampleIndex: number;
  duration: number;
  bytes: number;
}

/** PausePoint flattened with benchmark name for multi-series plots */
export interface FlatPausePoint {
  benchmark: string;
  sampleIndex: number;
  durationMs: number;
}

/** Display unit (ns/us/ms) with conversion and formatting functions */
export interface TimeUnit {
  unitSuffix: string;
  convertValue: (ms: number) => number;
  formatValue: (d: number) => string;
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

/** Fill/stroke palette keyed by comparison direction, shared across plots.
 *  green=better, red=worse, blue=confirmed equivalent (CI inside the margin),
 *  grey=uncertain (CI straddles zero, no signal). Equivalent is a real verdict,
 *  so it reads distinct from "can't tell". */
export const directionColors: Record<
  CIDirection,
  { fill: string; stroke: string }
> = {
  faster: { fill: "#bbf7d0", stroke: "#22c55e" },
  slower: { fill: "#fee2e2", stroke: "#ef4444" },
  uncertain: { fill: "#e5e7eb", stroke: "#9ca3af" },
  equivalent: { fill: "#dbeafe", stroke: "#3b82f6" },
};

/** Gaussian kernel smoothing over histogram bins (sigma in bin units). */
export function gaussianSmooth(
  bins: HistogramBin[],
  sigma: number,
): HistogramBin[] {
  return bins.map((bin, i) => {
    let weightedSum = 0;
    let weightSum = 0;
    for (let j = 0; j < bins.length; j++) {
      const weight = Math.exp(-((i - j) ** 2) / (2 * sigma ** 2));
      weightedSum += bins[j].count * weight;
      weightSum += weight;
    }
    return { x: bin.x, count: weightedSum / weightSum };
  });
}

/** Pick display unit (ns/us/ms) based on average value magnitude (in ms) */
export function getTimeUnit(values: number[]): TimeUnit {
  const avg = values.reduce((s, v) => s + v, 0) / values.length;
  const locale = (digits: number) => (d: number) =>
    d.toLocaleString("en-US", { maximumFractionDigits: digits });
  const fmt0 = locale(0);
  const fmt1 = locale(1);
  if (avg < 0.001)
    return {
      unitSuffix: "ns",
      convertValue: ms => ms * 1e6,
      formatValue: fmt0,
    };
  if (avg < 1)
    return {
      unitSuffix: "\u00b5s",
      convertValue: ms => ms * 1e3,
      formatValue: fmt1,
    };
  return { unitSuffix: "ms", convertValue: ms => ms, formatValue: fmt1 };
}
