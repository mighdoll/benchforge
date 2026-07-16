import { useEffect, useState } from "preact/hooks";
import { formatCliCommand } from "../../report/CliCommand.ts";
import type { GitVersion } from "../../report/GitUtils.ts";
import { formatRelativeTime } from "../DateFormat.ts";
import {
  type BenchmarkGroup,
  type ReportData,
  shiftMarginBand,
} from "../ReportData.ts";
import { provider, reportData, trimMode } from "../State.ts";
import { activeGroupView, CaseCard, caseHeaderCI } from "./CaseCard.tsx";
import { ComparisonBadge, shiftDetailOpener } from "./CIWidgets.tsx";
import { HelpButton } from "./HelpButton.tsx";
import { NotesPanel } from "./NotesPanel.tsx";
import { AbsoluteDetailPopup, ShiftDetailPopup } from "./ShiftPopup.tsx";

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
    dataProvider
      .fetchReportData()
      .then(result => (reportData.value = result as ReportData))
      .catch(err => {
        console.error("Report load failed:", err);
        setError(String(err));
      });
  }, [dataProvider]);

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

  return (
    <>
      <ReportHeader data={data} />
      <NotesPanel />
      <div class="report-body">
        {hasRawView(data) && (
          <div class="report-toolbar">
            <TrimToggle />
            <HelpButton topic="noiseRejection" />
          </div>
        )}
        {data.groups.map((group, i) => (
          <CollapsibleGroup key={i} group={group} />
        ))}
      </div>
      <ShiftDetailPopup />
      <AbsoluteDetailPopup />
    </>
  );
}

/** Report header: the reconstructed CLI command, run date, and git versions. */
function ReportHeader({ data }: { data: ReportData }) {
  const { metadata } = data;
  const { cliArgs, cliDefaults, currentVersion, baselineVersion } = metadata;
  const generated = new Date(metadata.timestamp).toLocaleString();
  const versions = [
    currentVersion && `Current: ${formatVersion(currentVersion)}`,
    baselineVersion && `Baseline: ${formatVersion(baselineVersion)}`,
  ].filter(Boolean);

  return (
    <div class="report-header">
      <div class="cli-args" title="The exact command that produced this report">
        {formatCliCommand(cliArgs, cliDefaults)}
      </div>
      <div class="header-right">
        <div class="metadata" title="When the report was generated">
          {generated}
        </div>
        <div class="metadata benchforge-version">{benchforgeLabel()}</div>
        {versions.length > 0 && (
          <div
            class="version-info"
            title="Git versions of the current build and the baseline it is compared against"
          >
            {versions.join(" | ")}
          </div>
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
      <div class="group-header">
        <span class="group-toggle" onClick={() => setOpen(o => !o)}>
          {open ? "▾" : "▸"}
        </span>
        <h2>{group.name}</h2>
        {header && (
          <ComparisonBadge
            ci={header.ci}
            onOpen={shiftDetailOpener(header.shift)}
            marginBand={shiftMarginBand(header.shift)}
            help
          />
        )}
        {group.warnings && (
          <span class="batch-warnings">
            {group.warnings.map((w, i) => (
              <span key={i} class="batch-warning">
                {w}
              </span>
            ))}
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
