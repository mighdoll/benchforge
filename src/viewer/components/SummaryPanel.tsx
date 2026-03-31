import { useEffect, useRef, useState } from "preact/hooks";
import type { GitVersion } from "../../report/GitUtils.ts";
import type { DifferenceCI } from "../../stats/StatisticalUtils.ts";
import { formatRelativeTime } from "../DateFormat.ts";
import type { BenchmarkGroup, BenchmarkStats, SectionStat } from "../ReportData.ts";
import type { ReportData } from "../ReportData.ts";
import { formatPct } from "../plots/PlotTypes.ts";
import { prepareBenchmarks, type PreparedBenchmark } from "../plots/RenderPlots.ts";
import { provider, reportData } from "../State.ts";

const defaultArgs: Record<string, unknown> = {
  worker: true,
  time: 5,
  warmup: 500,
  "pause-interval": 0,
  "pause-duration": 100,
};
const skipArgs = new Set(["_", "$0", "view"]);

export function SummaryPanel() {
  const p = provider.value!;
  const data = reportData.value;
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    p.fetchReportData()
      .then(d => {
        reportData.value = d as ReportData;
      })
      .catch(err => {
        console.error("Report load failed:", err);
        setError(String(err));
      });
  }, [p]);

  if (error)
    return (
      <div class="empty-state">
        <p>Failed to load report data: {error}</p>
      </div>
    );
  if (!data)
    return (
      <div class="empty-state">
        <p>Loading report&hellip;</p>
      </div>
    );

  const metadata = data.metadata as unknown as Record<string, unknown>;
  const gcEnabled = !!metadata.gcTrackingEnabled;

  return (
    <>
      <ReportHeader metadata={metadata} />
      {data.groups.map((group, i) => (
        <SummaryGroup
          key={i}
          group={group}
          index={i}
          gcEnabled={gcEnabled}
        />
      ))}
    </>
  );
}

function ReportHeader({ metadata }: { metadata: Record<string, unknown> }) {
  const args = metadata.cliArgs as Record<string, unknown> | undefined;
  const cliArgs = formatCliArgs(args);
  const cur = metadata.currentVersion as GitVersion | undefined;
  const base = metadata.baselineVersion as GitVersion | undefined;

  const versionParts: string[] = [];
  if (cur) versionParts.push("Current: " + formatVersion(cur));
  if (base) versionParts.push("Baseline: " + formatVersion(base));

  return (
    <div class="report-header">
      <div class="cli-args">{cliArgs}</div>
      <div class="header-right">
        <div class="metadata">Generated: {new Date().toLocaleString()}</div>
        {versionParts.length > 0 && (
          <div class="version-info">{versionParts.join(" | ")}</div>
        )}
      </div>
    </div>
  );
}

function SummaryGroup({
  group,
  index,
  gcEnabled,
}: {
  group: BenchmarkGroup;
  index: number;
  gcEnabled: boolean;
}) {
  const benchmarks = prepareBenchmarks(group);
  if (!benchmarks.length || !group.benchmarks?.length)
    return (
      <div>
        <div class="error">No benchmark data available for this group</div>
      </div>
    );

  const current = benchmarks.find(b => !b.isBaseline);
  const ci = current?.comparisonCI;

  return (
    <div>
      <div class="group-header">
        <h2>{group.name}</h2>
        {ci && <ComparisonBadge ci={ci} index={index} />}
      </div>
      <div id={`stats-${index}`}>
        {benchmarks.map(b => (
          <StatsCard key={b.name} benchmark={b} gcEnabled={gcEnabled} />
        ))}
      </div>
    </div>
  );
}

function ComparisonBadge({
  ci,
  index,
}: {
  ci: DifferenceCI;
  index: number;
}) {
  const labels: Record<string, string> = {
    faster: "Faster",
    slower: "Slower",
    uncertain: "Inconclusive",
  };
  return (
    <>
      <span class={`badge badge-${ci.direction}`}>{labels[ci.direction]}</span>
      {ci.histogram && <CIPlotMount ci={ci} index={index} />}
    </>
  );
}

function CIPlotMount({ ci, index }: { ci: DifferenceCI; index: number }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    import("../plots/CIPlot.ts").then(({ createCIPlot }) => {
      if (ref.current) {
        ref.current.innerHTML = "";
        ref.current.appendChild(createCIPlot(ci));
      }
    });
  }, [ci]);
  return <div id={`ci-plot-${index}`} class="ci-plot-container" ref={ref} />;
}

function StatsCard({
  benchmark,
  gcEnabled,
}: {
  benchmark: PreparedBenchmark;
  gcEnabled: boolean;
}) {
  const ci = benchmark.comparisonCI;
  return (
    <div class="summary-stats">
      <h3 style={{ marginBottom: 10, color: "#333" }}>{benchmark.name}</h3>
      <div class="stats-grid">
        {ci && (
          <div class="stat-item">
            <div class="stat-label">vs Baseline</div>
            <div class={`stat-value ci-${ci.direction}`}>
              {formatPct(ci.percent)} [{formatPct(ci.ci[0])},{" "}
              {formatPct(ci.ci[1])}]
            </div>
          </div>
        )}
        {benchmark.sectionStats?.length
          ? renderSectionStats(benchmark.sectionStats, gcEnabled)
          : renderFallbackStats(benchmark.stats)}
      </div>
    </div>
  );
}

/** Render section stats, hiding GC rows when GC tracking is disabled. */
function renderSectionStats(stats: SectionStat[], gcEnabled: boolean) {
  const filtered = gcEnabled
    ? stats
    : stats.filter(s => s.groupTitle !== "gc");
  return filtered.map((stat, i) => (
    <div key={i} class="stat-item">
      <div class="stat-label">
        {stat.groupTitle ? stat.groupTitle + " " : ""}
        {stat.label}
      </div>
      <div class="stat-value">{stat.value}</div>
    </div>
  ));
}

/** Show basic percentile stats when section stats are unavailable. */
function renderFallbackStats(stats: BenchmarkStats) {
  const items: [string, number][] = [
    ["Min", stats.min],
    ["Median", stats.p50],
    ["Mean", stats.avg],
    ["Max", stats.max],
    ["P75", stats.p75],
    ["P99", stats.p99],
  ];
  return items.map(([label, value]) => (
    <div key={label} class="stat-item">
      <div class="stat-label">{label}</div>
      <div class="stat-value">{value.toFixed(3)}ms</div>
    </div>
  ));
}

/** Reconstruct the CLI invocation string, omitting default and internal args. */
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

function formatVersion(v: GitVersion): string {
  if (!v || v.hash === "unknown") return "unknown";
  const hash = v.dirty ? v.hash + "*" : v.hash;
  if (!v.date) return hash;
  return `${hash} (${formatRelativeTime(v.date)})`;
}
