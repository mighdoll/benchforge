import { escapeHtml } from "./Helpers.ts";
import type { DataProvider } from "./Providers.ts";
import type { BenchmarkGroup, ReportData } from "./ReportData.ts";

interface VersionInfo {
  hash: string;
  date?: string;
  dirty?: boolean;
}

const defaultArgs: Record<string, unknown> = {
  worker: true,
  time: 5,
  warmup: 500,
  "pause-interval": 0,
  "pause-duration": 100,
};
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

function formatCliArgs(args?: Record<string, unknown>): string {
  if (!args) return "benchforge";
  const parts = ["benchforge"];
  for (const [key, value] of Object.entries(args)) {
    if (skipArgs.has(key) || value === undefined || value === false) continue;
    if (defaultArgs[key] === value) continue;
    if (!key.includes("-") && key !== key.toLowerCase()) continue;
    if (key === "convergence" && !args.adaptive) continue;
    parts.push(value === true ? `--${key}` : `--${key} ${value}`);
  }
  return parts.join(" ");
}

function formatVersionInfo(metadata: Record<string, unknown>): string {
  const cur = metadata.currentVersion as VersionInfo | undefined;
  const base = metadata.baselineVersion as VersionInfo | undefined;
  if (!cur && !base) return "";
  const parts: string[] = [];
  if (cur) parts.push("Current: " + formatVersion(cur));
  if (base) parts.push("Baseline: " + formatVersion(base));
  return `<div class="version-info">${parts.join(" | ")}</div>`;
}

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

function relativeDate(diffMs: number, date: string): string {
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(diffMs / 3600000);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(diffMs / 86400000);
  if (days === 1) return "yesterday";
  if (days < 30) return `${days} days ago`;
  return new Date(date).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
}

function formatVersion(v: VersionInfo): string {
  if (!v || v.hash === "unknown") return "unknown";
  const hash = v.dirty ? v.hash + "*" : v.hash;
  if (!v.date) return hash;
  const rel = relativeDate(Date.now() - new Date(v.date).getTime(), v.date);
  return `${hash} (${rel})`;
}
