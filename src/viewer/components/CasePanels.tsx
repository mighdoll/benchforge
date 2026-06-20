import { Fragment } from "preact";
import { useState } from "preact/hooks";
import { baselineLabel, formatSignedPercent } from "../../report/Formatters.ts";
import { formatCount, formatDecimalBytes } from "../LineData.ts";
import type {
  BenchmarkEntry,
  ViewerRow,
  ViewerSection,
} from "../ReportData.ts";
import { activeTabId } from "../State.ts";

/** A scalar section as a track-columned table: metrics down the side, one value
 *  column per track and (toggleable) a Δ% column per comparison track. */
export function ScalarSection({ section }: { section: ViewerSection }) {
  const tracks = section.rows[0]?.entries ?? [];
  const hasDelta = section.rows.some(r => r.entries.some(e => e.comparisonCI));
  const [showDelta, setShowDelta] = useState(true);
  const delta = showDelta && hasDelta;
  const trackCols = delta ? "max-content max-content" : "max-content";
  const cols = `max-content ${tracks.map(() => trackCols).join(" ")}`;
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
              <span class="m-head">{t.isBaseline ? baselineLabel(t.runName) : t.runName}</span>
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
                      {e.comparisonCI ? formatSignedPercent(e.comparisonCI.percent) : ""}
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
export function SharedRow({ row }: { row: ViewerRow }) {
  return <SharedStat label={row.label} value={row.entries[0]?.value ?? ""} />;
}

/** Footer strip: one row per footer section row, a single value when all tracks
 *  agree (e.g. runs identical across a case), else per-variant. */
export function GroupFooter({ sections }: { sections: ViewerSection[] }) {
  const rows = sections.filter(s => s.placement === "footer").flatMap(s => s.rows);
  if (!rows.length) return null;
  return (
    <div class="group-footer">
      {rows.map((row, i) => <FooterStat key={i} row={row} />)}
    </div>
  );
}

export function HeapPanel({ entry }: { entry: BenchmarkEntry }) {
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

export function CoveragePanel({ entry }: { entry: BenchmarkEntry }) {
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

function SharedStat({ label, value }: { label: string; value: string }) {
  return (
    <div class="stat-row shared-row">
      <span class="row-label">{label}</span>
      <span class="row-value">{value}</span>
    </div>
  );
}
