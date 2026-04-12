import * as Plot from "@observablehq/plot";
import * as d3 from "d3";
import type { LegendItem } from "./LegendUtils.ts";
import type { FlatGcEvent, FlatPausePoint } from "./PlotTypes.ts";

/** Internal sample representation with display values and metadata */
export interface SampleData {
  benchmark: string;
  sample: number;
  value: number;
  displayValue: number;
  isBaseline: boolean;
  isWarmup: boolean;
  isRejected: boolean;
  optTier: string | null;
}

/** Computed scales, ranges, and metadata for rendering the time series plot */
export interface PlotContext {
  convertedData: SampleData[];
  xMin: number;
  xMax: number;
  yMin: number;
  yMax: number;
  unitSuffix: string;
  formatValue: (d: number) => string;
  convertValue: (ms: number) => number;
  hasWarmup: boolean;
  hasRejected: boolean;
  baselineNames: Set<string>;
  optTiers: string[];
  benchmarks: string[];
}

/** Parameters for mapping heap byte values to the time series Y axis */
export interface HeapScale {
  heapMinBytes: number;
  heapRangeBytes: number;
  scale: number;
  yMin: number;
}

interface LegendParams {
  hasWarmup: boolean;
  gcCount: number;
  pauseCount: number;
  hasHeap: boolean;
  hasBaselineHeap: boolean;
  hasRejected: boolean;
  optTiers: string[];
  benchmarks: string[];
  baselineNames: Set<string>;
}

type Downsample = <T>(
  data: T[],
  n: number,
  getX: (d: T) => number,
  getY: (d: T) => number,
) => T[];

const optTierColors: Record<string, string> = {
  turbofan: "#22c55e",
  optimized: "#22c55e",
  "turbofan+maglev": "#22c55e",
  maglev: "#eab308",
  sparkplug: "#f97316",
  interpreted: "#dc3545",
};

const maxDots = 1000;

/** Build legend items based on which data series are present in the plot */
export function buildLegendItems(p: LegendParams): LegendItem[] {
  const { hasWarmup, gcCount, pauseCount, hasHeap, hasBaselineHeap } = p;
  const { hasRejected, optTiers, benchmarks, baselineNames } = p;
  const items: LegendItem[] = [];
  if (hasWarmup)
    items.push({ color: "#dc3545", label: "warmup", style: "hollow-dot" });
  if (gcCount > 0)
    items.push({
      color: "#22c55e",
      label: `gc (${gcCount})`,
      style: "vertical-line",
    });
  if (pauseCount > 0)
    items.push({
      color: "#888",
      label: `pause (${pauseCount})`,
      style: "vertical-line",
      strokeDash: "4,4",
    });
  if (hasHeap) items.push({ color: "#93c5fd", label: "heap", style: "rect" });
  if (hasBaselineHeap)
    items.push({ color: "#fcd34d", label: "heap (baseline)", style: "rect" });
  items.push(...seriesLegendItems(optTiers, benchmarks, baselineNames));
  if (hasRejected)
    items.push({ color: "#999", label: "rejected", style: "hollow-dot" });
  return items;
}

/** Area fill marks for heap usage overlay on the time series chart */
export function heapMarks(
  heapData: { sample: number; y: number }[],
  yMin: number,
  color: string,
): any[] {
  if (heapData.length === 0) return [];
  return [
    Plot.areaY(heapData, {
      x: "sample",
      y: "y",
      y1: yMin,
      fill: color,
      fillOpacity: 0.15,
      stroke: color,
      strokeWidth: 1,
      strokeOpacity: 0.4,
    }),
  ];
}

/** Right-side Y axis for heap MB (overlaid on the time Y axis) */
export function heapAxisMarks(
  hs: HeapScale | undefined,
  xMax: number,
  xMin: number,
): any[] {
  if (!hs) return [];
  const xRange = xMax - xMin;
  const tickX = xMax + xRange * 0.01;
  const labelX = xMax + xRange * 0.06;
  const minMB = hs.heapMinBytes / 1024 / 1024;
  const maxMB = (hs.heapMinBytes + hs.heapRangeBytes) / 1024 / 1024;
  const ticks = d3.ticks(minMB, maxMB, 3);
  const fmtMB = (mb: number) => {
    if (mb >= 100) return mb.toFixed(0);
    if (mb >= 10) return mb.toFixed(1);
    return mb.toFixed(2);
  };
  const tickData = ticks.map(mb => ({
    x: tickX,
    y: hs.yMin + (mb * 1024 * 1024 - hs.heapMinBytes) * hs.scale,
    label: fmtMB(mb),
  }));
  const textOpts = {
    x: "x",
    y: "y",
    fontSize: 10,
    textAnchor: "start" as const,
    fill: "#333",
    clip: false,
  };
  const mbY = hs.yMin + hs.heapRangeBytes * hs.scale * 0.5;
  const mbData = [{ x: labelX, y: mbY, text: "MB" }];
  return [
    Plot.text(tickData, { ...textOpts, text: "label" }),
    Plot.text(mbData, { ...textOpts, text: "text" }),
  ];
}

