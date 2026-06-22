import type {
  BenchmarkEntry,
  BenchmarkGroup,
  HotFunction,
  ProfileSummary,
  ReportData,
  ShiftFunction,
  ShiftPercentile,
  ViewerEntry,
  ViewerRow,
  ViewerSection,
} from "../viewer/ReportData.ts";
import { formatCliCommand } from "./CliCommand.ts";
import { entryValue } from "./ConsoleSummary.ts";
import {
  formatBytes,
  formatPercentCI,
  formatSignedPercent,
  frameLocation,
  integer,
  timeMs,
} from "./Formatters.ts";
import type { GcByBatchSummary, Spread } from "./GcByBatch.ts";
import { formatGitVersion, type GitVersion } from "./GitUtils.ts";
import { mdTable } from "./MarkdownTable.ts";
import { verdictWord } from "./Verdict.ts";
import type { WarmupShape } from "./WarmupShape.ts";

/** Render a ReportData as a self-contained markdown report for agents and other
 *  text consumers that cannot open the HTML viewer. Re-renders the shift-function
 *  data already on each case's metric row (mean + per-percentile diff CIs with
 *  reliability flags), so it adds no statistics of its own. */
export function markdownReport(data: ReportData): string {
  const { currentVersion, baselineVersion, cliArgs, cliDefaults } =
    data.metadata;
  const head = [
    "# Benchmark report",
    `\`${formatCliCommand(cliArgs, cliDefaults)}\``,
    versionLine(currentVersion, baselineVersion),
  ];
  const groups = data.groups.map(groupMarkdown).filter(Boolean);
  return [...head.filter(Boolean), ...groups].join("\n\n") + "\n";
}

/** A row's self-time per benchmark iteration (us), or the run total when the
 *  iteration count is unknown. */
export function selfPerIterUs(r: HotFunction, iterations?: number): number {
  return iterations && iterations > 0 ? r.selfUs / iterations : r.selfUs;
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
  const trackRows = section.rows.filter(r => !isRunsRow(r) && !r.shared);
  const sharedRows = section.rows.filter(r => r.shared && !isRunsRow(r));
  const table = trackTable(trackRows);
  const shared = sharedTable(sharedRows);
  return [...header, table, shared].filter((s): s is string => !!s);
}

/** Per-variant diagnostics (warmup shape, full GC by batch), labeled with the
 *  variant name when a case has more than one. */
function benchDiagnostics(entry: BenchmarkEntry, labeled: boolean): string[] {
  const warmup = entry.warmupShape
    ? warmupShapeMarkdown(entry.warmupShape)
    : [];
  const gc = entry.gcByBatch ? gcByBatchMarkdown(entry.gcByBatch) : [];
  const hot = entry.profileSummary
    ? hotFunctionsMarkdown(entry.profileSummary)
    : [];
  const parts = [...warmup, ...gc, ...hot];
  if (!parts.length) return [];
  return labeled ? [`### ${entry.name}`, ...parts] : parts;
}

/** The runs row is the shared "runs" count, lifted to case metadata. */
function isRunsRow(row: ViewerRow): boolean {
  return row.label === "runs" && !!row.shared;
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
  const body = usable.map(r => [r.label, ...r.entries.map(cell)]);
  return mdTable(head, body);
}

/** A two-column table for shared (case-constant) rows, e.g. the line count. */
function sharedTable(rows: ViewerRow[]): string | undefined {
  const usable = rows.filter(r => entryValue(r.entries[0]) !== undefined);
  if (!usable.length) return undefined;
  const body = usable.map(r => [r.label, entryValue(r.entries[0]) ?? ""]);
  return mdTable(["metric", "value"], body);
}

/** Time-by-position table: how much each batch's early iterations run above the
 *  plateau (the JIT/heap warmup ramp). Descriptive -- names the warmup region and
 *  the --warmup lever without recommending trimming, since the default includes
 *  warmup on purpose. */
function warmupShapeMarkdown(w: WarmupShape): string[] {
  const last = w.regions.length - 1;
  const rows = w.regions.map((r, i) => {
    const vs =
      i === last ? "plateau" : formatSignedPercent(r.pctVsPlateau * 100);
    return [r.label, timeMs(r.medianMs) ?? "", vs];
  });
  const note =
    "Early-region cost is JIT/heap warmup. The measured window includes it by " +
    "default; `--warmup N` runs N iterations before measurement to exclude it.";
  return [
    `#### time by region (per batch, ${w.batches} batches)`,
    mdTable(["region", "median", "vs plateau"], rows),
    note,
  ];
}

/** Per-batch full-GC diagnostic: how much full-collection cost and placement
 *  vary batch-to-batch, plus a post-GC cache-penalty probe. Rendered only when
 *  full GCs were observed (the framing is full collections). */
