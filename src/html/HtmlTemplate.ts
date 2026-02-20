import type { GitVersion, GroupData, ReportData } from "./Types.ts";

const skipArgs = new Set(["_", "$0", "html", "export-html"]);

/** Format ISO date as local time with UTC: "Jan 9, 2026, 3:45 PM (2026-01-09T23:45:00Z)" */
export function formatDateWithTimezone(isoDate: string): string {
  const date = new Date(isoDate);
  const local = date.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
  const utc = date.toISOString().replace(".000Z", "Z");
  return `${local} (${utc})`;
}

/** Format relative time: "5m ago", "2h ago", "yesterday", "3 days ago" */
export function formatRelativeTime(isoDate: string): string {
  const date = new Date(isoDate);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return "just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays === 1) return "yesterday";
  if (diffDays < 30) return `${diffDays} days ago`;
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/** Format git version for display: "abc1234* (5m ago)" */
function formatVersion(version?: GitVersion): string {
  if (!version || version.hash === "unknown") return "unknown";
  const hashDisplay = version.dirty ? `${version.hash}*` : version.hash;
  const timeDisplay = version.date ? formatRelativeTime(version.date) : "";
  return timeDisplay ? `${hashDisplay} (${timeDisplay})` : hashDisplay;
}

/** Render current/baseline version info as an HTML div */
function versionInfoHtml(data: ReportData): string {
  const { currentVersion, baselineVersion } = data.metadata;
  if (!currentVersion && !baselineVersion) return "";
  const parts: string[] = [];
  if (currentVersion) parts.push(`Current: ${formatVersion(currentVersion)}`);
  if (baselineVersion)
    parts.push(`Baseline: ${formatVersion(baselineVersion)}`);
  return `<div class="version-info">${parts.join(" | ")}</div>`;
}

const badgeLabels = {
  faster: "Faster",
  slower: "Slower",
  uncertain: "Inconclusive",
};

/** Render faster/slower/uncertain badge with CI plot container */
function comparisonBadge(group: GroupData, groupIndex: number): string {
  const ci = group.benchmarks[0]?.comparisonCI;
  if (!ci) return "";
  const label = badgeLabels[ci.direction];
  return `
    <span class="badge badge-${ci.direction}">${label}</span>
    <div id="ci-plot-${groupIndex}" class="ci-plot-container"></div>
  `;
}
const defaultArgs: Record<string, unknown> = {
  worker: true,
  time: 5,
  warmup: 500,
  "pause-interval": 0,
  "pause-duration": 100,
};

/** @return true if this CLI arg should be hidden from the report header */
function shouldSkipArg(
  key: string,
  value: unknown,
  adaptive: unknown,
): boolean {
  if (skipArgs.has(key) || value === undefined || value === false) return true;
  if (defaultArgs[key] === value) return true;
  if (!key.includes("-") && key !== key.toLowerCase()) return true; // skip yargs camelCase aliases
  if (key === "convergence" && !adaptive) return true;
  return false;
}

/** Reconstruct the CLI invocation string, omitting default/internal args */
function formatCliArgs(args?: Record<string, unknown>): string {
  if (!args) return "bb bench";
  const parts = ["bb bench"];
  for (const [key, value] of Object.entries(args)) {
    if (shouldSkipArg(key, value, args.adaptive)) continue;
    parts.push(value === true ? `--${key}` : `--${key} ${value}`);
  }
  return parts.join(" ");
}

/** Generate complete HTML document with embedded data and visualizations */
export function generateHtmlDocument(data: ReportData): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Benchmark Report - ${new Date().toLocaleDateString()}</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: #f5f5f5;
      padding: 20px;
      line-height: 1.6;
    }
    .header {
      background: white;
      padding: 10px 15px;
      border-radius: 8px;
      margin-bottom: 20px;
      box-shadow: 0 2px 4px rgba(0,0,0,0.1);
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    h1 { display: none; }
    h2 {
      color: #555;
      margin: 30px 0 20px;
      font-size: 20px;
      border-bottom: 2px solid #e0e0e0;
      padding-bottom: 10px;
    }
    .metadata { color: #666; font-size: 12px; }
    .cli-args {
      font-family: "SF Mono", Monaco, "Consolas", monospace;
      font-size: 11px;
      color: #555;
      background: #f0f0f0;
      padding: 6px 10px;
      border-radius: 4px;
      word-break: break-word;
    }
    .comparison-mode {
      background: #fff3cd;
      color: #856404;
      padding: 8px 12px;
      border-radius: 4px;
      display: inline-block;
      margin-top: 10px;
      font-weight: 500;
    }
    .plot-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 20px;
      margin-bottom: 30px;
    }
    .plot-grid.second-row { grid-template-columns: 1fr; }
    .plot-container {
      background: white;
      padding: 20px;
      border-radius: 8px;
      box-shadow: 0 2px 4px rgba(0,0,0,0.1);
    }
    .plot-container.full-width { grid-column: 1 / -1; }
    .plot-title { font-size: 18px; font-weight: 600; margin-bottom: 8px; color: #333; }
    .plot-description { font-size: 14px; color: #666; margin-bottom: 15px; }
    .plot-area {
      display: flex;
      justify-content: center;
      align-items: center;
      min-height: 300px;
    }
    .plot-area svg { overflow: visible; }
    .plot-area svg g[aria-label="x-axis label"] text { font-size: 14px; }
    .summary-stats { background: #f8f9fa; padding: 15px; border-radius: 6px; margin-top: 20px; }
    .stats-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
      gap: 10px;
      margin-top: 10px;
    }
    .stat-item { background: white; padding: 10px; border-radius: 4px; text-align: center; }
    .stat-label { font-size: 12px; color: #666; text-transform: uppercase; letter-spacing: 0.5px; }
    .stat-value { font-size: 18px; font-weight: 600; color: #333; margin-top: 4px; }
    .loading { color: #666; font-style: italic; padding: 20px; text-align: center; }
    .error { color: #d32f2f; background: #ffebee; padding: 15px; border-radius: 4px; margin: 10px 0; }
    .ci-faster { color: #22c55e; }
    .ci-slower { color: #ef4444; }
    .ci-uncertain { color: #6b7280; }
    .group-header {
      display: flex;
      align-items: center;
      gap: 12px;
      margin: 30px 0 20px;
      padding-bottom: 10px;
      border-bottom: 2px solid #e0e0e0;
    }
    .group-header h2 { margin: 0; border: none; padding: 0; }
    .badge {
      font-size: 12px;
      font-weight: 600;
      padding: 4px 10px;
      border-radius: 12px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    .badge-faster { background: #dcfce7; color: #166534; }
    .badge-slower { background: #fee2e2; color: #991b1b; }
    .badge-uncertain { background: #dbeafe; color: #1e40af; }
    .version-info { font-size: 12px; color: #666; margin-top: 6px; }
    .header-right { text-align: right; }
    .ci-plot-container { display: inline-block; vertical-align: middle; margin-left: 8px; }
    .ci-plot-container svg { display: block; }
  </style>
</head>
<body>
  <div class="header">
    <div class="cli-args">${formatCliArgs(data.metadata.cliArgs)}</div>
    <div class="header-right">
      <div class="metadata">Generated: ${formatDateWithTimezone(new Date().toISOString())}</div>
      ${versionInfoHtml(data)}
    </div>
  </div>

  ${data.groups
    .map(
      (group, i) => `
    <div id="group-${i}">
      ${
        group.benchmarks.length > 0
          ? `
        <div class="group-header">
          <h2>${group.name}</h2>
          ${comparisonBadge(group, i)}
        </div>

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

        <div id="stats-${i}"></div>
      `
          : '<div class="error">No benchmark data available for this group</div>'
      }
    </div>
  `,
    )
    .join("")}

  <script type="importmap">
    {
      "imports": {
        "d3": "https://cdn.jsdelivr.net/npm/d3@7/+esm",
        "@observablehq/plot": "https://cdn.jsdelivr.net/npm/@observablehq/plot@0.6/+esm"
      }
    }
  </script>
  <script type="module">
    import { renderPlots } from "./plots.js";
    const benchmarkData = ${JSON.stringify(data, null, 2)};
    renderPlots(benchmarkData);
  </script>
</body>
</html>`;
}
