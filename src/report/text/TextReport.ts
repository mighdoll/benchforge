import {
  type BenchmarkReport,
  type ComparisonOptions,
  computeDiffCI,
  extractSectionValues,
  findPrimaryColumn,
  isHigherIsBetter,
  type ReportColumn,
  type ReportColumnGroup,
  type ReportGroup,
  type ResultsMapper,
} from "../BenchmarkReport.ts";
import {
  formatDiffWithCI,
  formatDiffWithCIHigherIsBetter,
  truncate,
} from "../Formatters.ts";
import {
  buildTable,
  type ColumnGroup,
  type ResultGroup,
} from "./TableReport.ts";

type SectionStats<S> = S extends ResultsMapper<infer T> ? T : never;

interface ReportRowBase {
  name: string;
}

/** Row data combining all section statistics */
type ReportRowData<S extends ReadonlyArray<ResultsMapper<any>>> =
  ReportRowBase & UnionToIntersection<SectionStats<S[number]>>;

/** Convert union to intersection - https://mighdoll.dev/blog/modern-typescript-intersection/ */
type UnionToIntersection<U> = (U extends any ? (k: U) => void : never) extends (
  k: infer I extends U,
) => void
  ? I
  : never;

/** Options for text report generation */
export interface TextReportOptions extends ComparisonOptions {}

/** Build a formatted text table from benchmark groups, with baseline diff columns when present */
export function reportResults<S extends ReadonlyArray<ResultsMapper<any>>>(
  groups: ReportGroup[],
  sections: S,
  options?: TextReportOptions,
): string {
  const primaryCol = findPrimaryColumn(sections as unknown as ResultsMapper[]);
  const results = groups.map(g =>
    resultGroupValues(g, sections, primaryCol, options),
  );
  return buildTable(
    createColumnGroups(
      sections,
      results.some(g => g.baseline),
    ),
    results,
  );
}

/** Extract stats from all sections into typed row objects for each report */
export function valuesForReports<S extends ReadonlyArray<ResultsMapper<any>>>(
  reports: BenchmarkReport[],
  sections: S,
): ReportRowData<S>[] {
  return reports.map(report => ({
    name: truncate(report.name),
    ...extractSectionValues(report.measuredResults, sections, report.metadata),
  })) as ReportRowData<S>[];
}

/** Insert a single "delta% CI" column after the first perRun column in each group */
export function injectDiffColumns<T>(
  reportGroups: ReportColumnGroup<T>[],
): ColumnGroup<T>[] {
  const fmt = isHigherIsBetter(reportGroups)
    ? formatDiffWithCIHigherIsBetter
    : formatDiffWithCI;
  const ciCol = { title: "Δ% CI", key: "diffCI" as keyof T, formatter: fmt };

  let ciAdded = false;
  return reportGroups.map(group => ({
    groupTitle: group.groupTitle,
    columns: group.columns.flatMap(col => {
      if (col.comparable && !ciAdded) {
        ciAdded = true;
        return [col, ciCol];
      }
      return [col];
    }),
  }));
}

/** Extract section stats and bootstrap CI diffs for all reports in a group */
function resultGroupValues<S extends ReadonlyArray<ResultsMapper<any>>>(
  group: ReportGroup,
  sections: S,
  primaryCol?: ReportColumn<Record<string, unknown>>,
  options?: TextReportOptions,
): ResultGroup<ReportRowData<S>> {
  const { reports, baseline } = group;
  const baseM = baseline?.measuredResults;
  const results = reports.map(report => {
    const { measuredResults: m, metadata } = report;
    const diffCI = computeDiffCI(baseM, m, primaryCol, metadata, options);
    return {
      name: truncate(report.name),
      ...extractSectionValues(m, sections, metadata),
      ...(diffCI && { diffCI }),
    } as ReportRowData<S>;
  });
  return {
    results,
    baseline: baseline && valuesForReports([baseline], sections)[0],
  };
}

/** Build table columns from sections, with name column and optional CI diff columns */
export function sectionColumnGroups<T extends { name: string }>(
  sections: ReadonlyArray<ResultsMapper<any>>,
  hasBaseline: boolean,
  nameTitle = "name",
): ColumnGroup<T>[] {
  const nameCol: ColumnGroup<T> = {
    columns: [{ key: "name" as keyof T, title: nameTitle }],
  };
  const groups = sections.flatMap(s => s.columns());
  return [
    nameCol,
    ...(hasBaseline ? injectDiffColumns(groups) : (groups as ColumnGroup<T>[])),
  ];
}

/** Build table columns from sections, injecting CI diff columns when baseline is present */
function createColumnGroups<S extends ReadonlyArray<ResultsMapper<any>>>(
  sections: S,
  hasBaseline: boolean,
): ColumnGroup<ReportRowData<S>>[] {
  return sectionColumnGroups<ReportRowData<S>>(sections, hasBaseline);
}
