import type { GitVersion } from "../report/GitUtils.ts";
import { formatRelativeTime } from "./DateFormat.ts";
import { escapeHtml } from "./Helpers.ts";
import type { DataProvider } from "./Providers.ts";
import type { BenchmarkGroup, ReportData } from "./ReportData.ts";

/** CLI args with their default values, hidden from the display header. */
const defaultArgs: Record<string, unknown> = {
  worker: true,
  time: 5,
  warmup: 500,
  "pause-interval": 0,
  "pause-duration": 100,
};

/** Internal yargs keys and viewer-only flags, excluded from the CLI display. */
const skipArgs = new Set(["_", "$0", "view"]);

/** Fetch report data and render the summary tab (stats, CI badges, header). */
export async function loadSummary(
  provider: DataProvider,
  summaryPanel: HTMLDivElement,
): Promise<ReportData | null> {
  summaryPanel.innerHTML =
    '<div class="empty-state"><p>Loading report\u2026</p></div>';

  try {
    const data = (await provider.fetchReportData()) as ReportData;

    summaryPanel.innerHTML =
      buildReportHeader(data.metadata as unknown as Record<string, unknown>) +
      data.groups
        .map((group, i: number) => buildSummaryGroupHtml(group, i))
        .join("");

    const { renderSummaryStats } = await import("./plots/RenderPlots.ts");
    renderSummaryStats(data);
    return data;
  } catch (err) {
    console.error("Report load failed:", err);
    summaryPanel.innerHTML =
      '<div class="empty-state"><p>Failed to load report data: ' +
      escapeHtml(String(err)) +
      "</p></div>";
    return null;
  }
}

/** Render the header bar with CLI args, generation date, and git version info. */
function buildReportHeader(metadata: Record<string, unknown>): string {
  const args = metadata.cliArgs as Record<string, unknown> | undefined;
  const cliArgs = formatCliArgs(args);
  const version = formatVersionInfo(metadata);
  return `<div class="report-header">
    <div class="cli-args">${escapeHtml(cliArgs)}</div>
    <div class="header-right">
      <div class="metadata">Generated: ${escapeHtml(new Date().toLocaleString())}</div>
      ${version}
    </div>
  </div>`;
}

/** Build the HTML for one benchmark group: header, comparison badge, and stats container. */
function buildSummaryGroupHtml(group: BenchmarkGroup, i: number): string {
  if (!group.benchmarks || group.benchmarks.length === 0) {
    return `<div><div class="error">No benchmark data available for this group</div></div>`;
  }
  const badge = comparisonBadge(group, i);
  return `<div>
    <div class="group-header">
      <h2>${escapeHtml(group.name)}</h2>
      ${badge}
    </div>
    <div id="stats-${i}"></div>
  </div>`;
}

/** Reconstruct a display-friendly CLI invocation, hiding default and internal args. */
function formatCliArgs(args?: Record<string, unknown>): string {
  if (!args) return "benchforge";
  const flags = Object.entries(args)
    .filter(([key, value]) => {
      if (skipArgs.has(key) || value === undefined || value === false)
        return false;
      if (defaultArgs[key] === value) return false;
      if (!key.includes("-") && key !== key.toLowerCase()) return false;
      if (key === "convergence" && !args.adaptive) return false;
      return true;
    })
    .map(([key, value]) => (value === true ? `--${key}` : `--${key} ${value}`));
  return ["benchforge", ...flags].join(" ");
}

/** Build the "Current: hash | Baseline: hash" version badge, if git info is present. */
function formatVersionInfo(metadata: Record<string, unknown>): string {
  const cur = metadata.currentVersion as GitVersion | undefined;
  const base = metadata.baselineVersion as GitVersion | undefined;
  if (!cur && !base) return "";
  const parts: string[] = [];
  if (cur) parts.push("Current: " + formatVersion(cur));
  if (base) parts.push("Baseline: " + formatVersion(base));
  return `<div class="version-info">${parts.join(" | ")}</div>`;
}

/** Render a faster/slower/inconclusive badge with a CI plot container, if comparison data exists. */
function comparisonBadge(group: BenchmarkGroup, i: number): string {
  const ci = group.benchmarks[0]?.comparisonCI;
  if (!ci) return "";
  const labels: Record<string, string> = {
    faster: "Faster",
    slower: "Slower",
    uncertain: "Inconclusive",
  };
  return `<span class="badge badge-${ci.direction}">${labels[ci.direction]}</span>
    <div id="ci-plot-${i}" class="ci-plot-container"></div>`;
}

/** Format a git version as "hash (relative-date)", appending "*" if dirty. */
function formatVersion(v: GitVersion): string {
  if (!v || v.hash === "unknown") return "unknown";
  const hash = v.dirty ? v.hash + "*" : v.hash;
  if (!v.date) return hash;
  return `${hash} (${formatRelativeTime(v.date)})`;
}
