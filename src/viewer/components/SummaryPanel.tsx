import { useEffect, useRef, useState } from "preact/hooks";
import type { GitVersion } from "../../report/GitUtils.ts";
import type { DifferenceCI } from "../../stats/StatisticalUtils.ts";
import { formatRelativeTime } from "../DateFormat.ts";
import type {
  BenchmarkEntry,
  BenchmarkGroup,
  BootstrapCIData,
  ReportData,
  ViewerEntry,
  ViewerRow,
  ViewerSection,
} from "../ReportData.ts";
import { formatPct } from "../plots/PlotTypes.ts";
import { activeTabId, provider, reportData } from "../State.ts";

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
      .then(d => (reportData.value = d as ReportData))
      .catch(err => {
        console.error("Report load failed:", err);
        setError(String(err));
      });
  }, [p]);

  if (error)
    return <div class="empty-state"><p>Failed to load report data: {error}</p></div>;
  if (!data)
    return <div class="empty-state"><p>Loading report&hellip;</p></div>;

  const metadata = data.metadata as unknown as Record<string, unknown>;
  return (
    <>
      <ReportHeader metadata={metadata} />
      {data.groups.map((group, i) => (
        <CollapsibleGroup key={i} group={group} />
      ))}
    </>
  );
}

// --- Header ---

function ReportHeader({ metadata }: { metadata: Record<string, unknown> }) {
  const args = metadata.cliArgs as Record<string, unknown> | undefined;
  const cur = metadata.currentVersion as GitVersion | undefined;
  const base = metadata.baselineVersion as GitVersion | undefined;
  const versionParts: string[] = [];
  if (cur) versionParts.push("Current: " + formatVersion(cur));
  if (base) versionParts.push("Baseline: " + formatVersion(base));

  return (
    <div class="report-header">
      <div class="cli-args">{formatCliArgs(args)}</div>
      <div class="header-right">
        <div class="metadata">Generated: {new Date().toLocaleString()}</div>
        {versionParts.length > 0 && (
          <div class="version-info">{versionParts.join(" | ")}</div>
        )}
      </div>
    </div>
  );
}

// --- Collapsible Group ---

function CollapsibleGroup({ group }: { group: BenchmarkGroup }) {
  const [open, setOpen] = useState(true);
  const current = group.benchmarks?.[0];
  if (!current) return <div class="error">No benchmark data for this group</div>;

  const ci = current.comparisonCI;
  return (
    <div class="benchmark-group">
      <div class="group-header" onClick={() => setOpen(o => !o)}>
        <span class="group-toggle">{open ? "\u25be" : "\u25b8"}</span>
        <h2>{group.name}</h2>
        {ci && <ComparisonBadge ci={ci} />}
      </div>
      {open && <GroupContent current={current} />}
    </div>
  );
}

function GroupContent({ current }: { current: BenchmarkEntry }) {
  return (
    <div class="panel-grid">
      {current.sections?.map((s, i) => <SectionPanel key={i} section={s} />)}
      <HeapPanel entry={current} />
      <CoveragePanel entry={current} />
    </div>
  );
}

// --- Section Panels ---

function SectionPanel({ section }: { section: ViewerSection }) {
  if (!section.rows.length) return null;
  const ref = useRef<HTMLDivElement>(null);
  const titleEl = section.tabLink
    ? <a class="panel-title-link" onClick={() => (activeTabId.value = section.tabLink!)}>{section.title}</a>
    : <span>{section.title}</span>;

  useEffect(() => {
    if (!ref.current) return;
    alignRunColumns(ref.current);
  });

  return (
    <div class="section-panel" ref={ref}>
      <div class="panel-header">{titleEl}</div>
      <div class="panel-body">
        {section.rows.map((row, i) => <StatRow key={i} row={row} />)}
      </div>
    </div>
  );
}

/** Measure max run-name and run-value widths, then set CSS vars on the panel */
function alignRunColumns(panel: HTMLElement): void {
  let maxName = 0;
  let maxValue = 0;
  for (const el of panel.querySelectorAll<HTMLElement>(".run-name")) {
    maxName = Math.max(maxName, el.scrollWidth);
  }
  for (const el of panel.querySelectorAll<HTMLElement>(".run-value")) {
    maxValue = Math.max(maxValue, el.scrollWidth);
  }
  if (maxName) panel.style.setProperty("--run-name-width", `${maxName}px`);
  if (maxValue) panel.style.setProperty("--run-value-width", `${maxValue}px`);
}

