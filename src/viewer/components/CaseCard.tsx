import { Fragment } from "preact";
import { useState } from "preact/hooks";
import type { DifferenceCI } from "../../stats/StatisticalUtils.ts";
import { formatCount, formatDecimalBytes } from "../LineData.ts";
import type {
  BenchmarkEntry,
  BenchmarkGroup,
  ShiftFunction,
  ViewerRow,
  ViewerSection,
} from "../ReportData.ts";
import { formatPct } from "../plots/PlotTypes.ts";
import { activeTabId, trimMode } from "../State.ts";
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
  const name = entry.isBaseline ? `${entry.runName} (baseline)` : entry.runName;
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

/** A scalar section as a track-columned table: metrics down the side, one value
 *  column per track and (toggleable) a Δ% column per comparison track. */
function ScalarSection({ section }: { section: ViewerSection }) {
  const tracks = section.rows[0]?.entries ?? [];
  const hasDelta = section.rows.some(r => r.entries.some(e => e.comparisonCI));
  const [showDelta, setShowDelta] = useState(true);
  const delta = showDelta && hasDelta;
  const cols = `max-content ${tracks.map(() => (delta ? "max-content max-content" : "max-content")).join(" ")}`;
  return (
    <div class="section-panel matrix-section">
      <div class="panel-header">
        <span>{section.title}</span>
        {hasDelta && (
          <button
            type="button"
            class={`toggle-pill mini${showDelta ? " active" : ""}`}
            onClick={() => setShowDelta(v => !v)}
          >
            Δ%
          </button>
        )}
      </div>
      <div class="panel-body">
        <div class="track-matrix" style={{ gridTemplateColumns: cols }}>
          <span class="m-label" />
          {tracks.map((t, i) => (
            <Fragment key={i}>
              <span class="m-head">{t.isBaseline ? `${t.runName} (base)` : t.runName}</span>
              {delta && <span class="m-head m-delta">{t.isBaseline ? "" : "Δ%"}</span>}
            </Fragment>
          ))}
          {section.rows.map((row, ri) => (
            <Fragment key={ri}>
              <span class="m-label">{row.label}</span>
              {row.entries.map((e, i) => (
                <Fragment key={i}>
                  <span class="m-val">{e.value}</span>
                  {delta && (
                    <span class="m-delta m-val">
                      {e.comparisonCI ? formatPct(e.comparisonCI.percent) : ""}
                    </span>
                  )}
                </Fragment>
              ))}
            </Fragment>
          ))}
        </div>
      </div>
    </div>
  );
}

/** A shared (case-constant) row, e.g. the line count: label and a single value. */
function SharedRow({ row }: { row: ViewerRow }) {
  return (
    <div class="stat-row shared-row">
      <span class="row-label">{row.label}</span>
      <span class="row-value">{row.entries[0]?.value}</span>
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

/** Footer strip: one row per footer section row, a single value when all tracks
 *  agree (e.g. runs identical across a case), else per-variant. */
function GroupFooter({ sections }: { sections: ViewerSection[] }) {
  const rows = sections.filter(s => s.placement === "footer").flatMap(s => s.rows);
  if (!rows.length) return null;
  return (
    <div class="group-footer">
      {rows.map((row, i) => <FooterStat key={i} row={row} />)}
    </div>
  );
}

function FooterStat({ row }: { row: ViewerRow }) {
  const vals = row.entries;
  const uniform = vals.every(v => v.value === vals[0]?.value);
  return (
    <div class="footer-stat">
      <span class="row-label">{row.label}</span>
      {uniform
        ? <span class="row-value">{vals[0]?.value}</span>
        : <span class="footer-per-variant">
            {vals.map((v, i) => <span key={i}>{v.runName} <b>{v.value}</b></span>)}
          </span>}
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
      <div class="panel-header"><span>calls</span></div>
      <div class="panel-body">
        <SharedStat label="functions tracked" value={cov.functionCount.toLocaleString()} />
        <SharedStat label="total calls" value={formatCount(cov.totalCalls)} />
      </div>
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
