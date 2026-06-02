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
import { formatSignedPercent } from "./Formatters.ts";
import { formatGitVersion, type GitVersion } from "./GitUtils.ts";
import { verdictWord } from "./Verdict.ts";

/** Render a ReportData as a self-contained markdown report for agents and other
 *  text consumers that cannot open the HTML viewer. Re-renders the shift-function
 *  data already on each section's primary row (mean + per-percentile diff CIs with
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

/** One group as a `##` section, with each benchmark below it. */
function groupMarkdown(group: BenchmarkGroup): string {
  const benches = group.benchmarks.map(benchmarkMarkdown).filter(Boolean);
  if (!benches.length) return "";
  const warnings = group.warnings?.map(w => `> ${w}`).join("\n") ?? "";
  return [`## ${group.name}`, warnings, ...benches]
    .filter(Boolean)
    .join("\n\n");
}

/** One benchmark as a `###` section: a leading metadata line (runs), then a
 *  shift table per comparable section, then any remaining scalar sections. */
function benchmarkMarkdown(entry: BenchmarkEntry): string {
  const sections = entry.sections ?? [];
  const runs = findRunsValue(sections);
  const meta = runs ? [`runs: ${runs}`] : [];
  const parts = sections.flatMap(s => sectionMarkdown(s));
  if (!parts.length && !meta.length) return "";
  return [`### ${entry.name}`, ...meta, ...parts].join("\n\n");
}

/** A section's markdown: the shift table if its primary row carries a shift
 *  function (followed by any shared rows, e.g. line counts, as the HTML does),
 *  otherwise a current-vs-baseline scalar table. The runs row is lifted to the
 *  benchmark metadata line, so it is skipped here; empty-title runs-only
 *  sections then render nothing. */
function sectionMarkdown(section: ViewerSection): string[] {
  const header = section.title ? [`#### ${section.title}`] : [];
  const shift = section.rows.find(r => r.shiftFunction)?.shiftFunction;
  if (shift) {
    const shared = scalarTable(section.rows.filter(r => r.shared));
    return [...header, shiftTable(shift), ...(shared ? [shared] : [])];
  }

  const rows = section.rows.filter(r => !isRunsRow(r));
  const table = scalarTable(rows);
  if (!table) return [];
  return [...header, table];
}

/** Per-percentile diff table: mean first, then percentiles in displayed order.
 *  Δ% is current relative to baseline in the metric's own units; the verdict
 *  column carries the good/bad reading (it accounts for metric direction). */
function shiftTable(shift: ShiftFunction): string {
  const header = "| stat | current | baseline | Δ% | 95% CI | verdict |";
  const sep = "|---|---|---|---|---|---|";
  const rows = shift.points.map(pointRow);
  return [`${shift.metric} (Δ% vs baseline)`, header, sep, ...rows].join("\n");
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

/** A current-vs-baseline table for scalar sections (GC, line counts). When no
 *  row has a baseline, drops the baseline/Δ% columns. Returns undefined when
 *  there is nothing displayable. */
function scalarTable(rows: ViewerRow[]): string | undefined {
  const usable = rows.filter(r => entryValue(r.entries[0]) !== undefined);
  if (!usable.length) return undefined;
  const hasBaseline = usable.some(r => r.entries.length > 1);

  if (!hasBaseline) {
    const header = "| metric | value |\n|---|---|";
    const body = usable.map(
      r => `| ${r.label} | ${entryValue(r.entries[0])} |`,
    );
    return [header, ...body].join("\n");
  }

  const header = "| metric | current | baseline | Δ% |\n|---|---|---|---|";
  const body = usable.map(r => {
    const cur = entryValue(r.entries[0]) ?? "";
    const base = entryValue(r.entries[1]) ?? "";
    const pct = r.comparisonCI
      ? formatSignedPercent(r.comparisonCI.percent)
      : "";
    return `| ${r.label} | ${cur} | ${base} | ${pct} |`;
  });
  return [header, ...body].join("\n");
}

/** An entry's display value: its bootstrap estimate when present, else its
 *  plain value. */
function entryValue(entry?: ViewerEntry): string | undefined {
  if (!entry) return undefined;
  return entry.bootstrapCI?.estimateLabel ?? entry.value;
}

/** @return the runs count from the runs row (current run), if any. */
function findRunsValue(sections: ViewerSection[]): string | undefined {
  for (const section of sections) {
    const row = section.rows.find(isRunsRow);
    if (row) return entryValue(row.entries[0]);
  }
  return undefined;
}

/** The runs row is the shared "runs" count, lifted to benchmark metadata. */
function isRunsRow(row: ViewerRow): boolean {
  return row.label === "runs" && !!row.shared;
}
