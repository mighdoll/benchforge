import * as Plot from "@observablehq/plot";
import * as d3 from "d3";
import { optStatusNames } from "../../runners/MeasuredResults.ts";
import { buildLegend, type LegendItem } from "./LegendUtils.ts";
import {
  type FlatGcEvent,
  type FlatPausePoint,
  getTimeUnit,
  type HeapPoint,
  plotLayout,
  type TimeSeriesPoint,
} from "./PlotTypes.ts";

interface SampleData {
  benchmark: string;
  sample: number;
  value: number;
  displayValue: number;
  isBaseline: boolean;
  isWarmup: boolean;
  isRejected: boolean;
  optTier: string | null;
}

interface PlotContext {
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

const optTierColors: Record<string, string> = {
  turbofan: "#22c55e",
  optimized: "#22c55e",
  "turbofan+maglev": "#22c55e",
  maglev: "#eab308",
  sparkplug: "#f97316",
  interpreted: "#dc3545",
};

export interface SeriesVisibility {
  baseline: boolean;
  heap: boolean;
  baselineHeap: boolean;
  rejected: boolean;
}

/** Prepare heap, legend, and visibility state for the time series plot */
function prepareSeriesData(
  ctx: PlotContext,
  heapSeries: HeapPoint[],
  baselineHeapSeries: HeapPoint[],
  visibility: SeriesVisibility,
  gcEvents: FlatGcEvent[],
  pausePoints: FlatPausePoint[],
) {
  const visibleHeap = [
    ...(visibility.heap ? heapSeries : []),
    ...(visibility.baselineHeap ? baselineHeapSeries : []),
  ];
  const heapScale = computeHeapScale(visibleHeap, ctx.yMin, ctx.yMax);
  const heapData =
    heapScale && visibility.heap ? prepareHeapData(heapSeries, heapScale) : [];
  const baselineHeapData =
    heapScale && visibility.baselineHeap
      ? prepareHeapData(baselineHeapSeries, heapScale)
      : [];
  const showRejected = visibility.rejected && ctx.hasRejected;
  const legendItems = buildLegendItems(
    ctx.hasWarmup,
    gcEvents.length,
    pausePoints.length,
    heapData.length > 0,
    baselineHeapData.length > 0,
    showRejected,
    ctx.optTiers,
    ctx.benchmarks,
    ctx.baselineNames,
  );
  return { heapScale, heapData, baselineHeapData, showRejected, legendItems };
}

/** Create sample time series showing each sample in order */
export function createSampleTimeSeries(
  timeSeries: TimeSeriesPoint[],
  gcEvents: FlatGcEvent[] = [],
  pausePoints: FlatPausePoint[] = [],
  heapSeries: HeapPoint[] = [],
  baselineHeapSeries: HeapPoint[] = [],
  visibility: SeriesVisibility = {
    baseline: true,
    heap: true,
    baselineHeap: false,
    rejected: true,
  },
): SVGSVGElement | HTMLElement {
  const filtered = visibility.baseline
    ? timeSeries
    : timeSeries.filter(d => !d.isBaseline);
  const ctx = buildPlotContext(filtered);
  const series = prepareSeriesData(
    ctx,
    heapSeries,
    baselineHeapSeries,
    visibility,
    gcEvents,
    pausePoints,
  );

  return Plot.plot({
    ...plotLayout,
    x: {
      label: "Iteration",
      labelAnchor: "center",
      labelOffset: 45,
      grid: true,
      domain: [ctx.xMin, ctx.xMax],
    },
    y: {
      label: `Time (${ctx.unitSuffix})`,
      labelAnchor: "top",
      labelArrow: false,
      grid: true,
      domain: [ctx.yMin, ctx.yMax],
      tickFormat: ctx.formatValue,
    },
    color: { legend: false, scheme: "observable10" },
    marks: buildMarks(
      ctx,
      series.heapData,
      series.baselineHeapData,
      series.heapScale,
      gcEvents,
      pausePoints,
      series.legendItems,
      series.showRejected,
    ),
  });
}

/** Build scales, unit conversion, and converted data for the time series plot */
function buildPlotContext(timeSeries: TimeSeriesPoint[]): PlotContext {
  const benchmarks = [...new Set(timeSeries.map(d => d.benchmark))];
  const sampleData = buildSampleData(timeSeries);
  const { unitSuffix, convertValue, formatValue } = getTimeUnit(
    sampleData.map(d => d.value),
  );
  const convertedData = sampleData.map(d => ({
    ...d,
    displayValue: convertValue(d.value),
  }));
  const { yMin, yMax } = computeYRange(convertedData.map(d => d.displayValue));
  const xMin = d3.min(convertedData, d => d.sample)!;
  const xMax = d3.max(convertedData, d => d.sample)!;
  const hasWarmup = convertedData.some(d => d.isWarmup);
  const hasRejected = convertedData.some(d => d.isRejected);
  const baselineNames = new Set(
    convertedData.filter(d => d.isBaseline).map(d => d.benchmark),
  );
  const optTiers = [
    ...new Set(
      convertedData
        .filter(d => d.optTier && !d.isWarmup)
        .map(d => d.optTier as string),
    ),
  ];
  return {
    convertedData,
    xMin,
    xMax,
    yMin,
    yMax,
    unitSuffix,
    formatValue,
    convertValue,
    hasWarmup,
    hasRejected,
    baselineNames,
    optTiers,
    benchmarks,
  };
}

/** Heap scale info for mapping between bytes and plot Y coordinates */
interface HeapScale {
  heapMinBytes: number;
  heapRangeBytes: number;
  scale: number;
  yMin: number;
}

/** Compute shared heap scale from all heap data (main + baseline) */
function computeHeapScale(
  allHeap: HeapPoint[],
  yMin: number,
  yMax: number,
): HeapScale | undefined {
  if (allHeap.length === 0) return undefined;
  const heapMinBytes = d3.min(allHeap, d => d.value)!;
  const heapRangeBytes = d3.max(allHeap, d => d.value)! - heapMinBytes || 1;
  const scale = ((yMax - yMin) * 0.25) / heapRangeBytes;
  return { heapMinBytes, heapRangeBytes, scale, yMin };
}

/** Scale heap byte values into the plot's Y coordinate range */
function prepareHeapData(heapSeries: HeapPoint[], hs: HeapScale) {
  if (heapSeries.length === 0) return [];
  const mapped = heapSeries.map(d => ({
    sample: d.iteration,
    y: hs.yMin + (d.value - hs.heapMinBytes) * hs.scale,
  }));
  return lttb(
    mapped,
    500,
    d => d.sample,
    d => d.y,
  );
}

/** Assemble legend entries based on which data series are present */
function buildLegendItems(
  hasWarmup: boolean,
  gcCount: number,
  pauseCount: number,
  hasHeap: boolean,
  hasBaselineHeap: boolean,
  hasRejected: boolean,
  optTiers: string[],
  benchmarks: string[],
  baselineNames: Set<string>,
): LegendItem[] {
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
  items.push(
    ...optTiers.map(tier => ({
      color: optTierColors[tier] || "#4682b4",
      label: tier,
      style: "filled-dot" as const,
    })),
  );
  if (optTiers.length === 0) {
    const sorted = [...benchmarks].sort(
      (a, b) => Number(baselineNames.has(a)) - Number(baselineNames.has(b)),
    );
    items.push(
      ...sorted.map(bm => {
        const base = baselineNames.has(bm);
        return {
          color: base ? "#ffa500" : "#4682b4",
          label: bm,
          style: (base ? "hollow-dot" : "filled-dot") as LegendItem["style"],
        };
      }),
    );
  }
  if (hasRejected)
    items.push({ color: "#999", label: "rejected", style: "hollow-dot" });
  return items;
}

/** Build the marks array for the time series plot */
function buildMarks(
  ctx: PlotContext,
  heapData: ReturnType<typeof prepareHeapData>,
  baselineHeapData: ReturnType<typeof prepareHeapData>,
  heapScale: HeapScale | undefined,
  gcEvents: FlatGcEvent[],
  pausePoints: FlatPausePoint[],
  legendItems: LegendItem[],
  showRejected: boolean,
): Plot.Markish[] {
  const warmupRule = ctx.hasWarmup
    ? [
        Plot.ruleX([0], {
          stroke: "#999",
          strokeWidth: 1,
          strokeDasharray: "4,4",
        }),
      ]
    : [];
  const bounds = { xMin: ctx.xMin, xMax: ctx.xMax, yMax: ctx.yMax };
  return [
    ...heapMarks(baselineHeapData, ctx.yMin, "#fcd34d"),
    ...heapMarks(heapData, ctx.yMin, "#93c5fd"),
    ...heapAxisMarks(heapScale, ctx.xMax, ctx.xMin),
    ...warmupRule,
    gcMark(gcEvents, ctx.yMin, ctx.convertValue),
    ...pauseMarks(pausePoints, ctx.yMin, ctx.yMax),
    ...sampleDotMarks(ctx, showRejected),
    Plot.ruleY([ctx.yMin], { stroke: "black", strokeWidth: 1 }),
    ...buildLegend(bounds, legendItems),
  ];
}

/** Convert raw time series points to sample data with baseline/optimization metadata */
function buildSampleData(
  timeSeries: TimeSeriesPoint[],
): Omit<SampleData, "displayValue">[] {
  return timeSeries.map(d => ({
    benchmark: d.benchmark,
    sample: d.iteration,
    value: d.value,
    isBaseline: d.isBaseline || false,
    isWarmup: d.isWarmup || false,
    isRejected: d.isRejected || false,
    optTier:
      d.optStatus !== undefined
        ? optStatusNames[d.optStatus] || "unknown"
        : null,
  }));
}

/** Compute Y axis range with padding, snapping yMin to a round number */
function computeYRange(values: number[]) {
  const dataMin = d3.min(values)!;
  const dataMax = d3.max(values)!;
  const range = dataMax - dataMin;
  let yMin = dataMin - range * 0.15;
  const mag = 10 ** Math.floor(Math.log10(Math.abs(yMin)));
  yMin = Math.floor(yMin / mag) * mag;
  if (dataMin > 0 && yMin < 0) yMin = 0;
  return { yMin, yMax: dataMax + range * 0.05 };
}

/** Create area marks for the heap usage overlay */
function heapMarks(
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

/** Create right-side Y axis ticks and label for heap MB scale */
function heapAxisMarks(
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
  const mbLabel = [
    { x: labelX, y: hs.yMin + hs.heapRangeBytes * hs.scale * 0.5, text: "MB" },
  ];
  return [
    Plot.text(tickData, { ...textOpts, text: "label" }),
    Plot.text(mbLabel, { ...textOpts, text: "text" }),
  ];
}

/** Create vertical bar marks for GC events, height proportional to duration */
function gcMark(
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

/** Create dashed vertical rules marking pause points across the full Y range */
function pauseMarks(
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

const maxDots = 1000;

/** LTTB downsampling: select n points that best preserve visual shape */
function lttb<T>(
  data: T[],
  n: number,
  getX: (d: T) => number,
  getY: (d: T) => number,
): T[] {
  if (data.length <= n) return data;
  const bucketSize = (data.length - 2) / (n - 2);
  const result: T[] = [data[0]];
  for (let i = 0; i < n - 2; i++) {
    const bStart = Math.floor(i * bucketSize) + 1;
    const bEnd = Math.floor((i + 1) * bucketSize) + 1;
    const nStart = bEnd;
    const nEnd = Math.min(
      Math.floor((i + 2) * bucketSize) + 1,
      data.length - 1,
    );
    let avgX = 0;
    let avgY = 0;
    for (let j = nStart; j < nEnd; j++) {
      avgX += getX(data[j]);
      avgY += getY(data[j]);
    }
    const cnt = nEnd - nStart || 1;
    avgX /= cnt;
    avgY /= cnt;
    const prev = result[result.length - 1];
    const px = getX(prev);
    const py = getY(prev);
    let maxArea = -1;
    let maxIdx = bStart;
    for (let j = bStart; j < bEnd; j++) {
      const area = Math.abs(
        (px - avgX) * (getY(data[j]) - py) - (px - getX(data[j])) * (avgY - py),
      );
      if (area > maxArea) {
        maxArea = area;
        maxIdx = j;
      }
    }
    result.push(data[maxIdx]);
  }
  result.push(data[data.length - 1]);
  return result;
}

/** Downsample if array exceeds maxDots, preserving visual features */
function downsample(arr: SampleData[]): SampleData[] {
  return lttb(
    arr,
    maxDots,
    d => d.sample,
    d => d.displayValue,
  );
}

/** Split samples into warmup, baseline, measured, and rejected groups */
function partitionSamples(data: SampleData[], showRejected: boolean) {
  const warmup = downsample(data.filter(d => d.isWarmup));
  const baseline = downsample(
    data.filter(d => d.isBaseline && !d.isWarmup && !d.isRejected),
  );
  const measured = downsample(
    data.filter(d => !d.isBaseline && !d.isWarmup && !d.isRejected),
  );
  const rejected = showRejected
    ? data.filter(d => d.isRejected && !d.isWarmup)
    : [];
  return { warmup, baseline, measured, rejected };
}

/** Create dot marks for warmup, baseline, and measured samples with opt tier colors */
function sampleDotMarks(ctx: PlotContext, showRejected: boolean): any[] {
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
    ...(rejected.length
      ? [
          Plot.dot(rejected, {
            ...xy,
            stroke: "#999",
            fill: "none",
            strokeWidth: 1,
            opacity: 0.3,
            title: (d: SampleData) => `Rejected ${tipTitle(d)}`,
          }),
        ]
      : []),
  ];
}
