import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { useLazyPlot } from "./LazyPlot.ts";
import type { GitVersion } from "../../report/GitUtils.ts";
import type { DifferenceCI } from "../../stats/StatisticalUtils.ts";
import { formatRelativeTime } from "../DateFormat.ts";
import { formatCount, formatDecimalBytes } from "../LineData.ts";
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

const skipArgs = new Set(["_", "$0", "view", "file"]);

/** Main summary view: fetches report data, shows CLI args header and collapsible benchmark groups. */
export function SummaryPanel() {
  const dataProvider = provider.value!;
  const data = reportData.value;
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    dataProvider.fetchReportData()
      .then(result => (reportData.value = result as ReportData))
      .catch(err => {
        console.error("Report load failed:", err);
        setError(String(err));
      });
  }, [dataProvider]);

  if (error)
    return <div class="empty-state"><p>Failed to load report data: {error}</p></div>;
  if (!data)
    return <div class="empty-state"><p>Loading report&hellip;</p></div>;

  return (
    <>
      <ReportHeader metadata={data.metadata} />
      {data.groups.map((group, i) => (
        <CollapsibleGroup key={i} group={group} />
      ))}
    </>
  );
}

declare const __BENCHFORGE_GIT_HASH__: string;
declare const __BENCHFORGE_GIT_DIRTY__: boolean;
declare const __BENCHFORGE_BUILD_DATE__: string;

/** Fallback for dev/unbundled builds where compile-time globals are absent. */
function safeGlobal<T>(v: T, fallback: T): T {
  return typeof v !== "undefined" ? v : fallback;
}

/** Assemble "benchforge <hash> <relative-date>" from compile-time globals. */
function benchforgeLabel(): string {
  const hash = safeGlobal(__BENCHFORGE_GIT_HASH__, "dev");
  const dirty = safeGlobal(__BENCHFORGE_GIT_DIRTY__, false);
  const date = safeGlobal(__BENCHFORGE_BUILD_DATE__, "");
  const label = `benchforge ${hash}${dirty ? "*" : ""}`;
  return date ? `${label} ${formatRelativeTime(date)}` : label;
}

function ReportHeader({ metadata }: { metadata: ReportData["metadata"] }) {
  const { cliArgs, cliDefaults, currentVersion, baselineVersion } = metadata;
  const versions = [
    currentVersion && `Current: ${formatVersion(currentVersion)}`,
    baselineVersion && `Baseline: ${formatVersion(baselineVersion)}`,
  ].filter(Boolean);

  return (
    <div class="report-header">
      <div class="cli-args">{formatCliArgs(cliArgs, cliDefaults)}</div>
      <div class="header-right">
        <div class="metadata">{new Date().toLocaleString()}</div>
        <div class="metadata benchforge-version">{benchforgeLabel()}</div>
        {versions.length > 0 && (
          <div class="version-info">{versions.join(" | ")}</div>
        )}
      </div>
    </div>
  );
}

/** Expandable benchmark group with comparison badge and section panels. */
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
        {group.warnings && (
          <span class="batch-warnings">
            {group.warnings.map(w => <span class="batch-warning">{w}</span>)}
          </span>
        )}
      </div>
      {open && <GroupContent current={current} />}
    </div>
  );
}

function GroupContent({ current }: { current: BenchmarkEntry }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (ref.current) alignRunColumns(ref.current);
  });
  return (
    <div class="panel-grid" ref={ref}>
      {current.sections?.map((s, i) => <SectionPanel key={i} section={s} />)}
      <HeapPanel entry={current} />
      <CoveragePanel entry={current} />
    </div>
  );
}

function SectionPanel({ section }: { section: ViewerSection }) {
  if (!section.rows.length) return null;
  const range = useMemo(() => sectionEstimateRange(section), [section]);
  const titleEl = section.tabLink
    ? <a class="panel-title-link" onClick={() => (activeTabId.value = section.tabLink!)}>{section.title}</a>
    : <span>{section.title}</span>;

  return (
    <div class="section-panel">
      <div class="panel-header">{titleEl}</div>
      <div class="panel-body">
        {section.rows.map((row, i) => <StatRow key={i} row={row} estimateRange={range} />)}
      </div>
    </div>
  );
}

/** Set CSS vars so run-name and run-value columns align across all sections. */
function alignRunColumns(panel: HTMLElement): void {
  const maxW = (sel: string) =>
    Math.max(0, ...[...panel.querySelectorAll<HTMLElement>(sel)].map(el => el.scrollWidth));
  const maxName = maxW(".run-name");
  const maxValue = maxW(".run-value");
  if (maxName) panel.style.setProperty("--run-name-width", `${maxName}px`);
  if (maxValue) panel.style.setProperty("--run-value-width", `${maxValue}px`);
}

function StatRow({ row, estimateRange }: { row: ViewerRow; estimateRange?: [number, number] }) {
  if (row.shared) {
    return (
      <div class="stat-row">
        <div class="row-header">
          <span class="row-label">{row.label}</span>
        </div>
        <div class="run-entry">
          <span class="run-name" />
          <span class="run-value">{row.entries[0]?.value}</span>
        </div>
      </div>
    );
  }

  return (
    <div class={`stat-row${row.primary ? " primary-row" : ""}`}>
      <div class="row-header">
        <span class="row-label">{row.label}</span>
        {row.comparisonCI && <ComparisonBadge ci={row.comparisonCI} compact />}
      </div>
      {row.entries.map((entry, i) => (
        <RunEntry key={i} entry={entry} estimateRange={estimateRange} />
      ))}
    </div>
  );
}

