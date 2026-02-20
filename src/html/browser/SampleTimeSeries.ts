import * as Plot from "@observablehq/plot";
import * as d3 from "d3";
import { buildLegend, type LegendItem } from "./LegendUtils.ts";
import type {
  GcEvent,
  HeapPoint,
  PausePoint,
  TimeSeriesPoint,
} from "./Types.ts";

const OPT_STATUS_NAMES: Record<number, string> = {
  1: "interpreted",
  129: "sparkplug",
  17: "turbofan",
  33: "maglev",
  49: "turbofan+maglev",
  32769: "optimized",
};
const OPT_TIER_COLORS: Record<string, string> = {
  turbofan: "#22c55e",
  optimized: "#22c55e",
  "turbofan+maglev": "#22c55e",
  maglev: "#eab308",
  sparkplug: "#f97316",
  interpreted: "#dc3545",
};

interface SampleData {
  benchmark: string;
  sample: number;
  value: number;
  displayValue: number;
  isBaseline: boolean;
  isWarmup: boolean;
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
  optTiers: string[];
  benchmarks: string[];
}

/** Create sample time series showing each sample in order */
export function createSampleTimeSeries(
  timeSeries: TimeSeriesPoint[],
  gcEvents: GcEvent[] = [],
  pausePoints: PausePoint[] = [],
  heapSeries: HeapPoint[] = [],
): SVGSVGElement | HTMLElement {
  const ctx = buildPlotContext(timeSeries);
  const heapData = prepareHeapData(heapSeries, ctx.yMin, ctx.yMax);

  return Plot.plot({
    marginTop: 24,
    marginLeft: 70,
    marginBottom: 60,
    marginRight: 110,
    width: 550,
    height: 300,
    style: { fontSize: "14px" },
    x: {
      label: "Sample",
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
    marks: [
      ...heapMarks(heapData, ctx.yMin),
      ...(ctx.hasWarmup
        ? [
            Plot.ruleX([0], {
              stroke: "#999",
              strokeWidth: 1,
              strokeDasharray: "4,4",
            }),
          ]
        : []),
      gcMark(gcEvents, ctx.yMin, ctx.convertValue),
      ...pauseMarks(pausePoints, ctx.yMin, ctx.yMax),
      ...sampleDotMarks(ctx),
      Plot.ruleY([ctx.yMin], { stroke: "black", strokeWidth: 1 }),
      ...buildLegend(
        { xMin: ctx.xMin, xMax: ctx.xMax, yMax: ctx.yMax },
        buildLegendItems(
          ctx.hasWarmup,
          gcEvents.length,
          pausePoints.length,
          heapData.length > 0,
          ctx.optTiers,
          ctx.benchmarks,
        ),
      ),
    ],
  });
}

function buildPlotContext(timeSeries: TimeSeriesPoint[]): PlotContext {
  const benchmarks = [...new Set(timeSeries.map(d => d.benchmark))];
  const sampleData = buildSampleData(timeSeries, benchmarks);
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
  const tierSet = new Set(
    convertedData.filter(d => d.optTier && !d.isWarmup).map(d => d.optTier),
  );
  const optTiers = [...tierSet].filter((t): t is string => t !== null);
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
    optTiers,
    benchmarks,
  };
}

function buildSampleData(
  timeSeries: TimeSeriesPoint[],
  benchmarks: string[],
): Omit<SampleData, "displayValue">[] {
  const result: Omit<SampleData, "displayValue">[] = [];
  for (const benchmark of benchmarks) {
    const isBaseline = benchmark.includes("(baseline)");
    for (const d of timeSeries.filter(t => t.benchmark === benchmark)) {
      const optTier =
        d.optStatus !== undefined
          ? OPT_STATUS_NAMES[d.optStatus] || "unknown"
          : null;
      result.push({
        benchmark,
        sample: d.iteration,
        value: d.value,
        isBaseline,
        isWarmup: d.isWarmup || false,
        optTier,
      });
    }
  }
  return result;
}

/** Pick display unit (ns/us/ms) based on average value magnitude */
function getTimeUnit(values: number[]) {
  const avg = d3.mean(values)!;
  const fmt0 = (d: number) => d3.format(",.0f")(d);
  const fmt1 = (d: number) => d3.format(",.1f")(d);
  if (avg < 0.001)
    return {
      unitSuffix: "ns",
      convertValue: (ms: number) => ms * 1e6,
      formatValue: fmt0,
    };
  if (avg < 1)
    return {
      unitSuffix: "μs",
      convertValue: (ms: number) => ms * 1e3,
      formatValue: fmt1,
    };
  return {
    unitSuffix: "ms",
    convertValue: (ms: number) => ms,
    formatValue: fmt1,
  };
}