/** Vertical line marks for GC events rising from the X axis */
export function gcMark(
  gcEvents: FlatGcEvent[],
  yMin: number,
  convertValue: (ms: number) => number,
): any {
  const data = gcEvents.map(gc => ({
    x1: gc.sampleIndex,
    y1: yMin,
    x2: gc.sampleIndex,
    y2: yMin + convertValue(gc.duration),
    duration: gc.duration,
  }));
  return Plot.link(data, {
    x1: "x1",
    y1: "y1",
    x2: "x2",
    y2: "y2",
    stroke: "#22c55e",
    strokeWidth: 2,
    strokeOpacity: 0.8,
    title: (d: { duration: number }) => `GC: ${d.duration.toFixed(2)}ms`,
  });
}

/** Dashed vertical rules marking pause points across the full Y range */
export function pauseMarks(
  pausePoints: FlatPausePoint[],
  yMin: number,
  yMax: number,
): any[] {
  return pausePoints.map(p =>
    Plot.ruleX([p.sampleIndex], {
      y1: yMin,
      y2: yMax,
      stroke: "#888",
      strokeWidth: 1,
      strokeDasharray: "4,4",
      strokeOpacity: 0.7,
      title: `Pause: ${p.durationMs}ms`,
    }),
  );
}

/** Dot marks for all sample categories: warmup, baseline, measured, rejected */
export function sampleDotMarks(
  ctx: PlotContext,
  showRejected: boolean,
  lttb: Downsample,
): any[] {
  const { unitSuffix, formatValue } = ctx;
  const fmtVal = (d: SampleData) =>
    `${formatValue(d.displayValue)}${unitSuffix}`;
  const tipTitle = (d: SampleData) =>
    d.optTier
      ? `Iteration ${d.sample}: ${fmtVal(d)} [${d.optTier}]`
      : `Iteration ${d.sample}: ${fmtVal(d)}`;
  const xy = { x: "sample" as const, y: "displayValue" as const, r: 3 };
  const { warmup, baseline, measured, rejected } = partitionSamples(
    ctx.convertedData,
    showRejected,
    lttb,
  );
  return [
    Plot.dot(warmup, {
      ...xy,
      stroke: "#dc3545",
      fill: "none",
      strokeWidth: 1.5,
      opacity: 0.7,
      title: (d: SampleData) => `Warmup ${d.sample}: ${fmtVal(d)}`,
    }),
    Plot.dot(baseline, {
      ...xy,
      stroke: "#ffa500",
      fill: "none",
      strokeWidth: 2,
      opacity: 0.8,
      title: tipTitle,
    }),
    Plot.dot(measured, {
      ...xy,
      opacity: 0.8,
      title: tipTitle,
      fill: (d: SampleData) =>
        (d.optTier && optTierColors[d.optTier]) || "#4682b4",
    }),
    ...rejectedDotMark(rejected, xy, tipTitle),
  ];
}

/** Legend items for opt tiers (when present) or benchmark names */
function seriesLegendItems(
  optTiers: string[],
  benchmarks: string[],
  baselineNames: Set<string>,
): LegendItem[] {
  if (optTiers.length > 0)
    return optTiers.map(tier => ({
      color: optTierColors[tier] || "#4682b4",
      label: tier,
      style: "filled-dot" as const,
    }));
  // sort baselines last so current benchmarks appear first in legend
  const sorted = [...benchmarks].sort(
    (a, b) => Number(baselineNames.has(a)) - Number(baselineNames.has(b)),
  );
  return sorted.map(bm => {
    const isBase = baselineNames.has(bm);
    return {
      color: isBase ? "#ffa500" : "#4682b4",
      label: bm,
      style: (isBase ? "hollow-dot" : "filled-dot") as LegendItem["style"],
    };
  });
}

/** Split samples into warmup/baseline/measured/rejected and downsample each */
function partitionSamples(
  data: SampleData[],
  showRejected: boolean,
  lttb: Downsample,
) {
  const downsample = (arr: SampleData[]) =>
    lttb(
      arr,
      maxDots,
      d => d.sample,
      d => d.displayValue,
    );
  const active = data.filter(d => !d.isWarmup && !d.isRejected);
  const warmup = downsample(data.filter(d => d.isWarmup));
  const baseline = downsample(active.filter(d => d.isBaseline));
  const measured = downsample(active.filter(d => !d.isBaseline));
  const rejected = showRejected
    ? data.filter(d => d.isRejected && !d.isWarmup)
    : [];
  return { warmup, baseline, measured, rejected };
}

/** Semi-transparent hollow dots for Tukey-rejected outlier samples */
function rejectedDotMark(
  rejected: SampleData[],
  xy: { x: "sample"; y: "displayValue"; r: number },
  tipTitle: (d: SampleData) => string,
): any[] {
  if (!rejected.length) return [];
  return [
    Plot.dot(rejected, {
      ...xy,
      stroke: "#999",
      fill: "none",
      strokeWidth: 1,
      opacity: 0.3,
      title: (d: SampleData) => `Rejected ${tipTitle(d)}`,
    }),
  ];
}
