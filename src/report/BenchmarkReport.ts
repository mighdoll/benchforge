import type { MeasuredResults } from "../runners/MeasuredResults.ts";

import type { AnyColumn } from "./text/TableReport.ts";

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

/** A titled group of related columns in a report table */
export interface ReportColumnGroup<T> {
  groupTitle?: string;
  columns: ReportColumn<T>[];
}

/** A table column with optional comparison behavior */
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

/** All reports in a group, including the baseline if present */
export function groupReports(group: ReportGroup): BenchmarkReport[] {
  return group.baseline ? [...group.reports, group.baseline] : group.reports;
}

/** @return true if the first comparable column in sections has higherIsBetter set */
export function isHigherIsBetter(
  sections: ResultsMapper[] | ReportColumnGroup<any>[],
): boolean {
  const groups = isMappers(sections)
    ? sections.flatMap(s => s.columns())
    : sections;
  const col = groups.flatMap(g => g.columns).find(c => c.comparable);
  return col?.higherIsBetter ?? false;
}

/** Type guard: distinguishes ResultsMapper[] from ReportColumnGroup[] */
function isMappers(
  v: ResultsMapper[] | ReportColumnGroup<any>[],
): v is ResultsMapper[] {
  return v.length > 0 && "extract" in v[0];
}
