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
  type HeapPlotPoint,
  plotDomains,
  prepareHeapData,
} from "./TimeSeriesScaling.ts";
import {
  buildLegendItems,
  defaultSeriesColor,
  seriesColorMap,
} from "./TimeSeriesSeries.ts";

/** Controls which data series are visible in the time series plot.
 *  `hidden` holds benchmark names toggled off (the baseline is just one of
 *  them, so the baseline pill and the per-variant pills share one mechanism).
 *  `gcShown` holds benchmark names whose full-GC marks are on; empty by default
 *  so GC rules stay hidden until toggled, per series. */
export interface SeriesVisibility {
  hidden: Set<string>;
  heap: boolean;
  baselineHeap: boolean;
  rejected: boolean;
  gcShown: Set<string>;
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

  /** "All" view with a batch-fraction x axis: 1-based "Batch" labels at band
   *  centers, boundary gridlines on the integers, and no per-point tooltips
   *  (too distracting over thousands of interleaved dots). */
  batchMode: boolean;
}

interface SeriesDataParams {
  ctx: PlotContext;
  heapSeries: HeapPoint[];
  baselineHeapSeries: HeapPoint[];
  visibleHeap: HeapPoint[];

  /** fraction of the Y axis the heap overlay may fill */
  heapFill: number;

  visibility: SeriesVisibility;
  gcEvents: FlatGcEvent[];

  /** every series with full-GC events, shown or not, for stable legend labels */
  allGcSeries: string[];

  pausePoints: FlatPausePoint[];
}

const defaultVisibility: SeriesVisibility = {
  hidden: new Set(),
  heap: true,
  baselineHeap: false,
  rejected: true,
  gcShown: new Set(),
};

/** Time series plot with samples, GC events, and heap overlay */
export function createSampleTimeSeries(
  timeSeries: TimeSeriesPoint[],
  gcEvents: FlatGcEvent[] = [],
  pausePoints: FlatPausePoint[] = [],
  heapSeries: HeapPoint[] = [],
  baselineHeapSeries: HeapPoint[] = [],
  visibility: SeriesVisibility = defaultVisibility,
  batchMode = false,
): SVGSVGElement | HTMLElement {
  const shown = (b: string) => !visibility.hidden.has(b);
  const filtered = timeSeries.filter(d => shown(d.benchmark));
  // heap overlays follow the same per-series visibility as the dots: a hidden
  // variant contributes neither its heap area nor its heap-scale extremes.
  const shownHeap = heapSeries.filter(d => shown(d.benchmark));
  const shownBaselineHeap = baselineHeapSeries.filter(d => shown(d.benchmark));
  const visibleHeap = [
    ...(visibility.heap ? shownHeap : []),
    ...(visibility.baselineHeap ? shownBaselineHeap : []),
  ];
  // GC pills are the only gate for GC rules (like the heap pills for heap),
  // so full GCs stay viewable with their series' dots toggled off.
  const shownGc = gcEvents.filter(d => visibility.gcShown.has(d.benchmark));
  const allGcSeries = [...new Set(gcEvents.map(d => d.benchmark))];
  const overlayXs = [
    ...visibleHeap.map(d => d.iteration),
    ...shownGc.map(d => d.sampleIndex),
  ];
  const ctx = buildPlotContext(filtered, overlayXs, timeSeries);
  const pauses = pausePoints.filter(d => shown(d.benchmark));
  const hasSamples = filtered.length > 0;
  const heapFill = hasSamples ? 0.25 : 0.85;
  const series = prepareSeriesData({
    ctx,
    heapSeries: shownHeap,
    baselineHeapSeries: shownBaselineHeap,
    visibleHeap,
    heapFill,
    visibility,
    gcEvents: shownGc,
    allGcSeries,
    pausePoints: pauses,
  });

  return Plot.plot({
    ...plotLayout,
    x: xScale(ctx, batchMode),
    y: yScale(ctx, hasSamples),
    color: { legend: false, scheme: "observable10" },
    marks: buildMarks({
      ctx,
      ...series,
      gcEvents: shownGc,
      pausePoints: pauses,
      batchMode,
    }),
  });
}

/** Derive scales, units, and metadata from the visible time series data.
 *  Overlay positions (heap, GC) supply the x domain when no timing series is
 *  shown; `allSeries` (unfiltered) keeps colors stable across toggles. */
function buildPlotContext(
  timeSeries: TimeSeriesPoint[],
  overlayXs: number[],
  allSeries: TimeSeriesPoint[],
): PlotContext {
  const benchmarks = [...new Set(timeSeries.map(d => d.benchmark))];
  const allBenchmarks = [...new Set(allSeries.map(d => d.benchmark))];
  const sampleData = buildSampleData(timeSeries);
  const values = sampleData.map(d => d.value);
  const { unitSuffix, convertValue, formatValue } = getTimeUnit(values);
  const convertedData: SampleData[] = sampleData.map(d => ({
    ...d,
    displayValue: convertValue(d.value),
  }));
  const { xMin, xMax, yMin, yMax } = plotDomains(
    convertedData.map(d => d.sample),
    convertedData.map(d => d.displayValue),
    overlayXs,
  );
  const hasWarmup = convertedData.some(d => d.isWarmup);
  const hasRejected = convertedData.some(d => d.isRejected);
  const baselineNames = new Set(
    allSeries.filter(d => d.isBaseline).map(d => d.benchmark),
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
    allBenchmarks,
  };
}