/** Compute Y axis range with padding, snapping yMin to a round number */
function computeYRange(values: number[]) {
  const dataMin = d3.min(values)!;
  const dataMax = d3.max(values)!;
  const dataRange = dataMax - dataMin;
  const padding = dataRange * 0.15;
  let yMin = dataMin - padding;
  const magnitude = 10 ** Math.floor(Math.log10(Math.abs(yMin)));
  yMin = Math.floor(yMin / magnitude) * magnitude;
  if (dataMin > 0 && yMin < 0) yMin = 0;
  return { yMin, yMax: dataMax + dataRange * 0.05 };
}

/** Scale heap byte values into the plot's Y coordinate range */
function prepareHeapData(heapSeries: HeapPoint[], yMin: number, yMax: number) {
  if (heapSeries.length === 0) return [];
  const heapMin = d3.min(heapSeries, d => d.value)!;
  const heapRange = d3.max(heapSeries, d => d.value)! - heapMin || 1;
  const scale = ((yMax - yMin) * 0.25) / heapRange;
  return heapSeries.map(d => ({
    sample: d.iteration,
    y: yMin + (d.value - heapMin) * scale,
    heapMB: d.value / 1024 / 1024,
  }));
}

function heapMarks(
  heapData: { sample: number; y: number; heapMB: number }[],
  yMin: number,
): any[] {
  if (heapData.length === 0) return [];
  return [
    Plot.areaY(heapData, {
      x: "sample",
      y: "y",
      y1: yMin,
      fill: "#9333ea",
      fillOpacity: 0.15,
      stroke: "#9333ea",
      strokeWidth: 1,
      strokeOpacity: 0.4,
    }),
    Plot.tip(
      heapData,
      Plot.pointerX({
        x: "sample",
        y: "y",
        title: (d: { heapMB: number }) => `Heap: ${d.heapMB.toFixed(1)} MB`,
      }),
    ),
  ];
}

function gcMark(
  gcEvents: GcEvent[],
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

function pauseMarks(
  pausePoints: PausePoint[],
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

function sampleDotMarks(ctx: PlotContext): any[] {
  const { convertedData, unitSuffix, formatValue } = ctx;
  const tipTitle = (d: SampleData) =>
    d.optTier
      ? `Sample ${d.sample}: ${formatValue(d.displayValue)}${unitSuffix} [${d.optTier}]`
      : `Sample ${d.sample}: ${formatValue(d.displayValue)}${unitSuffix}`;
  return [
    Plot.dot(
      convertedData.filter(d => d.isWarmup),
      {
        x: "sample",
        y: "displayValue",
        stroke: "#dc3545",
        fill: "none",
        strokeWidth: 1.5,
        r: 3,
        opacity: 0.7,
        title: (d: SampleData) =>
          `Warmup ${d.sample}: ${formatValue(d.displayValue)}${unitSuffix}`,
      },
    ),
    Plot.dot(
      convertedData.filter(d => d.isBaseline && !d.isWarmup),
      {
        x: "sample",
        y: "displayValue",
        stroke: "#ffa500",
        fill: "none",
        strokeWidth: 2,
        r: 3,
        opacity: 0.8,
        title: tipTitle,
      },
    ),
    Plot.dot(
      convertedData.filter(d => !d.isBaseline && !d.isWarmup),
      {
        x: "sample",
        y: "displayValue",
        fill: (d: SampleData) =>
          d.optTier ? OPT_TIER_COLORS[d.optTier] || "#4682b4" : "#4682b4",
        r: 3,
        opacity: 0.8,
        title: tipTitle,
      },
    ),
  ];
}

function buildLegendItems(
  hasWarmup: boolean,
  gcCount: number,
  pauseCount: number,
  hasHeap: boolean,
  optTiers: string[],
  benchmarks: string[],
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
  if (hasHeap) items.push({ color: "#9333ea", label: "heap", style: "rect" });
  for (const tier of optTiers)
    items.push({
      color: OPT_TIER_COLORS[tier] || "#4682b4",
      label: tier,
      style: "filled-dot",
    });
  if (optTiers.length === 0) {
    const sorted = [...benchmarks].sort((a, b) => {
      const aBase = a.includes("(baseline)");
      const bBase = b.includes("(baseline)");
      return aBase === bBase ? 0 : aBase ? 1 : -1;
    });
    for (const bm of sorted) {
      const isBase = bm.includes("(baseline)");
      items.push({
        color: isBase ? "#ffa500" : "#4682b4",
        label: bm,
        style: isBase ? "hollow-dot" : "filled-dot",
      });
    }
  }
  return items;
}
