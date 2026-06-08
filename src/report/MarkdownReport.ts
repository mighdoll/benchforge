import type {
  BenchmarkEntry,
  BenchmarkGroup,
  ReportData,
  ShiftFunction,
  ShiftPercentile,
  ViewerEntry,
  ViewerRow,
  ViewerSection,
} from "../viewer/ReportData.ts";
import {
  formatBytes,
  formatSignedPercent,
  integer,
  timeMs,
} from "./Formatters.ts";
import type { GcByBatchSummary, Spread } from "./GcByBatch.ts";
import { formatGitVersion, type GitVersion } from "./GitUtils.ts";
import { verdictWord } from "./Verdict.ts";
import type { WarmupShape } from "./WarmupShape.ts";

/** Render a ReportData as a self-contained markdown report for agents and other
 *  text consumers that cannot open the HTML viewer. Re-renders the shift-function
 *  data already on each case's metric row (mean + per-percentile diff CIs with
 *  reliability flags), so it adds no statistics of its own. */
export function markdownReport(data: ReportData): string {
  const { currentVersion, baselineVersion } = data.metadata;
  const head = [
    "# Benchmark report",
    versionLine(currentVersion, baselineVersion),
  ];
  const groups = data.groups.map(groupMarkdown).filter(Boolean);
  return [...head.filter(Boolean), ...groups].join("\n\n") + "\n";
}

function versionLine(current?: GitVersion, baseline?: GitVersion): string {
  const cur = current ? formatGitVersion(current) : undefined;
  const base = baseline ? formatGitVersion(baseline) : undefined;
  if (cur && base) return `current \`${cur}\` vs baseline \`${base}\``;
  if (cur) return `current \`${cur}\``;
  return "";
}

/** One case as a `##` section: a leading metadata line (runs), the case-level
 *  track-columned sections, then per-variant diagnostics. */
function groupMarkdown(group: BenchmarkGroup): string {
  const sections = group.sections ?? [];
  const runs = findRunsValue(sections);
  const meta = runs ? [`runs: ${runs}`] : [];
  const warnings = group.warnings?.map(w => `> ${w}`).join("\n") ?? "";
  const parts = sections.flatMap(sectionMarkdown);
  const labeled = group.benchmarks.length > 1;
  const diags = group.benchmarks.flatMap(b => benchDiagnostics(b, labeled));
  const body = [warnings, ...meta, ...parts, ...diags].filter(Boolean);
  if (!body.length) return "";
  return [`## ${group.name}`, ...body].join("\n\n");
}

/** @return the runs count from the runs row (first track), if any. */
function findRunsValue(sections: ViewerSection[]): string | undefined {
  const runsRow = sections.flatMap(s => s.rows).find(isRunsRow);
  return runsRow ? entryValue(runsRow.entries[0]) : undefined;
}

/** A section's markdown: a metric section renders one shift table per comparison
 *  track (plus shared rows); a scalar section renders one track-columned table. */
function sectionMarkdown(section: ViewerSection): string[] {
  const header = section.title ? [`#### ${section.title}`] : [];
  const primary = section.rows.find(r => r.primary);
  if (primary) {
    const shifts = shiftTables(primary);
    const tables = shifts.length ? shifts : [trackTable([primary])];
    const shared = sharedTable(section.rows.filter(r => r.shared));
    return [...header, ...tables, shared].filter((s): s is string => !!s);
  }
  const table = trackTable(
    section.rows.filter(r => !isRunsRow(r) && !r.shared),
  );
  const shared = sharedTable(
    section.rows.filter(r => r.shared && !isRunsRow(r)),
  );
  return [...header, table, shared].filter((s): s is string => !!s);
}

/** Per-variant diagnostics (warmup shape, full GC by batch), labeled with the
 *  variant name when a case has more than one. */
function benchDiagnostics(entry: BenchmarkEntry, labeled: boolean): string[] {
  const warmup = entry.warmupShape
    ? warmupShapeMarkdown(entry.warmupShape)
    : [];
  const gc = entry.gcByBatch ? gcByBatchMarkdown(entry.gcByBatch) : [];
  const parts = [...warmup, ...gc];
  if (!parts.length) return [];
  return labeled ? [`### ${entry.name}`, ...parts] : parts;
}

/** The runs row is the shared "runs" count, lifted to case metadata. */
function isRunsRow(row: ViewerRow): boolean {
  return row.label === "runs" && !!row.shared;
}

/** An entry's display value: its bootstrap estimate when present, else its
 *  plain value. */
function entryValue(entry?: ViewerEntry): string | undefined {
  if (!entry) return undefined;
  return entry.bootstrapCI?.estimateLabel ?? entry.value;
}

/** One shift table per comparison track; labeled by track only when there are
 *  several comparisons in the case. */
function shiftTables(primary: ViewerRow): string[] {
  const comparisons = primary.entries.filter(e => e.shiftFunction);
  const label = comparisons.length > 1;
  return comparisons.map(e =>
    shiftTable(e.shiftFunction!, label ? e.runName : undefined),
  );
}

/** A track-columned table: one column per track, the metric label first.
 *  Comparison cells append their Δ% when present. */