/** Prepare heap, legend, and visibility state for the time series plot */
function prepareSeriesData(p: SeriesDataParams) {
  const { ctx, heapSeries, baselineHeapSeries, visibleHeap, heapFill } = p;
  const { visibility, gcEvents, allGcSeries, pausePoints } = p;
  const heapScale = computeHeapScale(visibleHeap, ctx.yMin, ctx.yMax, heapFill);
  const heapData =
    heapScale && visibility.heap ? prepareHeapData(heapSeries, heapScale) : [];
  const baselineHeapData =
    heapScale && visibility.baselineHeap
      ? prepareHeapData(baselineHeapSeries, heapScale)
      : [];
  const showRejected = visibility.rejected && ctx.hasRejected;
  const gcSeries = [...new Set(gcEvents.map(e => e.benchmark))];
  const legendItems = buildLegendItems({
    hasWarmup: ctx.hasWarmup,
    gcSeries,
    allGcSeries,
    pauseCount: pausePoints.length,
    hasHeap: heapData.length > 0,
    hasBaselineHeap: baselineHeapData.length > 0,
    hasRejected: showRejected,
    benchmarks: ctx.benchmarks,
    allBenchmarks: ctx.allBenchmarks,
    baselineNames: ctx.baselineNames,
  });
  return { heapScale, heapData, baselineHeapData, showRejected, legendItems };
}

/** X-axis scale: batch-fraction "Batch" axis in the "All" view, else the raw
 *  per-iteration axis. In batch mode, labels sit at batch centers (k - 0.5) and
 *  read as 1-based batch numbers; the scale-level grid is off so boundary
 *  gridlines can be drawn explicitly on the integers (see `batchBoundaryGrid`). */
function xScale(ctx: PlotContext, batchMode: boolean) {
  const base = {
    labelAnchor: "center" as const,
    labelOffset: 45,
    grid: true,
    domain: [ctx.xMin, ctx.xMax],
  };
  if (batchMode) {
    const last = Math.ceil(ctx.xMax);
    const centers = d3
      .ticks(1, last, 10)
      .filter(k => Number.isInteger(k))
      .map(k => k - 0.5);
    const tickFormat = (t: number) => `${Math.round(t + 0.5)}`;
    return { ...base, label: "Batch", grid: false, ticks: centers, tickFormat };
  }
  return { ...base, label: "Iteration" };
}

/** Y-axis scale for time samples; empty axis (no label, grid, or ticks) when
 *  no timing series is visible, leaving the heap MB axis as the only scale. */
function yScale(ctx: PlotContext, hasSamples: boolean) {
  const base = { domain: [ctx.yMin, ctx.yMax], tickFormat: ctx.formatValue };
  if (!hasSamples) return { ...base, label: null, grid: false, ticks: [] };
  return {
    ...base,
    label: `Time (${ctx.unitSuffix})`,
    labelAnchor: "top" as const,
    labelArrow: false,
    grid: true,
  };
}

/** Assemble all Observable Plot marks for the time series chart */
function buildMarks(p: MarkParams): Plot.Markish[] {
  const { ctx, heapData, baselineHeapData, heapScale, batchMode } = p;
  const { gcEvents, pausePoints, legendItems, showRejected } = p;
  const colors = seriesColorMap(ctx.allBenchmarks, ctx.baselineNames);
  const gcColor = (b: string) => colors.get(b) ?? defaultSeriesColor;
  const dashStyle = { stroke: "#999", strokeWidth: 1, strokeDasharray: "4,4" };
  const warmupRule = ctx.hasWarmup ? [Plot.ruleX([0], dashStyle)] : [];
  const { xMin, xMax, yMin, yMax } = ctx;
  return [
    ...heapMarks(baselineHeapData, yMin, "#fcd34d"),
    ...heapMarks(heapData, yMin, "#93c5fd"),
    ...heapAxisMarks(heapScale, xMax, xMin),
    ...batchBoundaryGrid(xMax, batchMode),
    ...warmupRule,
    ...gcMark(gcEvents, yMin, yMax, gcColor, batchMode),
    ...pauseMarks(pausePoints, yMin, yMax, batchMode),
    ...sampleDotMarks(ctx, showRejected, lttb, batchMode),
    Plot.ruleY([yMin], { stroke: "black", strokeWidth: 1 }),
    ...buildLegend({ xMin, xMax, yMin, yMax }, legendItems),
  ];
}

/** Batch-boundary gridlines on the integer batch delimiters (0..last). The
 *  batch-mode scale grid is disabled (its ticks sit mid-band at centers), so
 *  this restores the delimiters where the automatic grid used to draw them. */
function batchBoundaryGrid(xMax: number, batchMode: boolean): Plot.Markish[] {
  if (!batchMode) return [];
  const last = Math.ceil(xMax);
  const boundaries = d3.range(0, last + 1);
  return [Plot.gridX(boundaries)];
}
