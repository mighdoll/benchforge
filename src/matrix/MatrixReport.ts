import { totalProfileBytes } from "../profiling/node/HeapSampleReport.ts";
import {
  extractSectionValues,
  type ResultsMapper,
} from "../report/BenchmarkReport.ts";
import {
  duration,
  formatBytes,
  formatDiffWithCI,
  truncate,
} from "../report/Formatters.ts";
import {
  type GcStatsInfo,
  gcStatsSection,
} from "../report/StandardSections.ts";
import { buildTable, type ColumnGroup } from "../report/text/TableReport.ts";
import { sectionColumnGroups } from "../report/text/TextReport.ts";
import {
  average,
  bootstrapDifferenceCI,
  type DifferenceCI,
} from "../stats/StatisticalUtils.ts";
import type { CaseResult, MatrixResults } from "./BenchMatrix.ts";

/** User-defined column that extracts and formats a metric from case results */
export interface ExtraColumn {
  key: string;
  title: string;
  /** Column group header */
  groupTitle?: string;
  extract: (caseResult: CaseResult) => unknown;
  formatter?: (value: unknown) => string;
}

/** Options for {@link reportMatrixResults} */
export interface MatrixReportOptions {
  extraColumns?: ExtraColumn[];
  /** ResultsMapper sections (like BenchSuite) */
  sections?: ResultsMapper[];
  /** Custom title for the variant column (default: "variant") */
  variantTitle?: string;
}

/** Row data for matrix report table */
interface MatrixReportRow extends Record<string, unknown> {
  name: string;
  time: number;
  samples: number;
  diffCI?: DifferenceCI;
}

/** GC statistics columns, derived from gcStatsSection for consistency */
export const gcStatsColumns: ExtraColumn[] = gcStatsSection
  .columns()[0]
  .columns.map(col => ({
    key: col.key as string,
    title: col.title,
    groupTitle: "GC",
    extract: (r: CaseResult) =>
      gcStatsSection.extract(r.measured)[col.key as keyof GcStatsInfo],
    formatter: (v: unknown) => col.formatter?.(v) ?? "-",
  }));

/** GC pause time column */
export const gcPauseColumn: ExtraColumn = {
  key: "gcPause",
  title: "pause",
  groupTitle: "GC",
  extract: r => r.measured.gcStats?.gcPauseTime,
  formatter: v => (v != null ? `${(v as number).toFixed(1)}ms` : "-"),
};

/** Heap sampling total bytes column */
export const heapTotalColumn: ExtraColumn = {
  key: "heapTotal",
  title: "heap",
  extract: r => {
    const profile = r.measured.heapProfile;
    if (!profile?.head) return undefined;
    return totalProfileBytes(profile);
  },
  formatter: formatBytesOrDash,
};

/** Format matrix results as text, with one table per case */
export function reportMatrixResults(
  results: MatrixResults,
  options?: MatrixReportOptions,
): string {
  const tables = buildCaseTables(results, options);
  const header = `Matrix: ${results.name}`;
  return [header, ...tables].join("\n\n");
}

/** Format bytes or "-" for missing values */
function formatBytesOrDash(value: unknown): string {
  return formatBytes(value) ?? "-";
}

/** Build one table for each case showing all variants */
function buildCaseTables(
  results: MatrixResults,
  options?: MatrixReportOptions,
): string[] {
  if (results.variants.length === 0) return [];

  // Get all case IDs from first variant (all variants have same cases)
  const caseIds = results.variants[0].cases.map(c => c.caseId);
  return caseIds.map(caseId => buildCaseTable(results, caseId, options));
}

/** Build table for a single case showing all variants */
function buildCaseTable(
  results: MatrixResults,
  caseId: string,
  options?: MatrixReportOptions,
): string {
  const caseTitle = formatCaseTitle(results, caseId);

  if (options?.sections?.length) {
    return buildSectionTable(results, caseId, options, caseTitle);
  }

  const rows = buildCaseRows(results, caseId, options?.extraColumns);
  const hasBaseline = rows.some(r => r.diffCI);
  const cols = buildColumns(hasBaseline, options);
  const table = buildTable(cols, [{ results: rows }]);
  return `${caseTitle}\n${table}`;
}

