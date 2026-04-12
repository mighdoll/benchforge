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
import {
  buildLegendItems,
  gcMark,
  type HeapScale,
  heapAxisMarks,
  heapMarks,
  type PlotContext,
  pauseMarks,
  type SampleData,
  sampleDotMarks,
} from "./TimeSeriesMarks.ts";

/** Controls which data series are visible in the time series plot */
export interface SeriesVisibility {
  baseline: boolean;
  heap: boolean;
  baselineHeap: boolean;
  rejected: boolean;
}

type HeapPlotPoint = { sample: number; y: number };

interface MarkParams {
  ctx: PlotContext;
  heapData: HeapPlotPoint[];
  baselineHeapData: HeapPlotPoint[];
  heapScale: HeapScale | undefined;
  gcEvents: FlatGcEvent[];
  pausePoints: FlatPausePoint[];
  legendItems: LegendItem[];
  showRejected: boolean;
}

const defaultVisibility: SeriesVisibility = {
  baseline: true,
  heap: true,
  baselineHeap: false,
  rejected: true,
};

/** Time series plot with samples, GC events, heap overlay, and opt tiers */
export function createSampleTimeSeries(
  timeSeries: TimeSeriesPoint[],
  gcEvents: FlatGcEvent[] = [],
  pausePoints: FlatPausePoint[] = [],
  heapSeries: HeapPoint[] = [],
  baselineHeapSeries: HeapPoint[] = [],
  visibility: SeriesVisibility = defaultVisibility,
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
    marks: buildMarks({ ctx, ...series, gcEvents, pausePoints }),
  });
}

/** Derive scales, units, and metadata from time series data */
function buildPlotContext(timeSeries: TimeSeriesPoint[]): PlotContext {
  const benchmarks = [...new Set(timeSeries.map(d => d.benchmark))];
  const sampleData = buildSampleData(timeSeries);
  const values = sampleData.map(d => d.value);
  const { unitSuffix, convertValue, formatValue } = getTimeUnit(values);
  const convertedData: SampleData[] = sampleData.map(d => ({
    ...d,
    displayValue: convertValue(d.value),
  }));
  const { yMin, yMax } = computeYRange(convertedData.map(d => d.displayValue));
  let xMin = d3.min(convertedData, d => d.sample)!;
  let xMax = d3.max(convertedData, d => d.sample)!;
  if (xMin === xMax) {
    xMin -= 0.5;
    xMax += 0.5;
  }
  const hasWarmup = convertedData.some(d => d.isWarmup);
  const hasRejected = convertedData.some(d => d.isRejected);
  const baselineNames = new Set(
    convertedData.filter(d => d.isBaseline).map(d => d.benchmark),
  );
  const optTiers = [
    ...new Set(
      convertedData.filter(d => d.optTier && !d.isWarmup).map(d => d.optTier!),
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
  const legendItems = buildLegendItems({
    hasWarmup: ctx.hasWarmup,
    gcCount: gcEvents.length,
    pauseCount: pausePoints.length,
    hasHeap: heapData.length > 0,
    hasBaselineHeap: baselineHeapData.length > 0,
    hasRejected: showRejected,
    optTiers: ctx.optTiers,
    benchmarks: ctx.benchmarks,
    baselineNames: ctx.baselineNames,
  });
  return { heapScale, heapData, baselineHeapData, showRejected, legendItems };
}

/** Assemble all Observable Plot marks for the time series chart */
function buildMarks(p: MarkParams): Plot.Markish[] {
  const { ctx, heapData, baselineHeapData, heapScale } = p;
  const { gcEvents, pausePoints, legendItems, showRejected } = p;
  const dashStyle = { stroke: "#999", strokeWidth: 1, strokeDasharray: "4,4" };
  const warmupRule = ctx.hasWarmup ? [Plot.ruleX([0], dashStyle)] : [];
  const { xMin, xMax, yMin, yMax } = ctx;
  return [
    ...heapMarks(baselineHeapData, yMin, "#fcd34d"),
    ...heapMarks(heapData, yMin, "#93c5fd"),
    ...heapAxisMarks(heapScale, xMax, xMin),
    ...warmupRule,
    gcMark(gcEvents, yMin, ctx.convertValue),
    ...pauseMarks(pausePoints, yMin, yMax),
    ...sampleDotMarks(ctx, showRejected, lttb),
    Plot.ruleY([yMin], { stroke: "black", strokeWidth: 1 }),
    ...buildLegend({ xMin, xMax, yMin, yMax }, legendItems),
  ];
}

/** Convert TimeSeriesPoint data to SampleData with opt tier names */
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

/** Pad Y range and snap yMin to a round number for clean axis ticks */
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

/** Compute scale to map heap byte values into the bottom 25% of the Y axis */
function computeHeapScale(
  allHeap: HeapPoint[],
  yMin: number,
  yMax: number,
): HeapScale | undefined {
  if (allHeap.length === 0) return undefined;
  const heapMinBytes = d3.min(allHeap, d => d.value)!;
  const heapRangeBytes = d3.max(allHeap, d => d.value)! - heapMinBytes || 1;
  return {
    heapMinBytes,
    heapRangeBytes,
    scale: ((yMax - yMin) * 0.25) / heapRangeBytes,
    yMin,
  };
}

/** Map heap byte values to the time-series Y scale and downsample via LTTB */
function prepareHeapData(
  heapSeries: HeapPoint[],
  hs: HeapScale,
): HeapPlotPoint[] {
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
