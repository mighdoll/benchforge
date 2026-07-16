import { useMemo, useState } from "preact/hooks";
import {
  batchAlignX,
  batchCount,
  type FlattenedData,
  filterToBatch,
  flattenSamples,
  type PreparedBenchmark,
  prepareBenchmarks,
} from "../plots/RenderPlots.ts";
import type { SeriesVisibility } from "../plots/SampleTimeSeries.ts";
import { maxDots } from "../plots/TimeSeriesSamples.ts";
import type { BenchmarkGroup, ReportData } from "../ReportData.ts";
import { reportData, samplesLoaded } from "../State.ts";
import { HelpButton } from "./HelpButton.tsx";
import { useLazyPlot } from "./LazyPlot.ts";
import {
  BatchStepper,
  benchmarkPills,
  gcPills,
  SeriesToggles,
  toggledSet,
} from "./SamplesControls.tsx";

interface PlotProps {
  benchmarks: PreparedBenchmark[];
  flat: FlattenedData;
  index: number;
}
interface TimeSeriesPlotProps extends PlotProps {
  visibility: SeriesVisibility;
  batchMode: boolean;
}

/** True when at least one benchmark group has multiple samples (enough to plot). */
export function hasSufficientSamples(data: ReportData): boolean {
  return data.groups.some(groupHasSamples);
}

/** Time-series and histogram plots for each benchmark group. Lazy-loaded on first tab activation. */
export function SamplesPanel() {
  const data = reportData.value;
  if (!samplesLoaded.value || !data) return null;

  return (
    <>
      {data.groups.map((group, i) => (
        <SamplesGroup key={i} group={group} index={i} />
      ))}
    </>
  );
}

/** True when any benchmark or baseline in the group has multiple samples. */
function groupHasSamples(group: BenchmarkGroup): boolean {
  const multiSample = (b: { samples: unknown[] }) => b.samples.length > 1;
  return (
    group.benchmarks.some(multiSample) ||
    (!!group.baseline && multiSample(group.baseline))
  );
}

/** Renders time-series and histogram plots for one benchmark group, with batch stepping and series toggles. */
// biome-ignore lint/complexity/noExcessiveLinesPerFunction: cohesive samples view (hooks + conditional plot render); splitting hurts readability
function SamplesGroup({
  group,
  index,
}: {
  group: BenchmarkGroup;
  index: number;
}) {
  const hasSamples = groupHasSamples(group);
  const benchmarks = useMemo(() => prepareBenchmarks(group), [group]);
  const flat = useMemo(
    () => (hasSamples ? flattenSamples(benchmarks) : null),
    [benchmarks, hasSamples],
  );
  const numBatches = hasSamples ? batchCount(benchmarks) : 0;

  // batch === 0 means "All", 1..numBatches means specific batch
  const [batch, setBatch] = useState(0);
  const activeBatch = batch > numBatches ? 0 : batch;

  const viewFlat = useMemo(
    () =>
      flat && activeBatch > 0
        ? filterToBatch(flat, benchmarks, activeBatch - 1)
        : flat,
    [flat, benchmarks, activeBatch],
  );

  // "All" view of a batched run aligns interleaved baseline/current batches on a
  // shared batch-fraction x axis; per-batch drill-down keeps per-iteration x.
  const batchMode = numBatches > 1 && activeBatch === 0;
  const tsFlat = useMemo(
    () =>
      viewFlat && batchMode ? batchAlignX(viewFlat, benchmarks) : viewFlat,
    [viewFlat, benchmarks, batchMode],
  );

  const [visibility, setVisibility] = useState<SeriesVisibility>({
    hidden: new Set(),
    heap: true,
    baselineHeap: false,
    rejected: true,
    gcShown: new Set(),
  });

  if (!group.benchmarks?.length) return null;
  if (!hasSamples || !flat || !viewFlat || !tsFlat)
    return (
      <div>
        <div class="group-header">
          <h2>{group.name}</h2>
        </div>
        <p class="single-sample-notice">
          Single sample collected &mdash; plots require multiple samples.
        </p>
      </div>
    );

  const hasHeap = flat.heapSeries.length > 0;
  const hasBaselineHeap = flat.baselineHeapSeries.length > 0;
  const hasRejected = flat.timeSeries.some(d => d.isRejected);
  const sampled = plotDownsamples(viewFlat.timeSeries);
  const countText = countSeries(viewFlat.timeSeries, benchmarks)
    .map(s => `${s.name} ${s.count.toLocaleString()}`)
    .join(" + ");

  const toggle = (key: keyof SeriesVisibility) =>
    setVisibility(v => ({ ...v, [key]: !v[key] }));
  const toggleBenchmark = (name: string) =>
    setVisibility(v => ({ ...v, hidden: toggledSet(v.hidden, name) }));
  const toggleGc = (name: string) =>
    setVisibility(v => ({ ...v, gcShown: toggledSet(v.gcShown, name) }));
  const seriesPills = benchmarkPills(benchmarks, visibility.hidden);
  const gcSeriesNames = [...new Set(flat.allGcEvents.map(e => e.benchmark))];
  const gcPillList = gcPills(benchmarks, gcSeriesNames, visibility.gcShown);

  return (
    <div>
      <div class="group-header">
        <h2>{group.name}</h2>
      </div>
      <div class="plot-grid">
        <div class="plot-container">
          <div class="plot-title">
            Time per Iteration <HelpButton topic="timeSeries" />
          </div>
          <div class="plot-description">
            {sampled
              ? `${countText} iterations (downsampled for display)`
              : "Execution time for each iteration in collection order"}
          </div>
          <div class="plot-controls">
            <SeriesToggles
              seriesPills={seriesPills}
              gcPills={gcPillList}
              hasHeap={hasHeap}
              hasBaselineHeap={hasBaselineHeap}
              hasRejected={hasRejected}
              visibility={visibility}
              onToggle={toggle}
              onToggleBenchmark={toggleBenchmark}
              onToggleGc={toggleGc}
            />
            {numBatches > 1 && (
              <BatchStepper
                batch={activeBatch}
                total={numBatches}
                onChange={setBatch}
              />
            )}
          </div>
          <TimeSeriesPlot
            benchmarks={benchmarks}
            flat={tsFlat}
            index={index}
            visibility={visibility}
            batchMode={batchMode}
          />
        </div>
        <div class="plot-container">
          <div class="plot-title">
            Time Distribution <HelpButton topic="histogram" />
          </div>
          <div class="plot-description">
            Frequency distribution of execution times
          </div>
          <HistogramPlot
            benchmarks={benchmarks}
            flat={viewFlat}
            index={index}
          />
        </div>
      </div>
    </div>
  );
}