/** Proportional horizontal offset range for aligning bootstrap CI plots. */
const maxCIShift = 80;

function RunEntry({ entry, estimateRange }: { entry: ViewerEntry; estimateRange?: [number, number] }) {
  const ci = entry.bootstrapCI;
  const [lo, hi] = estimateRange ?? [0, 0];
  const shift = ci && hi > lo ? ((ci.estimate - lo) / (hi - lo)) * maxCIShift : undefined;
  return (
    <div class="run-entry">
      <span class="run-name">{entry.runName}</span>
      {ci
        ? <BootstrapCIMount ci={ci} label={entry.value} shift={shift} />
        : <span class="run-value">{entry.value}</span>}
    </div>
  );
}

function SharedStat({ label, value }: { label: string; value: string }) {
  return (
    <div class="stat-row shared-row">
      <span class="row-label">{label}</span>
      <span class="row-value">{value}</span>
    </div>
  );
}

function HeapPanel({ entry }: { entry: BenchmarkEntry }) {
  const { heapSummary: heap, allocationSamples: allocSamples } = entry;
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
            <SharedStat label="total bytes" value={formatDecimalBytes(heap.totalBytes)} />
            <SharedStat label="user bytes" value={formatDecimalBytes(heap.userBytes)} />
          </>
        )}
        {allocSamples && allocSamples.length > 0 && (
          <SharedStat label="alloc samples" value={allocSamples.length.toLocaleString()} />
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
        <SharedStat label="functions tracked" value={cov.functionCount.toLocaleString()} />
        <SharedStat label="total calls" value={formatCount(cov.totalCalls)} />
      </div>
    </div>
  );
}

const directionLabels: Record<string, string> = {
  faster: "Faster", slower: "Slower", uncertain: "Inconclusive", equivalent: "Equivalent",
};

function ComparisonBadge({ ci, compact }: { ci: DifferenceCI; compact?: boolean }) {
  return (
    <span class="comparison-badge">
      <span class={`badge badge-${ci.direction}`}>
        {compact ? formatPct(ci.percent) : directionLabels[ci.direction]}
      </span>
      {ci.histogram && <CIPlotMount ci={ci} compact={compact} />}
    </span>
  );
}

/** Lazy-imports CIPlot and renders a confidence interval chart inline. */
function CIPlotMount({ ci, compact }: { ci: DifferenceCI; compact?: boolean }) {
  const ref = useLazyPlot(async () => {
    const { createCIPlot } = await import("../plots/CIPlot.ts");
    const equivMargin = (reportData.value?.metadata.cliArgs?.["equiv-margin"] as number) || undefined;
    const opts = compact ? { width: 200, height: 70, title: "", equivMargin } : { equivMargin };
    return createCIPlot(ci, opts);
  }, [ci, compact], "CI plot");
  return <div class="ci-plot-container" ref={ref} />;
}

/** Lazy-imports CIPlot and renders a bootstrap distribution sparkline inline. */
function BootstrapCIMount({ ci, label, shift }: {
  ci: BootstrapCIData; label?: string; shift?: number;
}) {
  const ref = useLazyPlot(async () => {
    const { createDistributionPlot } = await import("../plots/CIPlot.ts");
    const opts = {
      width: 240, height: 80, title: "", direction: "uncertain" as const,
      ciLabels: ci.ciLabels, includeZero: false, smooth: true, pointLabel: label,
      ciLevel: ci.ciLevel, ciReliable: ci.ciReliable,
    };
    return createDistributionPlot(ci.histogram, ci.ci, ci.estimate, opts);
  }, [ci, label], "Bootstrap CI plot");
  const style = shift != null ? { marginLeft: `${Math.round(shift)}px` } : undefined;
  return <div class="ci-plot-inline" style={style} ref={ref} />;
}

/** Compute min/max bootstrap estimates across a section for proportional positioning */
function sectionEstimateRange(section: ViewerSection): [number, number] | undefined {
  const estimates = section.rows
    .flatMap(row => row.entries)
    .map(e => e.bootstrapCI?.estimate)
    .filter((v): v is number => v != null);
  if (estimates.length < 2) return undefined;
  const min = Math.min(...estimates), max = Math.max(...estimates);
  return max > min ? [min, max] : undefined;
}

/** Format CLI args for display, filtering out defaults, internal keys, and camelCase aliases. */
function formatCliArgs(
  args?: Record<string, unknown>,
  defaults?: Record<string, unknown>,
): string {
  if (!args) return "benchforge";
  const isDisplayable = (key: string, value: unknown): boolean => {
    if (skipArgs.has(key) || value === undefined || value === false) return false;
    if (defaults?.[key] === value) return false;
    // skip camelCase aliases (yargs generates both kebab-case and camelCase)
    if (!key.includes("-") && key !== key.toLowerCase()) return false;
    if (key === "convergence" && !args.adaptive) return false;
    return true;
  };
  const flags = Object.entries(args)
    .filter(([key, value]) => isDisplayable(key, value))
    .map(([key, value]) => (value === true ? `--${key}` : `--${key} ${value}`));
  return ["benchforge", ...flags].join(" ");
}

/** Format a git version as "hash (relative-date)", with dirty marker. */
function formatVersion(v: GitVersion): string {
  if (!v || v.hash === "unknown") return "unknown";
  const hash = v.dirty ? v.hash + "*" : v.hash;
  if (!v.date) return hash;
  return `${hash} (${formatRelativeTime(v.date)})`;
}
