import {
  type BenchmarkReport,
  type ComparisonOptions,
  computeDiffCI,
  extractSectionValues,
  findPrimaryColumn,
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

type Row = Record<string, unknown> & { name: string };

/** Build a formatted text table from benchmark groups, with baseline diff columns when present. */
export function reportResults(
  groups: ReportGroup[],
  sections: ReportSection[],
  options?: TextReportOptions,
): string {
  const primary = findPrimaryColumn(sections);
  const results = groups.map(g =>
    resultGroupValues(g, sections, primary, options),
  );
  const hasBaseline = results.some(g => g.baseline);
  const table = buildTable(sectionColumnGroups(sections, hasBaseline), results);
  const hasSampleCI = results.some(g =>
    g.results.some(r => r.diffCI && (r.diffCI as any).ciLevel === "sample"),
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

  let ciAdded = false;
  return groups.map(group => ({
    groupTitle: group.groupTitle,
    columns: group.columns.flatMap(col => {
      if ((col as ReportColumn).comparable && !ciAdded) {
        ciAdded = true;
        return [col, ciCol];
      }
      return [col];
    }),
  }));
}

/** Build table columns from sections, with name column and optional CI diff columns. */
export function sectionColumnGroups(
  sections: ReportSection[],
  hasBaseline: boolean,
  nameTitle = "name",
): ColumnGroup<Row>[] {
  const nameCol: ColumnGroup<Row> = {
    columns: [{ key: "name" as keyof Row, title: nameTitle }],
  };
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

/** Extract section stats and bootstrap CI diffs for all reports in a group. */
function resultGroupValues(
  group: ReportGroup,
  sections: ReportSection[],
  primary?: ReportColumn,
  options?: TextReportOptions,
): ResultGroup<Row> {
  const { reports, baseline } = group;
  const baseM = baseline?.measuredResults;
  const { statKind, higherIsBetter } = primary ?? {};
  const results = reports.map(r => {
    const { measuredResults: m, metadata } = r;
    const diffCI = statKind
      ? computeDiffCI(baseM, m, statKind, options, higherIsBetter)
      : undefined;
    const values = extractSectionValues(m, sections, metadata);
    return { name: truncate(r.name), ...values, ...(diffCI && { diffCI }) };
  });
  const baseRow = baseline && valuesForReports([baseline], sections)[0];
  return { results, baseline: baseRow };
}
