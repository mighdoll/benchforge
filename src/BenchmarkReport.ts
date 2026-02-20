import type { MeasuredResults } from "./MeasuredResults.ts";
import { bootstrapDifferenceCI } from "./StatisticalUtils.ts";
import type { UnionToIntersection } from "./TypeUtil.ts";
import {
  formatDiffWithCI,
  formatDiffWithCIHigherIsBetter,
  truncate,
} from "./table-util/Formatters.ts";
import {
  type AnyColumn,
  buildTable,
  type ColumnGroup,
  type ResultGroup,
} from "./table-util/TableReport.ts";

/** Benchmark results with optional baseline for comparison */
export interface ReportGroup {
  name: string;
  reports: BenchmarkReport[];
  baseline?: BenchmarkReport;
}

/** Results from a single benchmark run */
export interface BenchmarkReport {
  name: string;
  measuredResults: MeasuredResults;
  metadata?: UnknownRecord;
}

export interface ReportColumnGroup<T> {
  groupTitle?: string;
  columns: ReportColumn<T>[];
}

export type ReportColumn<T> = AnyColumn<T> & {
  /** Add diff column after this column when baseline exists */
  comparable?: boolean;
  /** Set true for throughput metrics where higher values are better (e.g., lines/sec) */
  higherIsBetter?: boolean;
};

/** Maps benchmark results to table columns */
export interface ResultsMapper<
  T extends Record<string, any> = Record<string, any>,
> {
  extract(results: MeasuredResults, metadata?: UnknownRecord): T;
  columns(): ReportColumnGroup<T>[];
}
export type UnknownRecord = Record<string, unknown>;

type SectionStats<S> = S extends ResultsMapper<infer T> ? T : never;

interface ReportRowBase {
  name: string;
}

/** Row data combining all section statistics */
type ReportRowData<S extends ReadonlyArray<ResultsMapper<any>>> =
  ReportRowBase & UnionToIntersection<SectionStats<S[number]>>;

/** @return formatted table report with optional baseline comparisons */
export function reportResults<S extends ReadonlyArray<ResultsMapper<any>>>(
  groups: ReportGroup[],
  sections: S,
): string {
  const results = groups.map(group => resultGroupValues(group, sections));
  const hasBaseline = results.some(g => g.baseline);
  return buildTable(createColumnGroups(sections, hasBaseline), results);
}

/** @return values for report group */
function resultGroupValues<S extends ReadonlyArray<ResultsMapper<any>>>(
  group: ReportGroup,
  sections: S,
): ResultGroup<ReportRowData<S>> {
  const { reports, baseline } = group;
  const baselineSamples = baseline?.measuredResults.samples;

  const results = reports.map(report => {
    const row = {
      name: truncate(report.name),
      ...extractReportValues(report, sections),
    } as ReportRowData<S>;

    if (baselineSamples && report.measuredResults.samples) {
      (row as any).diffCI = bootstrapDifferenceCI(
        baselineSamples,
        report.measuredResults.samples,
      );
    }
    return row;
  });

  const baselineRow = baseline && valuesForReports([baseline], sections)[0];
  return { results, baseline: baselineRow };
}

/** @return rows with stats from sections */
export function valuesForReports<S extends ReadonlyArray<ResultsMapper<any>>>(
  reports: BenchmarkReport[],
  sections: S,
): ReportRowData<S>[] {
  return reports.map(report => ({
    name: truncate(report.name),
    ...extractReportValues(report, sections),
  })) as ReportRowData<S>[];
}

/** @return merged statistics from all sections */
function extractReportValues(
  report: BenchmarkReport,
  sections: ReadonlyArray<ResultsMapper<any>>,
): UnknownRecord {
  const { measuredResults, metadata } = report;
  const entries = sections.flatMap(s =>
    Object.entries(s.extract(measuredResults, metadata)),
  );
  return Object.fromEntries(entries);
}

/** @return column groups with diff columns if baseline exists */
function createColumnGroups<S extends ReadonlyArray<ResultsMapper<any>>>(
  sections: S,
  hasBaseline: boolean,
): ColumnGroup<ReportRowData<S>>[] {
  const nameColumn: ColumnGroup<ReportRowData<S>> = {
    columns: [{ key: "name" as keyof ReportRowData<S>, title: "name" }],
  };

  const groups = sections.flatMap(section => section.columns());
  return [nameColumn, ...(hasBaseline ? injectDiffColumns(groups) : groups)];
}

/** @return groups with single CI column after first comparable field */
export function injectDiffColumns<T>(
  reportGroups: ReportColumnGroup<T>[],
): ColumnGroup<T>[] {
  let ciAdded = false;

  return reportGroups.map(group => ({
    groupTitle: group.groupTitle,
    columns: group.columns.flatMap(col => {
      if (col.comparable && !ciAdded) {
        ciAdded = true;
        const fmt = col.higherIsBetter
          ? formatDiffWithCIHigherIsBetter
          : formatDiffWithCI;
        return [
          col,
          { title: "Δ% CI", key: "diffCI" as keyof T, formatter: fmt },
        ];
      }
      return [col];
    }),
  }));
}
