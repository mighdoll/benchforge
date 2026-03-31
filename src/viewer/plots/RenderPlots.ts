import type { BenchmarkEntry, ReportData } from "../ReportData.ts";
import { createCIPlot } from "./CIPlot.ts";
import { createHistogramKde } from "./HistogramKde.ts";
import {
  type FlatGcEvent,
  type FlatPausePoint,
  formatPct,
  type HeapPoint,
  type Sample,
  type TimeSeriesPoint,
} from "./PlotTypes.ts";
import { createSampleTimeSeries } from "./SampleTimeSeries.ts";

interface PreparedBenchmark extends BenchmarkEntry {
  isBaseline: boolean;
}

interface FlattenedData {
  allSamples: Sample[];
  timeSeries: TimeSeriesPoint[];
  heapSeries: HeapPoint[];
  allGcEvents: FlatGcEvent[];
  allPausePoints: FlatPausePoint[];
}

/** Render stats and CI plots for the summary tab */
export function renderSummaryStats(data: ReportData): void {
  const gcEnabled = data.metadata.gcTrackingEnabled ?? false;
  data.groups.forEach((group, groupIndex) => {
    try {
      renderGroupStats(group, groupIndex, gcEnabled);
    } catch (error) {
      console.error("Error rendering stats for group", groupIndex, error);
    }
  });
}

/** Render time series and histogram plots for the samples tab */
export function renderSamplePlots(data: ReportData): void {
  data.groups.forEach((group, groupIndex) => {
    try {
      renderGroupPlots(group, groupIndex);
    } catch (error) {
      console.error("Error rendering plots for group", groupIndex, error);
    }
  });
}

/** Render CI plot and stats cards for a single benchmark group */
function renderGroupStats(
  group: ReportData["groups"][0],
  groupIndex: number,
  gcEnabled: boolean,
): void {
  const benchmarks = prepareBenchmarks(group);
  if (benchmarks.length === 0) return;

  const currentBenchmark = benchmarks.find(b => !b.isBaseline);
  if (currentBenchmark?.comparisonCI?.histogram) {
    renderToContainer(`#ci-plot-${groupIndex}`, true, () =>
      createCIPlot(currentBenchmark.comparisonCI!),
    );
  }

  const statsContainer = document.querySelector(`#stats-${groupIndex}`);
  if (statsContainer)
    statsContainer.innerHTML = benchmarks
      .map(b => generateStatsHtml(b, gcEnabled))
      .join("");
}

/** Render histogram and time series plots for a single benchmark group */
function renderGroupPlots(
  group: ReportData["groups"][0],
  groupIndex: number,
): void {
  const benchmarks = prepareBenchmarks(group);
  if (benchmarks.length === 0 || !benchmarks[0].samples?.length) return;

  const f = flattenSamples(benchmarks);
  const names = benchmarks.map(b => b.name);

  renderToContainer(`#histogram-${groupIndex}`, f.allSamples.length > 0, () =>
    createHistogramKde(f.allSamples, names),
  );
  const tsId = `#sample-timeseries-${groupIndex}`;
  renderToContainer(tsId, f.timeSeries.length > 0, () =>
    createSampleTimeSeries(
      f.timeSeries,
      f.allGcEvents,
      f.allPausePoints,
      f.heapSeries,
    ),
  );
}

/** Combine baseline and benchmarks into a single list with display names */
function prepareBenchmarks(
  group: ReportData["groups"][0],
): PreparedBenchmark[] {
  const base = group.baseline;
  const baseline: PreparedBenchmark[] = base
    ? [{ ...base, name: base.name + " (baseline)", isBaseline: true }]
    : [];
  const current = group.benchmarks.map(b => ({
    ...b,
    isBaseline: false,
  }));
  return [...baseline, ...current];
}

/** Clear a container element and append a freshly created plot */
function renderToContainer(
  selector: string,
  condition: boolean,
  create: () => SVGSVGElement | HTMLElement,
): void {
  const container = document.querySelector(selector);
  if (!container || !condition) return;
  container.innerHTML = "";
  container.appendChild(create());
}

