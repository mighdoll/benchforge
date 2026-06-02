import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { useLazyPlot } from "./LazyPlot.ts";
import type { GitVersion } from "../../report/GitUtils.ts";
import type { CIDirection, DifferenceCI } from "../../stats/StatisticalUtils.ts";
import { formatRelativeTime } from "../DateFormat.ts";
import { formatCount, formatDecimalBytes } from "../LineData.ts";
import type {
  BenchmarkEntry,
  BenchmarkGroup,
  BootstrapCIData,
  ReportData,
  ShiftFunction,
  ShiftPercentile,
  ShiftRun,
  ViewerEntry,
  ViewerRow,
  ViewerSection,
} from "../ReportData.ts";
import { formatPct } from "../plots/PlotTypes.ts";
import { activeTabId, provider, reportData, trimMode } from "../State.ts";

const skipArgs = new Set(["_", "$0", "view", "file"]);

declare const __BENCHFORGE_GIT_HASH__: string;
declare const __BENCHFORGE_GIT_DIRTY__: boolean;
declare const __BENCHFORGE_BUILD_DATE__: string;

/** Proportional horizontal offset range for aligning bootstrap CI plots. */
const maxCIShift = 80;

const directionLabels: Record<CIDirection, string> = {
  faster: "Faster", slower: "Slower", uncertain: "Inconclusive", equivalent: "Equivalent",
};

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
      <ReportHeader data={data} />
      <div class="report-body">
        {hasRawView(data) && (
          <div class="report-toolbar">
            <TrimToggle />
          </div>
        )}
        {data.groups.map((group, i) => (
          <CollapsibleGroup key={i} group={group} />
        ))}
      </div>
    </>
  );
}

