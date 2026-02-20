import type { CaseResult, MatrixResults } from "../BenchMatrix.ts";
import { injectDiffColumns, type ResultsMapper } from "../BenchmarkReport.ts";
import { totalProfileBytes } from "../heap-sample/HeapSampleReport.ts";
import { type GcStatsInfo, gcStatsSection } from "../StandardSections.ts";
import {
  average,
  bootstrapDifferenceCI,
  type DifferenceCI,
} from "../StatisticalUtils.ts";
import {
  duration,
  formatBytes,
  formatDiffWithCI,
  truncate,
} from "../table-util/Formatters.ts";
import {
  buildTable,
  type ColumnGroup,
  type ResultGroup,
} from "../table-util/TableReport.ts";

/** Custom column definition for extra computed metrics */
export interface ExtraColumn {
  key: string;
  title: string;
  groupTitle?: string; // optional column group header
  extract: (caseResult: CaseResult) => unknown;
  formatter?: (value: unknown) => string;
}

/** Options for matrix report generation */
export interface MatrixReportOptions {
  extraColumns?: ExtraColumn[];
  sections?: ResultsMapper[]; // ResultsMapper sections (like BenchSuite)
  variantTitle?: string; // custom title for the variant column (default: "variant")
}

/** Row data for matrix report table */
interface MatrixReportRow extends Record<string, unknown> {
  name: string;
  time: number;
  samples: number;
  diffCI?: DifferenceCI;
}

/** Format matrix results as one table per case */
export function reportMatrixResults(
  results: MatrixResults,
  options?: MatrixReportOptions,
): string {
  const tables = buildCaseTables(results, options);
  const header = `Matrix: ${results.name}`;
  return [header, ...tables].join("\n\n");
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
  const columns = buildColumns(hasBaseline, options);

  const resultGroup: ResultGroup<MatrixReportRow> = { results: rows };
  const table = buildTable(columns, [resultGroup]);
  return `${caseTitle}\n${table}`;
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

  const rows: Record<string, unknown>[] = [];
  let hasBaseline = false;

  for (const variant of results.variants) {
    const caseResult = variant.cases.find(c => c.caseId === caseId);
    if (!caseResult) continue;

    const row: Record<string, unknown> = { name: truncate(variant.id, 25) };

    for (const section of sections) {
      Object.assign(
        row,
        section.extract(caseResult.measured, caseResult.metadata),
      );
    }

    if (caseResult.baseline) {
      hasBaseline = true;
      const { samples: base } = caseResult.baseline;
      row.diffCI = bootstrapDifferenceCI(base, caseResult.measured.samples);
    }

    rows.push(row);
  }

  const columnGroups = buildSectionColumns(sections, variantTitle, hasBaseline);
  const resultGroup: ResultGroup<Record<string, unknown>> = { results: rows };
  const table = buildTable(columnGroups, [resultGroup]);
  return `${caseTitle}\n${table}`;
}

/** Build column groups from ResultsMapper sections */
function buildSectionColumns(
  sections: ResultsMapper[],
  variantTitle: string,
  hasBaseline: boolean,
): ColumnGroup<Record<string, unknown>>[] {
  const nameCol: ColumnGroup<Record<string, unknown>> = {
    columns: [{ key: "name", title: variantTitle }],
  };

  const sectionColumns = sections.flatMap(s => s.columns());
  const columnGroups = hasBaseline
    ? injectDiffColumns(sectionColumns)
    : (sectionColumns as ColumnGroup<Record<string, unknown>>[]);

  return [nameCol, ...columnGroups];
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

/** Build a single row from case result */
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

/** Build column configuration */
function buildColumns(
  hasBaseline: boolean,
  options?: MatrixReportOptions,
): ColumnGroup<MatrixReportRow>[] {
  const variantTitle = options?.variantTitle ?? "variant";
  const nameCol: ColumnGroup<MatrixReportRow> = {
    columns: [{ key: "name", title: variantTitle }],
  };

  const ciKey = "diffCI" as keyof MatrixReportRow;
  const diffCol = { key: ciKey, title: "Δ% CI", formatter: formatDiff };
  const timeCol: ColumnGroup<MatrixReportRow> = {
    columns: [
      { key: "time", title: "time", formatter: duration },
      ...(hasBaseline ? [diffCol] : []),
    ],
  };

  const groups: ColumnGroup<MatrixReportRow>[] = [nameCol, timeCol];

  // Add extra columns, grouped by groupTitle
  const extraColumns = options?.extraColumns;
  if (extraColumns?.length) {
    const byGroup = new Map<string | undefined, ExtraColumn[]>();
    for (const col of extraColumns) {
      const group = byGroup.get(col.groupTitle) ?? [];
      group.push(col);
      byGroup.set(col.groupTitle, group);
    }
    for (const [groupTitle, cols] of byGroup) {
      groups.push({
        groupTitle,
        columns: cols.map(col => ({
          key: col.key as keyof MatrixReportRow,
          title: col.title,
          formatter: col.formatter ?? String,
        })),
      });
    }
  }

  return groups;
}

/** Format diff with CI, or "baseline" marker */
function formatDiff(value: unknown): string | null {
  if (!value) return null;
  return formatDiffWithCI(value as DifferenceCI);
}

/** Format case title with metadata if available */
function formatCaseTitle(results: MatrixResults, caseId: string): string {
  const caseResult = results.variants[0]?.cases.find(c => c.caseId === caseId);
  const metadata = caseResult?.metadata;

  if (metadata && Object.keys(metadata).length > 0) {
    const metaParts = Object.entries(metadata)
      .map(([k, v]) => `${v} ${k}`)
      .join(", ");
    return `${caseId} (${metaParts})`;
  }
  return caseId;
}

/** GC statistics columns - derived from gcStatsSection for consistency */
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

/** Format bytes with fallback to "-" for missing values */
function formatBytesOrDash(value: unknown): string {
  return formatBytes(value) ?? "-";
}

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
