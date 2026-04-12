import type { MeasuredResults } from "../runners/MeasuredResults.ts";
import { diffCIs } from "../stats/BootstrapDifference.ts";
import {
  computeStat,
  type DifferenceCI,
  flipCI,
  type StatKind,
  swapDirection,
} from "../stats/StatisticalUtils.ts";

import type { AnyColumn } from "./text/TableReport.ts";

/** Options that affect baseline comparison statistics */
export interface ComparisonOptions {
  /** Equivalence margin in percent (0 to disable) */
  equivMargin?: number;
  /** Disable Tukey trimming of outlier batches */
  noBatchTrim?: boolean;
}

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

/** A titled group of related columns (one per report section) */
export interface ReportSection {
  title: string;
  columns: ReportColumn[];
}

/** A table column with optional comparison behavior */
export type ReportColumn = AnyColumn<Record<string, unknown>> & {
  /** Add diff column after this column when baseline exists */
  comparable?: boolean;
  /** Set true for throughput metrics where higher values are better (e.g., lines/sec) */
  higherIsBetter?: boolean;
  /** Stat descriptor: framework computes value from samples via computeStat */
  statKind?: StatKind;
  /** Accessor for non-sample data (e.g., run count, metadata fields) */
  value?: (results: MeasuredResults, metadata?: UnknownRecord) => unknown;
  /** Convert a timing-domain value to display domain (e.g., ms to lines/sec) */
  toDisplay?: (
    timingValue: number,
    metadata?: Record<string, unknown>,
  ) => number;
};

export type UnknownRecord = Record<string, unknown>;

/** Compute column values for a section from results + metadata.
 *  statKind columns: computeStat(samples, kind), then toDisplay.
 *  value columns: call the accessor directly. */
export function computeColumnValues(
  section: ReportSection,
  results: MeasuredResults,
  metadata?: UnknownRecord,
): UnknownRecord {
  return Object.fromEntries(
    section.columns.map(col => {
      const key = col.key ?? col.title;
      if (col.value) return [key, col.value(results, metadata)];
      if (col.statKind) {
        const raw = computeStat(results.samples, col.statKind);
        return [key, col.toDisplay ? col.toDisplay(raw, metadata) : raw];
      }
      return [key, undefined];
    }),
  );
}

/** Run each section's computeColumnValues and merge into one record */
export function extractSectionValues(
  measuredResults: MeasuredResults,
  sections: ReadonlyArray<ReportSection>,
  metadata?: UnknownRecord,
): UnknownRecord {
  const entries = sections.flatMap(s =>
    Object.entries(computeColumnValues(s, measuredResults, metadata)),
  );
  return Object.fromEntries(entries);
}

/** All reports in a group, including the baseline if present */
export function groupReports(group: ReportGroup): BenchmarkReport[] {
  return group.baseline ? [...group.reports, group.baseline] : group.reports;
}

/** True if any result in the groups has the specified field with a defined value */
export function hasField(
  groups: ReportGroup[],
  field: keyof MeasuredResults,
): boolean {
  return groups.some(group =>
    groupReports(group).some(
      ({ measuredResults }) => measuredResults[field] !== undefined,
    ),
  );
}

/** @return true if the first comparable column in sections has higherIsBetter set */
export function isHigherIsBetter(sections: ReportSection[]): boolean {
  return (
    sections.flatMap(s => s.columns).find(c => c.comparable)?.higherIsBetter ??
    false
  );
}

/** @return the first comparable column with a statKind across all sections */
export function findPrimaryColumn(
  sections?: ReportSection[],
): ReportColumn | undefined {
  if (!sections) return undefined;
  return sections.flatMap(s => s.columns).find(c => c.comparable && c.statKind);
}

/** Bootstrap difference CI for a column, using batch structure when available */
export function computeDiffCI(
  baseline: MeasuredResults | undefined,
  current: MeasuredResults,
  statKind: StatKind,
  comparison?: ComparisonOptions,
  higherIsBetter?: boolean,
): DifferenceCI | undefined {
  if (!baseline?.samples?.length || !current.samples?.length) return undefined;
  const { equivMargin, noBatchTrim } = comparison ?? {};
  const rawCIs = diffCIs(
    baseline.samples,
    baseline.batchOffsets,
    current.samples,
    current.batchOffsets,
    [statKind],
    { equivMargin, noBatchTrim },
  );
  if (!rawCIs[0]) return undefined;
  return higherIsBetter ? swapDirection(flipCI(rawCIs[0])) : rawCIs[0];
}
