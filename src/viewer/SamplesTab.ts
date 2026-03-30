import { escapeHtml } from "./Helpers.ts";
import type { ReportData } from "./ReportData.ts";

/** Build plot scaffolding and render time-series / histogram charts into the samples panel. */
export async function loadSamples(
  data: ReportData,
  samplesPanel: HTMLDivElement,
): Promise<void> {
  samplesPanel.innerHTML = data.groups
    .map((group, i) => buildSamplesGroupHtml(group, i))
    .join("");

  const { renderSamplePlots } = await import("./plots/RenderPlots.ts");
  renderSamplePlots(data);
}

/** True if any benchmark in the report collected more than one sample. */
export function hasSufficientSamples(data: ReportData): boolean {
  return data.groups.some(
    g =>
      g.benchmarks.some(b => b.samples.length > 1) ||
      (g.baseline !== undefined && g.baseline.samples.length > 1),
  );
}

function buildSamplesGroupHtml(
  group: ReportData["groups"][0],
  i: number,
): string {
  if (!group.benchmarks?.length) return "";

  const hasSamples =
    group.benchmarks.some(b => b.samples?.length > 1) ||
    (group.baseline && group.baseline.samples.length > 1);

  if (!hasSamples) {
    return `<div>
      <div class="group-header"><h2>${escapeHtml(group.name)}</h2></div>
      <p class="single-sample-notice">Single sample collected \u2014 plots require multiple samples.</p>
    </div>`;
  }

  return `<div>
    <div class="group-header"><h2>${escapeHtml(group.name)}</h2></div>
    <div class="plot-grid">
      <div class="plot-container">
        <div class="plot-title">Time per Sample</div>
        <div class="plot-description">Execution time for each sample in collection order</div>
        <div id="sample-timeseries-${i}" class="plot-area">
          <div class="loading">Loading time series...</div>
        </div>
      </div>
      <div class="plot-container">
        <div class="plot-title">Time Distribution</div>
        <div class="plot-description">Frequency distribution of execution times</div>
        <div id="histogram-${i}" class="plot-area">
          <div class="loading">Loading histogram...</div>
        </div>
      </div>
    </div>
  </div>`;
}
