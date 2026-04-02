import { totalProfileBytes } from "../profiling/node/HeapSampleReport.ts";
import {
  computeDiffCI,
  extractSectionValues,
  findPrimaryColumn,
  type ResultsMapper,
} from "../report/BenchmarkReport.ts";
import {
  formatBytes,
  formatDiffWithCI,
  timeMs,
  truncate,
} from "../report/Formatters.ts";
import {
  type GcStatsInfo,
  gcStatsSection,
} from "../report/StandardSections.ts";
import { buildTable, type ColumnGroup } from "../report/text/TableReport.ts";
import { sectionColumnGroups } from "../report/text/TextReport.ts";
import type { MeasuredResults } from "../runners/MeasuredResults.ts";
import {
  average,
  bootstrapDifferenceCI,
  type DifferenceCI,
} from "../stats/StatisticalUtils.ts";
import type {
  CaseResult,
  MatrixResults,
  VariantResult,
} from "./BenchMatrix.ts";

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
  /** Equivalence margin in percent for baseline comparison */
  equivMargin?: number;
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
  const title = formatCaseTitle(results, caseId);
  if (options?.sections?.length)
    return buildSectionTable(results, caseId, options, title);

  const rows = buildCaseRows(results, caseId, options);
  const hasDiff = rows.some(r => r.diffCI);
  return `${title}\n${buildTable(buildColumns(hasDiff, options), [{ results: rows }])}`;
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
  const equivMargin = options.equivMargin;
  const primaryCol = findPrimaryColumn(sections);

  type Row = Record<string, unknown> & { name: string };
  const caseResults = collectCaseResults(results, caseId);
  const shared = hasSharedBaseline(caseResults);

  const rows: Row[] = caseResults.flatMap(({ variant, cr }) => {
    const vals = extractSectionValues(cr.measured, sections, cr.metadata);
    const row: Row = { name: truncate(variant.id, 25), ...vals };
    if (cr.baseline)
      row.diffCI = computeDiffCI(
        cr.baseline,
        cr.measured,
        primaryCol,
        cr.metadata,
        equivMargin,
      );
    const out: Row[] = [row];
    if (cr.baseline && !shared) {
      const baseVals = extractSectionValues(cr.baseline, sections, cr.metadata);
      out.push({ name: " \u21B3 baseline", ...baseVals });
    }
    return out;
  });

  if (shared)
    rows.push({
      name: "=> baseline",
      ...extractSectionValues(shared, sections),
    });

  const hasDiff = rows.some(r => r.diffCI);
  const cols = sectionColumnGroups<Row>(sections, hasDiff, variantTitle);
  return `${caseTitle}\n${buildTable(cols, [{ results: rows }])}`;
}

/** Build rows for all variants for a given case, with baseline rows when present */
function buildCaseRows(
  results: MatrixResults,
  caseId: string,
  options?: MatrixReportOptions,
): MatrixReportRow[] {
  const { extraColumns, equivMargin } = options ?? {};
  const cases = collectCaseResults(results, caseId);
  const shared = hasSharedBaseline(cases);

  const rows = cases.flatMap(({ variant, cr }) => {
    const out: MatrixReportRow[] = [
      buildRow(variant.id, cr, extraColumns, equivMargin),
    ];
    if (cr.baseline && !shared) {
      const baseCr = { ...cr, measured: cr.baseline, baseline: undefined };
      out.push(buildRow(" \u21B3 baseline", baseCr, extraColumns));
    }
    return out;
  });

  if (shared)
    rows.push(
      buildRow("=> baseline", { caseId, measured: shared }, extraColumns),
    );
  return rows;
}

/** Build default column groups (name, time, extras) */
function buildColumns(
  hasBaseline: boolean,
  options?: MatrixReportOptions,
): ColumnGroup<MatrixReportRow>[] {
  type K = keyof MatrixReportRow;
  const title = options?.variantTitle ?? "variant";
  const nameCol: ColumnGroup<MatrixReportRow> = {
    columns: [{ key: "name", title }],
  };
  const diffCol = {
    key: "diffCI" as K,
    title: "Δ% CI",
    formatter: formatDiffWithCI,
  };
  const timeCol = { key: "time" as K, title: "time", formatter: timeMs };
  const timeCols = [timeCol, ...(hasBaseline ? [diffCol] : [])];
  return [
    nameCol,
    { columns: timeCols },
    ...extraColumnGroups(options?.extraColumns),
  ];
}

/** Build a table row from a variant's case result */
function buildRow(
  name: string,
  caseResult: CaseResult,
  extraColumns?: ExtraColumn[],
  equivMargin?: number,
): MatrixReportRow {
  const { measured, baseline } = caseResult;
  const { samples } = measured;
  const row: MatrixReportRow = {
    name: truncate(name, 25),
    time: measured.time?.avg ?? average(samples),
    samples: samples.length,
  };
  if (baseline) {
    const opts = {
      blocks: baseline.batchOffsets,
      blocksB: measured.batchOffsets,
      equivMargin,
    };
    row.diffCI = bootstrapDifferenceCI(baseline.samples, samples, opts);
  }
  if (extraColumns)
    for (const col of extraColumns) row[col.key] = col.extract(caseResult);
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

interface VariantCase {
  variant: VariantResult;
  cr: CaseResult;
}

/** Collect (variant, caseResult) pairs for a given caseId */
function collectCaseResults(
  results: MatrixResults,
  caseId: string,
): VariantCase[] {
  return results.variants.flatMap(variant => {
    const cr = variant.cases.find(c => c.caseId === caseId);
    return cr ? [{ variant, cr }] : [];
  });
}

/** If all baselines are the same reference (baselineVariant mode), return it */
function hasSharedBaseline(
  caseResults: VariantCase[],
): MeasuredResults | undefined {
  const baselines = caseResults.map(({ cr }) => cr.baseline).filter(Boolean);
  if (baselines.length < 2) return undefined;
  return baselines.every(b => b === baselines[0]) ? baselines[0] : undefined;
}