function trackTable(rows: ViewerRow[]): string | undefined {
  const usable = rows.filter(r => r.entries.some(e => entryValue(e)));
  if (!usable.length) return undefined;
  const head = ["metric", ...usable[0].entries.map(e => e.runName)];
  const sep = head.map(() => "---");
  const body = usable.map(
    r => `| ${[r.label, ...r.entries.map(cell)].join(" | ")} |`,
  );
  return [`| ${head.join(" | ")} |`, `| ${sep.join(" | ")} |`, ...body].join(
    "\n",
  );
}

/** A two-column table for shared (case-constant) rows, e.g. the line count. */
function sharedTable(rows: ViewerRow[]): string | undefined {
  const usable = rows.filter(r => entryValue(r.entries[0]) !== undefined);
  if (!usable.length) return undefined;
  const body = usable.map(r => `| ${r.label} | ${entryValue(r.entries[0])} |`);
  return ["| metric | value |", "|---|---|", ...body].join("\n");
}

/** Time-by-position table: how much each batch's early iterations run above the
 *  plateau (the JIT/heap warmup ramp). Descriptive -- names the warmup region and
 *  the --warmup lever without recommending trimming, since the default includes
 *  warmup on purpose. */
function warmupShapeMarkdown(w: WarmupShape): string[] {
  const header = "| region | median | vs plateau |\n|---|---|---|";
  const last = w.regions.length - 1;
  const rows = w.regions.map((r, i) => {
    const vs =
      i === last ? "plateau" : formatSignedPercent(r.pctVsPlateau * 100);
    return `| ${r.label} | ${timeMs(r.medianMs)} | ${vs} |`;
  });
  const note =
    "Early-region cost is JIT/heap warmup. The measured window includes it by " +
    "default; `--warmup N` runs N iterations before measurement to exclude it.";
  return [
    `#### time by region (per batch, ${w.batches} batches)`,
    [header, ...rows].join("\n"),
    note,
  ];
}

/** Per-batch full-GC diagnostic: how much full-collection cost and placement
 *  vary batch-to-batch, plus a post-GC cache-penalty probe. Rendered only when
 *  full GCs were observed (the framing is full collections). */
function gcByBatchMarkdown(gc: GcByBatchSummary): string[] {
  if (gc.fullGCs === 0) return [];
  const header = "| measure | per batch / event |\n|---|---|";
  const rows = [
    `| full GCs / batch | ${spreadCounts(gc.fullPerBatch)} |`,
    `| full-GC pause | ${spreadTime(gc.fullPause)} |`,
    `| bytes collected / full GC | ${spreadBytes(gc.fullCollected)} |`,
    `| totals | ${gc.fullGCs} full, ${gc.scavenges} scavenge, ${gc.batches} batches |`,
  ];
  return ["#### full GC by batch", [header, ...rows].join("\n")];
}

/** Per-percentile diff table: mean first, then percentiles in displayed order.
 *  Δ% is current relative to baseline in the metric's own units; the verdict
 *  column carries the good/bad reading (it accounts for metric direction). */
function shiftTable(shift: ShiftFunction, label?: string): string {
  const prefix = label ? `${label}: ` : "";
  const title = `${prefix}${shift.metric} (Δ% vs baseline)`;
  const header = "| stat | current | baseline | Δ% | 95% CI | verdict |";
  const sep = "|---|---|---|---|---|---|";
  const rows = shift.points.map(pointRow);
  return [title, header, sep, ...rows].join("\n");
}

/** One track cell: its value, with the Δ% appended on comparison tracks. */
function cell(e: ViewerEntry): string {
  const v = entryValue(e) ?? "";
  if (e.comparisonCI && !e.isBaseline)
    return `${v} (${formatSignedPercent(e.comparisonCI.percent)})`;
  return v;
}

/** A count spread as "min..max (mean N)". */
function spreadCounts(s: Spread): string {
  const range = s.min === s.max ? `${s.min}` : `${s.min}..${s.max}`;
  return `${range} (mean ${s.mean.toFixed(1)})`;
}

/** A time spread as "min..max (mean, CV%)". */
function spreadTime(s: Spread): string {
  return `${timeMs(s.min)}..${timeMs(s.max)} (mean ${timeMs(s.mean)}, CV ${integer(s.cv * 100)}%)`;
}

/** A byte spread as "min..max (mean, CV%)". */
function spreadBytes(s: Spread): string {
  return `${formatBytes(s.min)}..${formatBytes(s.max)} (mean ${formatBytes(s.mean)}, CV ${integer(s.cv * 100)}%)`;
}

/** One shift point as a table row. runs[0] is current, runs[1] is baseline. */
function pointRow(point: ShiftPercentile): string {
  const { diff, runs, label, reliable, tailCount } = point;
  const cur = runs[0]?.bootstrapCI.estimateLabel ?? "";
  const base = runs[1]?.bootstrapCI.estimateLabel ?? "";
  const [lo, hi] = diff.ci.map(formatSignedPercent);
  const word = verdictWord(diff.direction);
  const verdict = reliable ? word : `${word} (unreliable, n=${tailCount})`;
  return `| ${label} | ${cur} | ${base} | ${formatSignedPercent(diff.percent)} | [${lo}, ${hi}] | ${verdict} |`;
}
