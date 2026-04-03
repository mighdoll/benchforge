import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { BenchmarkGroup, ReportData } from "../ReportData.ts";
import {
  type FlattenedData,
  flattenSamples,
  type PreparedBenchmark,
  prepareBenchmarks,
} from "../plots/RenderPlots.ts";
import type { SeriesVisibility } from "../plots/SampleTimeSeries.ts";
import { reportData, samplesLoaded } from "../State.ts";

/** True when at least one benchmark group has multiple samples (enough to plot). */
export function hasSufficientSamples(data: ReportData): boolean {
  return data.groups.some(groupHasSamples);
}

function groupHasSamples(group: BenchmarkGroup): boolean {
  return (
    group.benchmarks.some(b => b.samples.length > 1) ||
    (group.baseline !== undefined && group.baseline.samples.length > 1)
  );
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

function SamplesGroup({ group, index }: { group: BenchmarkGroup; index: number }) {
  if (!group.benchmarks?.length) return null;

  if (!groupHasSamples(group))
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

  const benchmarks = prepareBenchmarks(group);
  const flat = flattenSamples(benchmarks);
  const hasBaseline = !!group.baseline;
  const hasHeap = flat.heapSeries.length > 0;
  const hasBaselineHeap = flat.baselineHeapSeries.length > 0;
  const hasRejected = flat.timeSeries.some(d => d.isRejected);
  const totalPoints = flat.timeSeries.length;
  const sampled = totalPoints > 1000;

  const [visibility, setVisibility] = useState<SeriesVisibility>({
    baseline: true,
    heap: true,
    baselineHeap: false,
    rejected: true,
  });

  const toggle = (key: keyof SeriesVisibility) =>
    setVisibility(v => ({ ...v, [key]: !v[key] }));

  return (
    <div>
      <div class="group-header">
        <h2>{group.name}</h2>
      </div>
      <div class="plot-grid">
        <div class="plot-container">
          <div class="plot-title">Time per Iteration</div>
          <div class="plot-description">
            {sampled
              ? `Sampled from ${totalPoints.toLocaleString()} iterations (showing ~1,000)`
              : "Execution time for each iteration in collection order"}
          </div>
          <SeriesToggles
            hasBaseline={hasBaseline}
            hasHeap={hasHeap}
            hasBaselineHeap={hasBaselineHeap}
            hasRejected={hasRejected}
            visibility={visibility}
            onToggle={toggle}
          />
          <TimeSeriesPlot
            benchmarks={benchmarks}
            flat={flat}
            index={index}
            visibility={visibility}
          />
        </div>
        <div class="plot-container">
          <div class="plot-title">Time Distribution</div>
          <div class="plot-description">
            Frequency distribution of execution times
          </div>
          <HistogramPlot benchmarks={benchmarks} flat={flat} index={index} />
        </div>
      </div>
    </div>
  );
}

interface ToggleProps {
  hasBaseline: boolean;
  hasHeap: boolean;
  hasBaselineHeap: boolean;
  hasRejected: boolean;
  visibility: SeriesVisibility;
  onToggle: (key: keyof SeriesVisibility) => void;
}

function SeriesToggles(props: ToggleProps) {
  const { hasBaseline, hasHeap, hasBaselineHeap, hasRejected, visibility, onToggle } = props;
  if (!hasBaseline && !hasHeap && !hasRejected) return null;
  return (
    <div class="series-toggles">
      {hasBaseline && (
        <button
          class={`toggle-pill${visibility.baseline ? " active" : ""}`}
          onClick={() => onToggle("baseline")}
        >
          baseline
        </button>
      )}
      {hasHeap && (
        <button
          class={`toggle-pill${visibility.heap ? " active" : ""}`}
          onClick={() => onToggle("heap")}
        >
          heap
        </button>
      )}
      {hasBaselineHeap && (
        <button
          class={`toggle-pill${visibility.baselineHeap ? " active" : ""}`}
          onClick={() => onToggle("baselineHeap")}
        >
          heap (baseline)
        </button>
      )}
      {hasRejected && (
        <button
          class={`toggle-pill${visibility.rejected ? " active" : ""}`}
          onClick={() => onToggle("rejected")}
        >
          rejected
        </button>
      )}
    </div>
  );
}

interface PlotProps {
  benchmarks: PreparedBenchmark[];
  flat: FlattenedData;
  index: number;
}

interface TimeSeriesPlotProps extends PlotProps {
  visibility: SeriesVisibility;
}

/** Lazy-imports and renders a time-series chart for one benchmark group. */
function TimeSeriesPlot({ flat, index, visibility }: TimeSeriesPlotProps) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (flat.timeSeries.length === 0) return;
    import("../plots/SampleTimeSeries.ts").then(({ createSampleTimeSeries }) => {
      if (!ref.current) return;
      ref.current.innerHTML = "";
      const { timeSeries, allGcEvents, allPausePoints, heapSeries, baselineHeapSeries } = flat;
      ref.current.appendChild(
        createSampleTimeSeries(
          timeSeries, allGcEvents, allPausePoints, heapSeries, baselineHeapSeries, visibility,
        ),
      );
    });
  }, [flat, visibility]);
  return (
    <div id={`sample-timeseries-${index}`} class="plot-area" ref={ref}>
      <div class="loading">Loading time series...</div>
    </div>
  );
}

/** Lazy-imports and renders a histogram with KDE for one benchmark group. */
function HistogramPlot({ benchmarks, flat, index }: PlotProps) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (flat.allSamples.length === 0) return;
    const names = benchmarks.map(b => b.name);
    import("../plots/HistogramKde.ts").then(({ createHistogramKde }) => {
      if (!ref.current) return;
      ref.current.innerHTML = "";
      ref.current.appendChild(createHistogramKde(flat.allSamples, names));
    });
  }, [flat, benchmarks]);
  return (
    <div id={`histogram-${index}`} class="plot-area" ref={ref}>
      <div class="loading">Loading histogram...</div>
    </div>
  );
}