function StatRow({ row }: { row: ViewerRow }) {
  if (row.shared) {
    const entry = row.entries[0];
    return (
      <div class="stat-row shared-row">
        <span class="row-label">{row.label}</span>
        <span class="row-value">{entry?.value}</span>
      </div>
    );
  }

  return (
    <div class="stat-row">
      <div class="row-header">
        <span class="row-label">{row.label}</span>
        {row.comparisonCI && <ComparisonBadge ci={row.comparisonCI} compact />}
      </div>
      {row.entries.map((entry, i) => <RunEntry key={i} entry={entry} />)}
    </div>
  );
}

function RunEntry({ entry }: { entry: ViewerEntry }) {
  return (
    <div class="run-entry">
      <span class="run-name">{entry.runName}</span>
      <span class="run-value">{entry.value}</span>
      {entry.bootstrapCI && <BootstrapCIMount ci={entry.bootstrapCI} />}
    </div>
  );
}

// --- Heap & Coverage Panels ---

function HeapPanel({ entry }: { entry: BenchmarkEntry }) {
  const heap = entry.heapSummary;
  const allocSamples = entry.allocationSamples;
  if (!heap && !allocSamples?.length) return null;

  return (
    <div class="section-panel">
      <div class="panel-header">
        <a class="panel-title-link" onClick={() => (activeTabId.value = "flamechart")}>
          heap allocation
        </a>
      </div>
      <div class="panel-body">
        {heap && (
          <>
            <div class="stat-row shared-row">
              <span class="row-label">total bytes</span>
              <span class="row-value">{formatBytesCompact(heap.totalBytes)}</span>
            </div>
            <div class="stat-row shared-row">
              <span class="row-label">user bytes</span>
              <span class="row-value">{formatBytesCompact(heap.userBytes)}</span>
            </div>
          </>
        )}
        {allocSamples && allocSamples.length > 0 && (
          <div class="stat-row shared-row">
            <span class="row-label">alloc samples</span>
            <span class="row-value">{allocSamples.length.toLocaleString()}</span>
          </div>
        )}
      </div>
    </div>
  );
}

function CoveragePanel({ entry }: { entry: BenchmarkEntry }) {
  const cov = entry.coverageSummary;
  if (!cov) return null;

  return (
    <div class="section-panel">
      <div class="panel-header">
        <span>calls</span>
      </div>
      <div class="panel-body">
        <div class="stat-row shared-row">
          <span class="row-label">functions tracked</span>
          <span class="row-value">{cov.functionCount.toLocaleString()}</span>
        </div>
        <div class="stat-row shared-row">
          <span class="row-label">total calls</span>
          <span class="row-value">{formatCount(cov.totalCalls)}</span>
        </div>
      </div>
    </div>
  );
}

// --- CI Visualizations ---

function ComparisonBadge({ ci, compact }: { ci: DifferenceCI; compact?: boolean }) {
  const labels: Record<string, string> = {
    faster: "Faster",
    slower: "Slower",
    uncertain: "Inconclusive",
  };
  return (
    <span class="comparison-badge">
      <span class={`badge badge-${ci.direction}`}>
        {compact ? formatPct(ci.percent) : labels[ci.direction]}
      </span>
      {ci.histogram && <CIPlotMount ci={ci} compact={compact} />}
    </span>
  );
}

function CIPlotMount({ ci, compact }: { ci: DifferenceCI; compact?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    import("../plots/CIPlot.ts").then(({ createCIPlot }) => {
      if (!ref.current) return;
      ref.current.innerHTML = "";
      const opts = compact ? { width: 160, height: 50, title: "" } : {};
      ref.current.appendChild(createCIPlot(ci, opts));
    });
  }, [ci, compact]);
  return <div class="ci-plot-container" ref={ref} />;
}

function BootstrapCIMount({ ci }: { ci: BootstrapCIData }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    import("../plots/CIPlot.ts").then(({ createDistributionPlot }) => {
      if (!ref.current) return;
      ref.current.innerHTML = "";
      ref.current.appendChild(
        createDistributionPlot(ci.histogram, ci.ci, ci.estimate, {
          width: 140,
          height: 40,
          title: "",
          direction: "uncertain",
        }),
      );
    });
  }, [ci]);
  return <div class="ci-plot-inline" ref={ref} />;
}

// --- Formatters ---

function formatBytesCompact(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
  if (bytes >= 1e3) return `${(bytes / 1e3).toFixed(1)} KB`;
  return `${bytes} B`;
}

function formatCount(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return n.toLocaleString();
}

function formatCliArgs(args?: Record<string, unknown>): string {
  if (!args) return "benchforge";
  const flags = Object.entries(args)
    .filter(([key, value]) => {
      if (skipArgs.has(key) || value === undefined || value === false) return false;
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
