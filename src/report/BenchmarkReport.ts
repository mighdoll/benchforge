import type { MeasuredResults } from "../runners/MeasuredResults.ts";
import {
  bootstrapDifferenceCI,
  type DifferenceCI,
  swapDirection,
} from "../stats/StatisticalUtils.ts";

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
  /** Compute this stat from raw samples for bootstrap CI (comparable columns only) */
  statFn?: (samples: number[], metadata?: Record<string, unknown>) => number;
};

/** Maps benchmark results to table columns */
export interface ResultsMapper<
  T extends Record<string, any> = Record<string, any>,
> {
  extract(results: MeasuredResults, metadata?: UnknownRecord): T;
  columns(): ReportColumnGroup<T>[];
}
export type UnknownRecord = Record<string, unknown>;

/** Run each section's extract() and merge all key-value pairs into one record */
export function extractSectionValues(
  measuredResults: MeasuredResults,
  sections: ReadonlyArray<ResultsMapper<any>>,
  metadata?: UnknownRecord,
): UnknownRecord {
  const entries = sections.flatMap(s =>
    Object.entries(s.extract(measuredResults, metadata)),
  );
  return Object.fromEntries(entries);
}

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
  return (
    groups.flatMap(g => g.columns).find(c => c.comparable)?.higherIsBetter ??
    false
  );
}

/** @return the first comparable column with a statFn across all sections */
export function findPrimaryColumn(
  sections?: ResultsMapper[],
): ReportColumn<Record<string, unknown>> | undefined {
  if (!sections) return undefined;
  const allColumns = sections.flatMap(s => s.columns().flatMap(g => g.columns));
  return allColumns.find(c => c.comparable && c.statFn) as
    | ReportColumn<Record<string, unknown>>
    | undefined;
}

/** Bootstrap difference CI for a column, using batch structure when available */
export function computeDiffCI(
  baseline: MeasuredResults | undefined,
  current: MeasuredResults,
  col: ReportColumn<Record<string, unknown>> | undefined,
  metadata: UnknownRecord | undefined,
  equivMargin?: number,
): DifferenceCI | undefined {
  if (!baseline?.samples?.length || !current.samples?.length) return undefined;
  if (col && !col.statFn) return undefined;
  const statFn = col?.statFn
    ? (s: number[]) => col.statFn!(s, metadata)
    : undefined;
  const opts = {
    statFn,
    blocks: baseline.batchOffsets,
    blocksB: current.batchOffsets,
    equivMargin,
  };
  const rawCI = bootstrapDifferenceCI(baseline.samples, current.samples, opts);
  // statFn computes in the metric's natural domain. bootstrapDifferenceCI
  // assumes lower-is-better for direction labels. For higher-is-better
  // metrics (like loc/sec), swap the direction without negating the values.
  return col?.higherIsBetter ? swapDirection(rawCI) : rawCI;
}

/** Type guard: distinguishes ResultsMapper[] from ReportColumnGroup[] */
function isMappers(
  v: ResultsMapper[] | ReportColumnGroup<any>[],
): v is ResultsMapper[] {
  return v.length > 0 && "extract" in v[0];
}
