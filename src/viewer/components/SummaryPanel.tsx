import { useEffect, useState } from "preact/hooks";
import type { GitVersion } from "../../report/GitUtils.ts";
import { verdictWord } from "../../report/Verdict.ts";
import type { DifferenceCI } from "../../stats/StatisticalUtils.ts";
import { formatRelativeTime } from "../DateFormat.ts";
import type {
  BenchmarkGroup,
  BootstrapCIData,
  ReportData,
  ShiftPercentile,
} from "../ReportData.ts";
import { formatPct } from "../plots/PlotTypes.ts";
import { provider, reportData, shiftDetail, trimMode } from "../State.ts";
import { activeGroupView, CaseCard, caseHeaderCI } from "./CaseCard.tsx";
import {
  ciDomain,
  ComparisonBadge,
  distributionOpts,
  shiftDetailOpener,
} from "./CIWidgets.tsx";
import { useLazyPlot } from "./LazyPlot.ts";

const skipArgs = new Set(["_", "$0", "view", "file"]);

declare const __BENCHFORGE_GIT_HASH__: string;
declare const __BENCHFORGE_GIT_DIRTY__: boolean;
declare const __BENCHFORGE_BUILD_DATE__: string;

/** Main summary view: fetches report data, shows CLI args header and collapsible
 *  benchmark groups (one consolidated card per case). */
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
      <ShiftDetailPopup />
    </>
  );
}

/** The single shared shift-detail popup, opened from any CI chart or violin. */
function ShiftDetailPopup() {
  const detail = shiftDetail.value;
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") shiftDetail.value = null;
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  if (!detail) return null;
  return (
    <ShiftPopup
      point={detail.point}
      metric={detail.metric}
      equivMargin={detail.equivMargin}
      onClose={() => (shiftDetail.value = null)}
    />
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

/** True if any case in the report carries an alternate (raw) view. */
function hasRawView(data: ReportData): boolean {
  return data.groups.some(g => !!g.rawSections);
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

/** Expandable case card: the case name, its verdict badge (only with a single
 *  comparison; otherwise the per-row deltas carry verdicts), and the
 *  consolidated panels. */
function CollapsibleGroup({ group }: { group: BenchmarkGroup }) {
  const [open, setOpen] = useState(true);
  if (!group.benchmarks?.length)
    return <div class="error">No benchmark data for this group</div>;

  const header = caseHeaderCI(activeGroupView(group));
  return (
    <div class="benchmark-group">
      <div class="group-header" onClick={() => setOpen(o => !o)}>
        <span class="group-toggle">{open ? "▾" : "▸"}</span>
        <h2>{group.name}</h2>
        {header && (
          <ComparisonBadge ci={header.ci} onOpen={shiftDetailOpener(header.shift)} />
        )}
        {group.warnings && (
          <span class="batch-warnings">
            {group.warnings.map((w, i) => <span key={i} class="batch-warning">{w}</span>)}
          </span>
        )}
      </div>
      {open && <CaseCard group={group} />}
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

/** Fallback for dev/unbundled builds where compile-time globals are absent. */
function safeGlobal<T>(v: T, fallback: T): T {
  return typeof v !== "undefined" ? v : fallback;
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
  const domain = ciDomain(point.runs.map(r => r.bootstrapCI));
  return (
    <div class="shift-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div class="shift-popup">
        <span class="shift-close" onClick={onClose}>{"×"}</span>
        <div class="shift-popup-head">
          <h3>{metric} &middot; {point.label}</h3>
          <ShiftVerdict point={point} />
        </div>
        <div class="shift-charts">
          <ShiftPopupDiff ci={diff} equivMargin={equivMargin} />
          {point.runs.map((run, i) => (
            <ShiftPopupAbsolute key={i} runName={run.runName} ci={run.bootstrapCI} domain={domain} />
          ))}
        </div>
      </div>
    </div>
  );
}

/** Capitalize the first letter (verdict words are lowercase). */
function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Popup-title verdict chip. Unreliable percentiles report insufficient data
 *  instead of a verdict (the direction is untrustworthy with too few samples). */
function ShiftVerdict({ point }: { point: ShiftPercentile }) {
  if (!point.reliable)
    return (
      <span class="badge badge-insufficient">Insufficient data &middot; n={point.tailCount}</span>
    );
  const { direction, percent } = point.diff;
  return (
    <span class="shift-verdict">
      <span class={`badge badge-${direction}`}>{cap(verdictWord(direction))}</span>
      <span class="shift-verdict-pct">{formatPct(percent)}</span>
    </span>
  );
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
    const opts = distributionOpts(ci, {
      width: 320, height: 90, pointLabel: ci.estimateLabel, domain,
    });
    return createDistributionPlot(ci.histogram, ci.ci, ci.estimate, opts);
  }, [ci, domain], "Shift absolute plot");
  return (
    <div class="shift-chart">
      <div class="shift-chart-label">{runName}</div>
      <div ref={ref} />
    </div>
  );
}
