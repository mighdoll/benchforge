import { useEffect, useRef } from "preact/hooks";
import type { BenchmarkGroup, ReportData } from "../ReportData.ts";
import {
  type FlattenedData,
  flattenSamples,
  type PreparedBenchmark,
  prepareBenchmarks,
} from "../plots/RenderPlots.ts";
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

  return (
    <div>
      <div class="group-header">
        <h2>{group.name}</h2>
      </div>
      <div class="plot-grid">
        <div class="plot-container">
          <div class="plot-title">Time per Sample</div>
          <div class="plot-description">
            Execution time for each sample in collection order
          </div>
          <TimeSeriesPlot benchmarks={benchmarks} flat={flat} index={index} />
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

interface PlotProps {
  benchmarks: PreparedBenchmark[];
  flat: FlattenedData;
  index: number;
}

/** Lazy-imports and renders a time-series chart for one benchmark group. */
function TimeSeriesPlot({ flat, index }: PlotProps) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (flat.timeSeries.length === 0) return;
    import("../plots/SampleTimeSeries.ts").then(({ createSampleTimeSeries }) => {
      if (!ref.current) return;
      ref.current.innerHTML = "";
      const { timeSeries, allGcEvents, allPausePoints, heapSeries } = flat;
      ref.current.appendChild(createSampleTimeSeries(timeSeries, allGcEvents, allPausePoints, heapSeries));
    });
  }, [flat]);
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