/** Format case title with metadata if available */
function formatCaseTitle(results: MatrixResults, caseId: string): string {
  const caseResult = results.variants[0]?.cases.find(c => c.caseId === caseId);
  const metadata = caseResult?.metadata;

  if (!metadata || Object.keys(metadata).length === 0) return caseId;
  const meta = Object.entries(metadata)
    .map(([k, v]) => `${v} ${k}`)
    .join(", ");
  return `${caseId} (${meta})`;
}

/** Build table using ResultsMapper sections */
function buildSectionTable(
  results: MatrixResults,
  caseId: string,
  options: MatrixReportOptions,
  caseTitle: string,
): string {
  const sections = options.sections!;
  const variantTitle = options.variantTitle ?? "name";

  type Row = Record<string, unknown> & { name: string };
  const rows: Row[] = results.variants.flatMap(variant => {
    const cr = variant.cases.find(c => c.caseId === caseId);
    if (!cr) return [];

    const row: Row = {
      name: truncate(variant.id, 25),
      ...extractSectionValues(cr.measured, sections, cr.metadata),
    };
    if (cr.baseline) {
      const { samples } = cr.measured;
      row.diffCI = bootstrapDifferenceCI(cr.baseline.samples, samples);
    }
    return [row];
  });

  const hasBaseline = rows.some(r => r.diffCI);
  const cols = sectionColumnGroups<Row>(sections, hasBaseline, variantTitle);
  const table = buildTable(cols, [{ results: rows }]);
  return `${caseTitle}\n${table}`;
}

/** Build rows for all variants for a given case */
function buildCaseRows(
  results: MatrixResults,
  caseId: string,
  extraColumns?: ExtraColumn[],
): MatrixReportRow[] {
  return results.variants.flatMap(variant => {
    const caseResult = variant.cases.find(c => c.caseId === caseId);
    return caseResult ? [buildRow(variant.id, caseResult, extraColumns)] : [];
  });
}

/** Build default column groups (name, time, extras) */
function buildColumns(
  hasBaseline: boolean,
  options?: MatrixReportOptions,
): ColumnGroup<MatrixReportRow>[] {
  const title = options?.variantTitle ?? "variant";
  const nameCol: ColumnGroup<MatrixReportRow> = {
    columns: [{ key: "name", title }],
  };

  const diffCol = {
    key: "diffCI" as keyof MatrixReportRow,
    title: "Δ% CI",
    formatter: formatDiffWithCI,
  };
  const timeCol: ColumnGroup<MatrixReportRow> = {
    columns: [
      { key: "time", title: "time", formatter: duration },
      ...(hasBaseline ? [diffCol] : []),
    ],
  };

  return [nameCol, timeCol, ...extraColumnGroups(options?.extraColumns)];
}

/** Build a table row from a variant's case result */
function buildRow(
  variantId: string,
  caseResult: CaseResult,
  extraColumns?: ExtraColumn[],
): MatrixReportRow {
  const { measured, baseline } = caseResult;
  const samples = measured.samples;
  const time = measured.time?.avg ?? average(samples);

  const row: MatrixReportRow = {
    name: truncate(variantId, 25),
    time,
    samples: samples.length,
  };

  if (baseline) {
    row.diffCI = bootstrapDifferenceCI(baseline.samples, samples);
  }

  if (extraColumns) {
    for (const col of extraColumns) {
      row[col.key] = col.extract(caseResult);
    }
  }

  return row;
}

/** Group extra columns by groupTitle */
function extraColumnGroups(
  extra?: ExtraColumn[],
): ColumnGroup<MatrixReportRow>[] {
  if (!extra?.length) return [];

  const byGroup = Map.groupBy(extra, col => col.groupTitle);
  return [...byGroup].map(([groupTitle, cols]) => ({
    groupTitle,
    columns: cols.map(col => ({
      key: col.key as keyof MatrixReportRow,
      title: col.title,
      formatter: col.formatter ?? String,
    })),
  }));
}
