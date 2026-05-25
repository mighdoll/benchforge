import type { DifferenceCI } from "../../stats/StatisticalUtils.ts";
import {
  isBootstrappable,
  trimOutlierBatches,
} from "../../stats/StatisticalUtils.ts";
import {
  type BenchmarkReport,
  type ComparisonOptions,
  computeDiffCI,
  extractSectionValues,
  findPrimaryCIColumn,
  isHigherIsBetter,
  type ReportColumn,
  type ReportGroup,
  type ReportSection,
} from "../BenchmarkReport.ts";
import { formatDiffWithCI, truncate } from "../Formatters.ts";
import {
  buildTable,
  type ColumnGroup,
  type ResultGroup,
} from "./TableReport.ts";

/** Options for text report rendering, including baseline comparison settings. */
export interface TextReportOptions extends ComparisonOptions {}

type Row = Record<string, unknown> & { name: string; diffCI?: DifferenceCI };

/** Build a formatted text table from benchmark groups, with baseline diff columns when present. */
export function reportResults(
  groups: ReportGroup[],
  sections: ReportSection[],
  options?: TextReportOptions,
): string {
  const primary = findPrimaryCIColumn(sections);
  const results = groups.map(g =>
    resultGroupValues(g, sections, primary, options),
  );
  const hasBaseline = results.some(g => g.baseline);
  const table = buildTable(sectionColumnGroups(sections, hasBaseline), results);
  const hasSampleCI = results.some(g =>
    g.results.some(r => r.diffCI?.ciLevel === "sample"),
  );
  if (!hasSampleCI) return table;
  return (
    table +
    "\n* Confidence intervals may be too narrow (single batch)." +
    " Use --batches for more accurate intervals.\n"
  );
}

/** Extract stats from all sections into row objects for each report. */
export function valuesForReports(
  reports: BenchmarkReport[],
  sections: ReportSection[],
): Row[] {
  return reports.map(r => ({
    name: truncate(r.name),
    ...extractSectionValues(r.measuredResults, sections, r.metadata),
  }));
}

/** Insert a "delta% CI" column after the first comparable column. */
export function injectDiffColumns(
  groups: ColumnGroup<Row>[],
): ColumnGroup<Row>[] {
  const asSections = groups.map(g => ({
    title: g.groupTitle ?? "",
    columns: g.columns as ReportColumn[],
  }));
  const higher = isHigherIsBetter(asSections);
  const fmt = (v: unknown) => formatDiffWithCI(v, higher);
  const ciCol = { title: "Δ% CI", key: "diffCI" as keyof Row, formatter: fmt };

  const allColumns = groups.flatMap(g => g.columns);
  const anchor = allColumns.find(c => {
    const rc = c as ReportColumn;
    return rc.comparable && rc.statKind && isBootstrappable(rc.statKind);
  });
  if (!anchor) return groups;

  return groups.map(group => ({
    groupTitle: group.groupTitle,
    columns: group.columns.flatMap(col =>
      col === anchor ? [col, ciCol] : [col],
    ),
  }));
}

/** Build table columns from sections, with name column and optional CI diff columns. */
export function sectionColumnGroups(
  sections: ReportSection[],
  hasBaseline: boolean,
  nameTitle = "name",
): ColumnGroup<Row>[] {
  const nameCol = { columns: [{ key: "name" as keyof Row, title: nameTitle }] };
  const groups: ColumnGroup<Row>[] = sections.map(s => ({
    groupTitle: s.title || undefined,
    columns: s.columns.map(c => ({
      ...c,
      key: (c.key ?? c.title) as keyof Row,
    })),
  }));
  const cols = hasBaseline ? injectDiffColumns(groups) : groups;
  return [nameCol, ...cols];
}

/** Extract section stats and bootstrap CI diffs for all reports in a group.
 *  Display values come from the same sample set used by the comparison CI:
 *  Tukey-trimmed when comparison trimming is on (default), raw otherwise. */
function resultGroupValues(
  group: ReportGroup,
  sections: ReportSection[],
  primary?: ReportColumn,
  options?: TextReportOptions,
): ResultGroup<Row> {
  const { reports, baseline } = group;
  const baseMeasured = baseline?.measuredResults;
  const { statKind } = primary ?? {};
  const noTrim = options?.noBatchTrim;
  const baseSamples = baseMeasured
    ? trimOutlierBatches(
        baseMeasured.samples,
        baseMeasured.batchOffsets,
        noTrim,
      ).samples
    : undefined;
  const results = reports.map(r => {
    const { measuredResults, metadata } = r;
    const diffCI = statKind
      ? computeDiffCI(baseMeasured, measuredResults, statKind, options)
      : undefined;
    const curSamples = trimOutlierBatches(
      measuredResults.samples,
      measuredResults.batchOffsets,
      noTrim,
    ).samples;
    const values = extractSectionValues(
      measuredResults,
      sections,
      metadata,
      curSamples,
    );
    return { name: truncate(r.name), ...values, ...(diffCI && { diffCI }) };
  });
  const baseRow =
    baseline &&
    baseMeasured &&
    ({
      name: truncate(baseline.name),
      ...extractSectionValues(
        baseMeasured,
        sections,
        baseline.metadata,
        baseSamples,
      ),
    } as Row);
  return { results, baseline: baseRow };
}
