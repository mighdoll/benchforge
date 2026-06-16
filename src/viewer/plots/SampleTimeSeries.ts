import * as Plot from "@observablehq/plot";
import * as d3 from "d3";
import { lttb } from "./Downsampling.ts";
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
  gcMark,
  type HeapScale,
  heapAxisMarks,
  heapMarks,
  type PlotContext,
  pauseMarks,
  type SampleData,
} from "./TimeSeriesMarks.ts";
import { sampleDotMarks } from "./TimeSeriesSamples.ts";
import {
  buildSampleData,
  computeHeapScale,
  computeYRange,
  type HeapPlotPoint,
  prepareHeapData,
} from "./TimeSeriesScaling.ts";
import { buildLegendItems } from "./TimeSeriesSeries.ts";

/** Controls which data series are visible in the time series plot.
 *  `hidden` holds benchmark names toggled off (the baseline is just one of
 *  them, so the baseline pill and the per-variant pills share one mechanism). */
export interface SeriesVisibility {
  hidden: Set<string>;
  heap: boolean;
  baselineHeap: boolean;
  rejected: boolean;
  fullGc: boolean;
}

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
  hidden: new Set(),
  heap: true,
  baselineHeap: false,
  rejected: true,
  fullGc: false,
};

/** Time series plot with samples, GC events, and heap overlay */
export function createSampleTimeSeries(
  timeSeries: TimeSeriesPoint[],
  gcEvents: FlatGcEvent[] = [],
  pausePoints: FlatPausePoint[] = [],
  heapSeries: HeapPoint[] = [],
  baselineHeapSeries: HeapPoint[] = [],
  visibility: SeriesVisibility = defaultVisibility,
): SVGSVGElement | HTMLElement {
  const shown = (b: string) => !visibility.hidden.has(b);
  const filtered = timeSeries.filter(d => shown(d.benchmark));
  const ctx = buildPlotContext(filtered);
  const gc = visibility.fullGc ? gcEvents : [];
  const series = prepareSeriesData(
    ctx,
    heapSeries.filter(d => shown(d.benchmark)),
    baselineHeapSeries.filter(d => shown(d.benchmark)),
    visibility,
    gc,
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
    marks: buildMarks({ ctx, ...series, gcEvents: gc, pausePoints }),
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
    ...gcMark(gcEvents, yMin, yMax),
    ...pauseMarks(pausePoints, yMin, yMax),
    ...sampleDotMarks(ctx, showRejected, lttb),
    Plot.ruleY([yMin], { stroke: "black", strokeWidth: 1 }),
    ...buildLegend({ xMin, xMax, yMin, yMax }, legendItems),
  ];
}