/** True when the time-series plot will thin any dot partition: it downsamples
 *  warmup, pooled baseline, and pooled measured samples to `maxDots` each
 *  (shared with plots/TimeSeriesSamples.ts), so the caption should only claim
 *  sampling when one of those pools exceeds that cap. */
function plotDownsamples(timeSeries: FlattenedData["timeSeries"]): boolean {
  let warmup = 0;
  let baseline = 0;
  let measured = 0;
  for (const d of timeSeries) {
    if (d.isWarmup) warmup++;
    else if (d.isRejected) continue;
    else if (d.isBaseline) baseline++;
    else measured++;
  }
  return warmup > maxDots || baseline > maxDots || measured > maxDots;
}

/** Per-series non-warmup sample counts, current variants before baselines, used
 *  for the compact "link 13,412 + baseline 3,911 iterations" caption. */
function countSeries(
  timeSeries: FlattenedData["timeSeries"],
  benchmarks: PreparedBenchmark[],
): { name: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const d of timeSeries) {
    if (d.isWarmup) continue;
    counts.set(d.benchmark, (counts.get(d.benchmark) ?? 0) + 1);
  }
  const ordered = [...benchmarks].sort(
    (a, b) => Number(a.isBaseline) - Number(b.isBaseline),
  );
  return ordered
    .filter(b => counts.has(b.name))
    .map(b => ({ name: b.name, count: counts.get(b.name)! }));
}

/** Lazy-imports and renders a time-series chart for one benchmark group. */
function TimeSeriesPlot({
  flat,
  index,
  visibility,
  batchMode,
}: TimeSeriesPlotProps) {
  const ref = useLazyPlot(
    async () => {
      if (flat.timeSeries.length === 0) return null;
      const { createSampleTimeSeries } = await import(
        "../plots/SampleTimeSeries.ts"
      );
      const { timeSeries, allGcEvents, allPausePoints } = flat;
      const { heapSeries, baselineHeapSeries } = flat;
      return createSampleTimeSeries(
        timeSeries,
        allGcEvents,
        allPausePoints,
        heapSeries,
        baselineHeapSeries,
        visibility,
        batchMode,
      );
    },
    [flat, visibility, batchMode],
    "Time series plot",
  );
  return (
    <div id={`sample-timeseries-${index}`} class="plot-area" ref={ref}>
      <div class="loading">Loading time series...</div>
    </div>
  );
}

/** Lazy-imports and renders a histogram with KDE for one benchmark group. */
function HistogramPlot({ benchmarks, flat, index }: PlotProps) {
  const names = benchmarks.map(b => b.name);
  const ref = useLazyPlot(
    async () => {
      if (flat.allSamples.length === 0) return null;
      const { createHistogramKde } = await import("../plots/HistogramKde.ts");
      return createHistogramKde(flat.allSamples, names);
    },
    [flat, benchmarks],
    "Histogram plot",
  );
  return (
    <div id={`histogram-${index}`} class="plot-area" ref={ref}>
      <div class="loading">Loading histogram...</div>
    </div>
  );
}
