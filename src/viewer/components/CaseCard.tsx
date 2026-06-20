import { baselineLabel } from "../../report/Formatters.ts";
import type { DifferenceCI } from "../../stats/Bootstrap.ts";
import type {
  BenchmarkGroup,
  ShiftFunction,
  ViewerRow,
  ViewerSection,
} from "../ReportData.ts";
import { trimMode } from "../State.ts";
import {
  CoveragePanel,
  GroupFooter,
  HeapPanel,
  ScalarSection,
  SharedRow,
} from "./CasePanels.tsx";
import {
  BootstrapCIMount,
  ciDomain,
  openShiftDetail,
  shiftDetailOpener,
} from "./CIWidgets.tsx";
import { useResponsivePlot } from "./LazyPlot.ts";

/** The trimmed or raw case-level sections, per the current trim mode. */
export function activeGroupView(
  group: BenchmarkGroup,
): ViewerSection[] | undefined {
  if (trimMode.value === "raw" && group.rawSections) return group.rawSections;
  return group.sections;
}

/** The case's verdict CI for the header, only when exactly one comparison track
 *  exists; with several, the per-row deltas carry the verdicts instead. */
export function caseHeaderCI(
  sections: ViewerSection[] | undefined,
): { ci: DifferenceCI; shift?: ShiftFunction } | undefined {
  const primary = sections?.flatMap(s => s.rows).find(r => r.primary);
  const comps = primary?.entries.filter(e => e.comparisonCI) ?? [];
  if (comps.length !== 1) return undefined;
  return { ci: comps[0].comparisonCI!, shift: comps[0].shiftFunction };
}

/** A case's consolidated panels: the metric sparkline table + violins, then one
 *  track-columned table per scalar section, then per-variant heap/coverage and
 *  the footer strip. */
export function CaseCard({ group }: { group: BenchmarkGroup }) {
  const sections = activeGroupView(group) ?? [];
  const metric = sections.find(s => s.rows.some(r => r.primary));
  const scalars = sections.filter(
    s => s !== metric && s.placement !== "footer",
  );
  return (
    <>
      <div class="panel-grid">
        {metric && <MetricSection section={metric} />}
        {scalars.map((s, i) => <ScalarSection key={i} section={s} />)}
        {group.benchmarks.map((b, i) => <HeapPanel key={`h${i}`} entry={b} />)}
        {group.benchmarks.map((b, i) => <CoveragePanel key={`c${i}`} entry={b} />)}
      </div>
      <GroupFooter sections={sections} />
    </>
  );
}

/** The metric section: a shared-x sparkline table (one row per track, absolute
 *  value + distribution + Δ%), the per-comparison violins, then shared rows. */
function MetricSection({ section }: { section: ViewerSection }) {
  const primary = section.rows.find(r => r.primary);
  const shared = section.rows.filter(r => r.shared);
  if (!primary) return null;
  const { entries } = primary;
  const domain = ciDomain(entries.flatMap(e => (e.bootstrapCI ? [e.bootstrapCI] : [])));
  const violins = entries.filter(e => e.shiftFunction);
  return (
    <div class="section-panel primary-section">
      <div class="panel-header"><span>{section.title}</span></div>
      <div class="sparkline-table">
        {entries.map((entry, i) => (
          <SparklineRow key={i} entry={entry} domain={domain} />
        ))}
      </div>
      {violins.map((e, i) => (
        <ShiftPanel
          key={i}
          shift={e.shiftFunction!}
          label={violins.length > 1 ? e.runName : undefined}
        />
      ))}
      {shared.length > 0 && (
        <div class="panel-body shift-shared">
          {shared.map((row, i) => <SharedRow key={i} row={row} />)}
        </div>
      )}
    </div>
  );
}

/** One track's sparkline row: name and the absolute distribution (its point
 *  label is the value). The Δ% lives on the violin's verdict point (and, for a
 *  single comparison, the header); clicking the distribution opens the modal. */
function SparklineRow(
  { entry, domain }:
  { entry: ViewerRow["entries"][number]; domain?: [number, number] },
) {
  const onOpen = shiftDetailOpener(entry.shiftFunction);
  const name = entry.isBaseline ? baselineLabel(entry.runName) : entry.runName;
  return (
    <div class="sparkline-row">
      <span class="run-name">{name}</span>
      {entry.bootstrapCI
        ? <div
            class={`sparkline-cell${onOpen ? " ci-clickable" : ""}`}
            title={onOpen ? "click for current vs baseline detail" : undefined}
            onClick={onOpen}
          >
            <BootstrapCIMount ci={entry.bootstrapCI} label={entry.value} domain={domain} />
          </div>
        : <span class="run-value">{entry.value}</span>}
    </div>
  );
}

/** Always-visible per-percentile shift function below the sparkline table.
 *  Clicking any violin opens the shared detail popup for that percentile. */
function ShiftPanel({ shift, label }: { shift: ShiftFunction; label?: string }) {
  const ref = useResponsivePlot(async width => {
    const { createShiftPlot } = await import("../plots/ShiftPlot.ts");
    return createShiftPlot(shift, { width, onSelect: p => openShiftDetail(shift, p) });
  }, [shift], "Shift plot");
  return (
    <div class="shift-panel">
      <div class="shift-caption" title="click a percentile for current vs baseline detail">
        change by percentile{label ? ` · ${label}` : ""}
      </div>
      <div class="shift-plot" ref={ref} title="click a percentile for current vs baseline detail" />
    </div>
  );
}