function gcByBatchMarkdown(gc: GcByBatchSummary): string[] {
  if (gc.fullGCs === 0) return [];
  const rows = [
    ["full GCs / batch", spreadCounts(gc.fullPerBatch)],
    ["full-GC pause", spreadTime(gc.fullPause)],
    ["bytes collected / full GC", spreadBytes(gc.fullCollected)],
    [
      "totals",
      `${gc.fullGCs} full, ${gc.scavenges} scavenge, ${gc.batches} batches`,
    ],
  ];
  const table = mdTable(["measure", "per batch / event"], rows);
  return ["#### full GC by batch", table];
}

/** Top CPU self-time functions from a `--profile` pass. When the run had a
 *  baseline, each row also carries `Δ vs base` (matched by name+file), so a
 *  regressed function reads as both hot and a large positive delta. The numbers
 *  come from a sampled pass, so the note frames the delta as the trustworthy
 *  figure (both sides are sampled symmetrically). */
function hotFunctionsMarkdown(s: ProfileSummary): string[] {
  if (!s.rows.length) return [];
  const withBase = s.rows.some(r => r.baseUs != null);
  const title = withBase
    ? "#### hot functions (self time, current vs baseline)"
    : "#### hot functions (self time, profiled pass)";
  const cols = withBase
    ? ["self/iter", "self%", "Δ% share (95% CI)", "function", "location"]
    : ["self/iter", "self%", "function", "location"];
  const rows = s.rows.map(r => hotCells(r, withBase, s.iterations));
  const table = mdTable(cols, rows);
  const note = withBase
    ? "Self time per benchmark iteration, pooled across all batches of a sampled pass (`--profile`). Δ is each function's change in self-time *share* vs baseline with a 95% bootstrap CI over batches (`new` = absent in baseline, `~` = too few batches; a CI spanning 0 = no clear change). Resolution is sampling-limited -- a hot function's CI bottoms out near +/-1/sqrt(ticks), so tighten it by spending more samples (a longer run or a finer `--profile-interval`), and use enough batches (>= ~10) for a stable interval; batch size barely matters at a fixed budget. Self-time also shifts with JIT/inlining and module-load paths between builds, so read Δ as a hint."
    : "Self time per benchmark iteration, pooled across all batches of a sampled pass (`--profile`); the absolute times are lightly perturbed by sampling.";
  return [title, table, note];
}

/** Per-percentile diff table: mean first, then percentiles in displayed order.
 *  Δ% is current relative to baseline in the metric's own units; the verdict
 *  column carries the good/bad reading (it accounts for metric direction). */
function shiftTable(shift: ShiftFunction, label?: string): string {
  const prefix = label ? `${label}: ` : "";
  const title = `${prefix}${shift.metric} (Δ% vs baseline)`;
  const cols = ["stat", "current", "baseline", "Δ%", "95% CI", "verdict"];
  const table = mdTable(cols, shift.points.map(pointRow));
  return `${title}\n${table}`;
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

/** One hot-function row's cells: self time per iteration, self %, optional Δ,
 *  name, location. */
function hotCells(
  r: HotFunction,
  withBase: boolean,
  iterations?: number,
): string[] {
  const self = timeMs(selfPerIterUs(r, iterations) / 1000) ?? "";
  const pct = `${r.selfPct.toFixed(1)}%`;
  const head = [self, pct];
  const tail = [r.name || "(anonymous)", frameLocation(r.url, r.line)];
  if (!withBase) return [...head, ...tail];
  return [...head, hotDelta(r), ...tail];
}

/** One shift point as a row of cells. runs[0] is current, runs[1] is baseline. */
function pointRow(point: ShiftPercentile): string[] {
  const { diff, runs, label, reliable, tailCount } = point;
  const cur = runs[0]?.bootstrapCI.estimateLabel ?? "";
  const base = runs[1]?.bootstrapCI.estimateLabel ?? "";
  const word = verdictWord(diff.direction);
  const verdict = reliable ? word : `${word} (unreliable, n=${tailCount})`;
  return [
    label,
    cur,
    base,
    formatSignedPercent(diff.percent),
    formatPercentCI(diff.ci),
    verdict,
  ];
}

/** The Δ cell: the share change with its 95% CI when there were enough batches to
 *  form one, `~` when the function matched the baseline but had too few batches,
 *  `new` when it had no baseline match at all. */
function hotDelta(r: HotFunction): string {
  if (r.deltaPct != null && r.deltaCI)
    return `${formatSignedPercent(r.deltaPct)} ${formatPercentCI(r.deltaCI)}`;
  return r.baseUs != null ? "~" : "new";
}