/** Report header: the reconstructed CLI command, run date, and git versions. */
function ReportHeader({ data }: { data: ReportData }) {
  const { metadata } = data;
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

/** True if any entry in the report carries an alternate (raw) view. */
function hasRawView(data: ReportData): boolean {
  return data.groups.some(g =>
    g.benchmarks.some(b => !!b.rawSections) || !!g.baseline?.rawSections,
  );
}

/** Single pill: when active, batches dominated by environmental noise
 *  (other apps, OS scheduling, thermal throttling) are excluded from stats. */
function TrimToggle() {
  const active = trimMode.value === "trim";
  const tip = active
    ? "Rejecting batches with likely environmental noise (other apps, OS jitter). Click to include all samples."
    : "Including all samples. Click to reject batches with likely environmental noise.";
  return (
    <button
      type="button"
      class={`toggle-pill${active ? " active" : ""}`}
      title={tip}
      aria-pressed={active}
      onClick={() => (trimMode.value = active ? "raw" : "trim")}
    >
      Noise rejection
    </button>
  );
}

/** Expandable benchmark group with comparison badge and section panels. */
function CollapsibleGroup({ group }: { group: BenchmarkGroup }) {
  const [open, setOpen] = useState(true);
  const current = group.benchmarks?.[0];
  if (!current) return <div class="error">No benchmark data for this group</div>;

  const ci = activeView(current).comparisonCI;
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

/** Format a git version as "hash (relative-date)", with dirty marker. */
function formatVersion(v: GitVersion): string {
  if (!v || v.hash === "unknown") return "unknown";
  const hash = v.dirty ? v.hash + "*" : v.hash;
  if (!v.date) return hash;
  return `${hash} (${formatRelativeTime(v.date)})`;
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
    return true;
  };
  const flags = Object.entries(args)
    .filter(([key, value]) => isDisplayable(key, value))
    .map(([key, value]) => (value === true ? `--${key}` : `--${key} ${value}`));
  return ["benchforge", ...flags].join(" ");
}

/** Assemble "benchforge <hash> <relative-date>" from compile-time globals. */
function benchforgeLabel(): string {
  const hash = safeGlobal(__BENCHFORGE_GIT_HASH__, "dev");
  const dirty = safeGlobal(__BENCHFORGE_GIT_DIRTY__, false);
  const date = safeGlobal(__BENCHFORGE_BUILD_DATE__, "");
  const label = `benchforge ${hash}${dirty ? "*" : ""}`;
  return date ? `${label} ${formatRelativeTime(date)}` : label;
}

/** Pick the trimmed or raw view of an entry based on the current trimMode. */
function activeView(entry: BenchmarkEntry): {
  sections?: ViewerSection[];
  comparisonCI?: DifferenceCI;
} {
  if (trimMode.value === "raw" && entry.rawSections)
    return { sections: entry.rawSections, comparisonCI: entry.rawComparisonCI };
  return { sections: entry.sections, comparisonCI: entry.comparisonCI };
}

/** Comparison verdict: a colored chip (group header) or plain delta text (compact). */
function ComparisonBadge({ ci, compact }: { ci: DifferenceCI; compact?: boolean }) {
  // Colored chip is reserved for the main verdict; per-row (compact) comparisons
  // render as plain bold text regardless of direction.
  const cls = compact ? "comparison-plain" : `badge badge-${ci.direction}`;
  return (
    <span class="comparison-badge">
      <span class={cls}>
        {compact ? formatPct(ci.percent) : directionLabels[ci.direction]}
      </span>
      {ci.histogram && <CIPlotMount ci={ci} compact={compact} />}
    </span>
  );
}

/** A group's panels (sections, heap, coverage), aligning run columns after layout. */
function GroupContent({ current }: { current: BenchmarkEntry }) {
  const ref = useRef<HTMLDivElement>(null);
  const sections = activeView(current).sections;
  useEffect(() => {
    if (ref.current) alignRunColumns(ref.current);
  });
  return (
    <div class="panel-grid" ref={ref}>
      {sections?.map((s, i) => <SectionPanel key={i} section={s} />)}
      <HeapPanel entry={current} />
      <CoveragePanel entry={current} />
    </div>
  );
}

/** Fallback for dev/unbundled builds where compile-time globals are absent. */
function safeGlobal<T>(v: T, fallback: T): T {
  return typeof v !== "undefined" ? v : fallback;
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

/** Set CSS vars so run-name and run-value columns align across all sections. */
function alignRunColumns(panel: HTMLElement): void {
  const maxW = (sel: string) =>
    Math.max(0, ...[...panel.querySelectorAll<HTMLElement>(sel)].map(el => el.scrollWidth));
  const maxName = maxW(".run-name");
  const maxValue = maxW(".run-value");
  if (maxName) panel.style.setProperty("--run-name-width", `${maxName}px`);
  if (maxValue) panel.style.setProperty("--run-value-width", `${maxValue}px`);
}

/** One section panel, dispatching to the shift, matrix, or plain stat-row layout. */
function SectionPanel({ section }: { section: ViewerSection }) {
  if (!section.rows.length) return null;
  const range = useMemo(() => sectionEstimateRange(section), [section]);
  const shift = section.rows.find(r => r.shiftFunction)?.shiftFunction;
  const titleEl = section.tabLink
    ? <a class="panel-title-link" onClick={() => (activeTabId.value = section.tabLink!)}>{section.title}</a>
    : <span>{section.title}</span>;

  if (shift) return <ShiftSection section={section} shift={shift} titleEl={titleEl} />;
  if (section.layout === "matrix") return <MatrixSection section={section} titleEl={titleEl} />;

  return (
    <div class="section-panel">
      <div class="panel-header">{titleEl}</div>
      <div class="panel-body">
        {section.rows.map((row, i) => (
          <StatRow key={i} row={row} estimateRange={range} />
        ))}
      </div>
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

/** A section with a shift function: the primary row's diff chart, then the
 *  per-percentile violins, then any shared rows (e.g. the line count). The
 *  primary row's per-run absolute values are dropped here -- they live in the
 *  violins' click-to-detail popup -- and non-primary comparable rows (p50, p95)
 *  are represented by the violins, so they are omitted from the top stack. */
function ShiftSection(
  { section, shift, titleEl }:
  { section: ViewerSection; shift: ShiftFunction; titleEl: preact.JSX.Element },
) {
  const primary = section.rows.find(r => r.primary);
  const shared = section.rows.filter(r => r.shared);
  return (
    <div class="section-panel">
      <div class="panel-header">{titleEl}</div>
      <div class="panel-body">
        {primary && <StatRow row={primary} chartOnly />}
      </div>
      <ShiftPanel shift={shift} />
      {shared.length > 0 && (
        <div class="panel-body shift-shared">
          {shared.map((row, i) => <StatRow key={i} row={row} />)}
        </div>
      )}
    </div>
  );
}

/** Dense table for scalar metrics: rows = metrics, columns = a value per run
 *  then the delta badge. Run names appear once as headers. Uses its own cell
 *  classes so it stays out of the global alignRunColumns width calc. */
function MatrixSection(
  { section, titleEl }:
  { section: ViewerSection; titleEl: preact.JSX.Element },
) {
  const runs = section.rows[0].entries;
  const style = { "--runs": String(runs.length) } as Record<string, string>;
  return (
    <div class="section-panel matrix-section">
      <div class="panel-header">{titleEl}</div>
      <div class="panel-body">
        <div class="matrix" style={style}>
          <span class="m-label" />
          {runs.map((run, i) => <span key={i} class="m-head">{run.runName}</span>)}
          <span class="m-head" />
          <span />
          {section.rows.map((row, i) => <MatrixRow key={i} row={row} />)}
        </div>
      </div>
    </div>
  );
}

/** One metric row: header plus per-run distribution charts. `shared` rows render
 *  label/value inline; `chartOnly` drops the per-run charts (shift sections). */
function StatRow(
  { row, estimateRange, chartOnly = false }:
  { row: ViewerRow; estimateRange?: [number, number]; chartOnly?: boolean },
) {
  if (row.shared) {
    // single value: keep label and value on one line instead of stacking
    return (
      <div class="stat-row shared-row">
        <span class="row-label">{row.label}</span>
        <span class="row-value">{row.entries[0]?.value}</span>
      </div>
    );
  }

  return (
    <div class={`stat-row${row.primary ? " primary-row" : ""}`}>
      <div class="row-header">
        <span class="row-label">{row.label}</span>
        {row.comparisonCI && <ComparisonBadge ci={row.comparisonCI} compact />}
      </div>
      {!chartOnly && row.entries.map((entry, i) => (
        <RunEntry key={i} entry={entry} estimateRange={estimateRange} />
      ))}
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

/** Always-visible per-percentile shift function below the section's stat rows,
 *  with a click-to-detail popup for any percentile. */
function ShiftPanel({ shift }: { shift: ShiftFunction }) {
  const [selected, setSelected] = useState<ShiftPercentile | null>(null);
  const ref = useLazyPlot(async () => {
    const { createShiftPlot } = await import("../plots/ShiftPlot.ts");
    return createShiftPlot(shift, { onSelect: p => setSelected(p) });
  }, [shift], "Shift plot");
  return (
    <div class="shift-panel">
      <div class="shift-caption" title="click a percentile for current vs baseline detail">
        change by percentile
      </div>
      <div class="shift-plot" ref={ref} title="click a percentile for current vs baseline detail" />
      {selected && (
        <ShiftPopup
          point={selected}
          metric={shift.metric}
          equivMargin={shift.equivMargin}
          onClose={() => setSelected(null)}
        />
      )}
    </div>
  );
}

/** One metric line in the matrix: label, a value per run, then the delta badge. */
function MatrixRow({ row }: { row: ViewerRow }) {
  return (
    <>
      <span class="m-label">{row.label}</span>
      {row.entries.map((entry, i) => <span key={i} class="m-val">{entry.value}</span>)}
      {row.comparisonCI
        ? <ComparisonBadge ci={row.comparisonCI} compact />
        : <span class="m-val" />}
      <span />
    </>
  );
}

/** One run's row: its name and either a distribution plot (shifted to position
 *  the estimate within estimateRange) or a plain value. */
function RunEntry(
  { entry, estimateRange }:
  { entry: ViewerEntry; estimateRange?: [number, number] },
) {
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

/** Modal detailing one percentile: the diff CI chart, then each run's absolute
 *  distribution. */
function ShiftPopup({ point, metric, equivMargin, onClose }: {
  point: ShiftPercentile;
  metric: string;
  equivMargin?: number;
  onClose: () => void;
}) {
  const { diff } = point;
  // Shared x-domain so the per-run absolute charts use one scale: equal pixel
  // positions mean equal values, making medians and CIs comparable across runs.
  const domain = runsDomain(point.runs);
  const unreliableNote = point.reliable
    ? null
    : <span class="shift-unreliable"> (unreliable, n={point.tailCount})</span>;
  return (
    <div class="shift-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div class="shift-popup">
        <span class="shift-close" onClick={onClose}>{"×"}</span>
        <div class="shift-popup-head">
          <h3>{metric} &middot; {point.label}{unreliableNote}</h3>
        </div>
        <ShiftPopupDiff ci={diff} equivMargin={equivMargin} />
        {point.runs.map((run, i) => (
          <ShiftPopupAbsolute key={i} runName={run.runName} ci={run.bootstrapCI} domain={domain} />
        ))}
      </div>
    </div>
  );
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

/** Min/max x across every run's histogram bins and CI bounds, for a shared scale. */
function runsDomain(runs: ShiftRun[]): [number, number] | undefined {
  const xs = runs.flatMap(r => [...r.bootstrapCI.histogram.map(b => b.x), ...r.bootstrapCI.ci]);
  if (xs.length < 2) return undefined;
  const min = Math.min(...xs), max = Math.max(...xs);
  return max > min ? [min, max] : undefined;
}

/** The diff CI chart in the popup (reuses createCIPlot). The Δ% point estimate
 *  is drawn as a bold label above the median line, not in the popup title. */
function ShiftPopupDiff({ ci, equivMargin }: { ci: DifferenceCI; equivMargin?: number }) {
  const ref = useLazyPlot(async () => {
    const { createCIPlot } = await import("../plots/CIPlot.ts");
    const opts = { width: 320, height: 90, title: "", pointLabel: formatPct(ci.percent), equivMargin };
    return createCIPlot(ci, opts);
  }, [ci], "Shift diff plot");
  return (
    <div class="shift-chart">
      <div class="shift-chart-label">difference</div>
      <div ref={ref} />
    </div>
  );
}

/** One run's absolute distribution in the popup (reuses createDistributionPlot).
 *  `domain` shares the x-scale across runs so positions are comparable. */
function ShiftPopupAbsolute(
  { runName, ci, domain }:
  { runName: string; ci: BootstrapCIData; domain?: [number, number] },
) {
  const ref = useLazyPlot(async () => {
    const { createDistributionPlot } = await import("../plots/CIPlot.ts");
    const opts = {
      width: 320, height: 90, title: "", direction: "uncertain" as const,
      ciLabels: ci.ciLabels, includeZero: false, smooth: true, pointLabel: ci.estimateLabel,
      ciLevel: ci.ciLevel, ciReliable: ci.ciReliable, domain,
    };
    return createDistributionPlot(ci.histogram, ci.ci, ci.estimate, opts);
  }, [ci, domain], "Shift absolute plot");
  return (
    <div class="shift-chart">
      <div class="shift-chart-label">{runName}</div>
      <div ref={ref} />
    </div>
  );
}
