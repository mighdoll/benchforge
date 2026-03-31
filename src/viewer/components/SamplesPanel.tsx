import { useEffect, useRef } from "preact/hooks";
import type { BenchmarkGroup, ReportData } from "../ReportData.ts";
import {
  flattenSamples,
  prepareBenchmarks,
} from "../plots/RenderPlots.ts";
import { reportData, samplesLoaded } from "../State.ts";

export function hasSufficientSamples(data: ReportData): boolean {
  return data.groups.some(groupHasSamples);
}

function groupHasSamples(group: BenchmarkGroup): boolean {
  return (
    group.benchmarks.some(b => b.samples.length > 1) ||
    (group.baseline !== undefined && group.baseline.samples.length > 1)
  );
}

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

interface GroupPlotProps { group: BenchmarkGroup; index: number }

function SamplesGroup({ group, index }: GroupPlotProps) {
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
          <TimeSeriesPlot group={group} index={index} />
        </div>
        <div class="plot-container">
          <div class="plot-title">Time Distribution</div>
          <div class="plot-description">
            Frequency distribution of execution times
          </div>
          <HistogramPlot group={group} index={index} />
        </div>
      </div>
    </div>
  );
}

function TimeSeriesPlot({ group, index }: GroupPlotProps) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const benchmarks = prepareBenchmarks(group);
    const f = flattenSamples(benchmarks);
    if (f.timeSeries.length === 0) return;
    import("../plots/SampleTimeSeries.ts").then(({ createSampleTimeSeries }) => {
      if (!ref.current) return;
      ref.current.innerHTML = "";
      const { timeSeries, allGcEvents, allPausePoints, heapSeries } = f;
      const el = createSampleTimeSeries(timeSeries, allGcEvents, allPausePoints, heapSeries);
      ref.current.appendChild(el);
    });
  }, [group]);
  return (
    <div id={`sample-timeseries-${index}`} class="plot-area" ref={ref}>
      <div class="loading">Loading time series...</div>
    </div>
  );
}

function HistogramPlot({ group, index }: GroupPlotProps) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const benchmarks = prepareBenchmarks(group);
    const f = flattenSamples(benchmarks);
    const names = benchmarks.map(b => b.name);
    if (f.allSamples.length === 0) return;
    import("../plots/HistogramKde.ts").then(({ createHistogramKde }) => {
      if (!ref.current) return;
      ref.current.innerHTML = "";
      ref.current.appendChild(createHistogramKde(f.allSamples, names));
    });
  }, [group]);
  return (
    <div id={`histogram-${index}`} class="plot-area" ref={ref}>
      <div class="loading">Loading histogram...</div>
    </div>
  );
}