function generateStatsHtml(b: PreparedBenchmark, gcEnabled: boolean): string {
  const ciHtml = generateCIHtml(b.comparisonCI);
  const statsHtml = b.sectionStats?.length
    ? sectionStatsHtml(b.sectionStats, gcEnabled)
    : fallbackStatsHtml(b.stats);

  return `
    <div class="summary-stats">
      <h3 style="margin-bottom: 10px; color: #333;">${b.name}</h3>
      <div class="stats-grid">${ciHtml}${statsHtml}</div>
    </div>
  `;
}

function flattenSamples(benchmarks: PreparedBenchmark[]): FlattenedData {
  const out: FlattenedData = {
    allSamples: [],
    timeSeries: [],
    heapSeries: [],
    allGcEvents: [],
    allPausePoints: [],
  };
  for (const b of benchmarks) {
    if (b.samples?.length) flattenBenchmark(b, out);
  }
  return out;
}

function generateCIHtml(ci: BenchmarkEntry["comparisonCI"]): string {
  if (!ci) return "";
  const pct = `${formatPct(ci.percent)} [${formatPct(ci.ci[0])}, ${formatPct(ci.ci[1])}]`;
  return `
    <div class="stat-item">
      <div class="stat-label">vs Baseline</div>
      <div class="stat-value ci-${ci.direction}">${pct}</div>
    </div>
  `;
}

function sectionStatsHtml(
  sectionStats: NonNullable<PreparedBenchmark["sectionStats"]>,
  gcEnabled: boolean,
): string {
  const stats = gcEnabled
    ? sectionStats
    : sectionStats.filter(s => s.groupTitle !== "gc");
  return stats
    .map(
      stat => `
      <div class="stat-item">
        <div class="stat-label">${stat.groupTitle ? stat.groupTitle + " " : ""}${stat.label}</div>
        <div class="stat-value">${stat.value}</div>
      </div>`,
    )
    .join("");
}

function fallbackStatsHtml(stats: PreparedBenchmark["stats"]): string {
  const items: [string, number][] = [
    ["Min", stats.min],
    ["Median", stats.p50],
    ["Mean", stats.avg],
    ["Max", stats.max],
    ["P75", stats.p75],
    ["P99", stats.p99],
  ];
  return items
    .map(
      ([label, value]) => `
      <div class="stat-item">
        <div class="stat-label">${label}</div>
        <div class="stat-value">${value.toFixed(3)}ms</div>
      </div>`,
    )
    .join("");
}

/** Extract time series, heap, GC, and pause data from one benchmark */
function flattenBenchmark(b: PreparedBenchmark, out: FlattenedData): void {
  const name = b.name;
  const warmupCount = b.warmupSamples?.length || 0;
  b.warmupSamples?.forEach((value, i) => {
    const iteration = i - warmupCount;
    out.timeSeries.push({ benchmark: name, iteration, value, isWarmup: true });
  });

  const endTimes = cumulativeSum(b.samples);
  b.samples.forEach((value, i) => {
    out.allSamples.push({ benchmark: name, value, iteration: i });
    out.timeSeries.push({
      benchmark: name,
      iteration: i,
      value,
      isWarmup: false,
      optStatus: b.optSamples?.[i],
    });
    if (b.heapSamples?.[i] !== undefined) {
      out.heapSeries.push({
        benchmark: name,
        iteration: i,
        value: b.heapSamples[i],
      });
    }
  });

  b.gcEvents?.forEach(gc => {
    const idx = endTimes.findIndex(t => t >= gc.offset);
    const sampleIndex = idx >= 0 ? idx : b.samples.length - 1;
    out.allGcEvents.push({
      benchmark: name,
      sampleIndex,
      duration: gc.duration,
    });
  });
  if (b.pausePoints) {
    out.allPausePoints.push(
      ...b.pausePoints.map(p => ({
        benchmark: name,
        sampleIndex: p.sampleIndex,
        durationMs: p.durationMs,
      })),
    );
  }
}

/** Running total array, used to map GC event offsets to sample indices */
function cumulativeSum(arr: number[]): number[] {
  const result: number[] = [];
  let sum = 0;
  for (const v of arr) {
    sum += v;
    result.push(sum);
  }
  return result;
}
