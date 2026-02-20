import { createCIPlot } from "./CIPlot.ts";
import { createHistogramKde } from "./HistogramKde.ts";
import { createSampleTimeSeries } from "./SampleTimeSeries.ts";
import type {
  BenchmarkEntry,
  GcEvent,
  HeapPoint,
  PausePoint,
  ReportData,
  Sample,
  TimeSeriesPoint,
} from "./Types.ts";

/** Render all plots for the benchmark report */
export function renderPlots(data: ReportData): void {
  const gcEnabled = data.metadata.gcTrackingEnabled ?? false;
  data.groups.forEach((group, groupIndex) => {
    try {
      renderGroup(group, groupIndex, gcEnabled);
    } catch (error) {
      console.error("Error rendering plots for group", groupIndex, error);
      showError(
        groupIndex,
        `Error rendering visualizations: ${(error as Error).message}`,
      );
    }
  });
}

function renderGroup(
  group: ReportData["groups"][0],
  groupIndex: number,
  gcEnabled: boolean,
): void {
  const benchmarks = prepareBenchmarks(group);
  if (benchmarks.length === 0 || !benchmarks[0].samples?.length) {
    showError(groupIndex, "No sample data available for visualization");
    return;
  }
  const flattened = flattenSamples(benchmarks);
  const benchmarkNames = benchmarks.map(b => b.name);

  const currentBenchmark = benchmarks.find(b => !b.isBaseline);
  if (currentBenchmark?.comparisonCI?.histogram) {
    renderToContainer(`#ci-plot-${groupIndex}`, true, () =>
      createCIPlot(currentBenchmark.comparisonCI!),
    );
  }

  renderToContainer(
    `#histogram-${groupIndex}`,
    flattened.allSamples.length > 0,
    () => createHistogramKde(flattened.allSamples, benchmarkNames),
  );
  const { timeSeries, allGcEvents, allPausePoints, heapSeries } = flattened;
  renderToContainer(
    `#sample-timeseries-${groupIndex}`,
    timeSeries.length > 0,
    () =>
      createSampleTimeSeries(
        timeSeries,
        allGcEvents,
        allPausePoints,
        heapSeries,
      ),
  );

  const statsContainer = document.querySelector(`#stats-${groupIndex}`);
  if (statsContainer)
    statsContainer.innerHTML = benchmarks
      .map(b => generateStatsHtml(b, gcEnabled))
      .join("");
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

interface PreparedBenchmark extends BenchmarkEntry {
  name: string;
}

/** Combine baseline and benchmarks into a single list with display names */
function prepareBenchmarks(
  group: ReportData["groups"][0],
): PreparedBenchmark[] {
  const benchmarks: PreparedBenchmark[] = [];
  if (group.baseline) {
    const name = group.baseline.name + " (baseline)";
    benchmarks.push({ ...group.baseline, name, isBaseline: true });
  }
  for (const b of group.benchmarks)
    benchmarks.push({ ...b, isBaseline: false });
  return benchmarks;
}

interface FlattenedData {
  allSamples: Sample[];
  timeSeries: TimeSeriesPoint[];
  heapSeries: HeapPoint[];
  allGcEvents: GcEvent[];
  allPausePoints: PausePoint[];
}

function flattenSamples(benchmarks: PreparedBenchmark[]): FlattenedData {
  const result: FlattenedData = {
    allSamples: [],
    timeSeries: [],
    heapSeries: [],
    allGcEvents: [],
    allPausePoints: [],
  };
  for (const b of benchmarks)
    if (b.samples?.length) flattenBenchmark(b, result);
  return result;
}

/** Extract time series, heap, GC, and pause data from one benchmark */
function flattenBenchmark(b: PreparedBenchmark, out: FlattenedData): void {
  const warmupCount = b.warmupSamples?.length || 0;
  b.warmupSamples?.forEach((value, i) => {
    out.timeSeries.push({
      benchmark: b.name,
      iteration: i - warmupCount,
      value,
      isWarmup: true,
    });
  });

  const sampleEndTimes = cumulativeSum(b.samples);
  b.samples.forEach((value, i) => {
    out.allSamples.push({ benchmark: b.name, value, iteration: i });
    out.timeSeries.push({
      benchmark: b.name,
      iteration: i,
      value,
      isWarmup: false,
      optStatus: b.optSamples?.[i],
    });
    if (b.heapSamples?.[i] !== undefined) {
      out.heapSeries.push({
        benchmark: b.name,
        iteration: i,
        value: b.heapSamples[i],
      });
    }
  });

  b.gcEvents?.forEach(gc => {
    const idx = sampleEndTimes.findIndex(t => t >= gc.offset);
    out.allGcEvents.push({
      benchmark: b.name,
      sampleIndex: idx >= 0 ? idx : b.samples.length - 1,
      duration: gc.duration,
    });
  });
  b.pausePoints?.forEach(p => {
    out.allPausePoints.push({
      benchmark: b.name,
      sampleIndex: p.sampleIndex,
      durationMs: p.durationMs,
    });
  });
}

function cumulativeSum(arr: number[]): number[] {
  const result: number[] = [];
  let sum = 0;
  for (const v of arr) {
    sum += v;
    result.push(sum);
  }
  return result;
}

function showError(groupIndex: number, message: string): void {
  const container = document.querySelector(`#group-${groupIndex}`);
  if (container) container.innerHTML = `<div class="error">${message}</div>`;
}

function formatPct(v: number): string {
  const sign = v >= 0 ? "+" : "";
  return sign + v.toFixed(1) + "%";
}

function generateCIHtml(ci: BenchmarkEntry["comparisonCI"]): string {
  if (!ci) return "";
  const text = `${formatPct(ci.percent)} [${formatPct(ci.ci[0])}, ${formatPct(ci.ci[1])}]`;
  return `
    <div class="stat-item">
      <div class="stat-label">vs Baseline</div>
      <div class="stat-value ci-${ci.direction}">${text}</div>
    </div>
  `;
}

function generateStatsHtml(b: PreparedBenchmark, gcEnabled: boolean): string {
  const ciHtml = generateCIHtml(b.comparisonCI);

  if (b.sectionStats?.length) {
    const stats = gcEnabled
      ? b.sectionStats
      : b.sectionStats.filter(s => s.groupTitle !== "gc");
    const statsHtml = stats
      .map(
        stat => `
      <div class="stat-item">
        <div class="stat-label">${stat.groupTitle ? stat.groupTitle + " " : ""}${stat.label}</div>
        <div class="stat-value">${stat.value}</div>
      </div>
    `,
      )
      .join("");
    return `
      <div class="summary-stats">
        <h3 style="margin-bottom: 10px; color: #333;">${b.name}</h3>
        <div class="stats-grid">${ciHtml}${statsHtml}</div>
      </div>
    `;
  }

  // Fallback to hardcoded stats
  return `
    <div class="summary-stats">
      <h3 style="margin-bottom: 10px; color: #333;">${b.name}</h3>
      <div class="stats-grid">
        ${ciHtml}
        <div class="stat-item">
          <div class="stat-label">Min</div>
          <div class="stat-value">${b.stats.min.toFixed(3)}ms</div>
        </div>
        <div class="stat-item">
          <div class="stat-label">Median</div>
          <div class="stat-value">${b.stats.p50.toFixed(3)}ms</div>
        </div>
        <div class="stat-item">
          <div class="stat-label">Mean</div>
          <div class="stat-value">${b.stats.avg.toFixed(3)}ms</div>
        </div>
        <div class="stat-item">
          <div class="stat-label">Max</div>
          <div class="stat-value">${b.stats.max.toFixed(3)}ms</div>
        </div>
        <div class="stat-item">
          <div class="stat-label">P75</div>
          <div class="stat-value">${b.stats.p75.toFixed(3)}ms</div>
        </div>
        <div class="stat-item">
          <div class="stat-label">P99</div>
          <div class="stat-value">${b.stats.p99.toFixed(3)}ms</div>
        </div>
      </div>
    </div>
  `;
}
