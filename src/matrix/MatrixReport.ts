import {
  type ComparisonOptions,
  computeDiffCI,
  extractSectionValues,
  findPrimaryColumn,
  type ReportSection,
} from "../report/BenchmarkReport.ts";
import { truncate } from "../report/Formatters.ts";
import { runsSection, timeSection } from "../report/StandardSections.ts";
import { buildTable } from "../report/text/TableReport.ts";
import { sectionColumnGroups } from "../report/text/TextReport.ts";
import type { MeasuredResults } from "../runners/MeasuredResults.ts";
import type {
  CaseResult,
  MatrixResults,
  VariantResult,
} from "./BenchMatrix.ts";

/** Options for {@link reportMatrixResults} */
export interface MatrixReportOptions {
  /** ReportSection sections (default: [timeSection, runsSection]) */
  sections?: ReportSection[];
  /** Custom title for the variant column (default: "variant") */
  variantTitle?: string;
  /** Comparison options (equivalence margin, batch trimming) */
  comparison?: ComparisonOptions;
}

interface VariantCase {
  variant: VariantResult;
  cr: CaseResult;
}

type Row = Record<string, unknown> & { name: string };

const defaultSections: ReportSection[] = [timeSection, runsSection];

/** Format matrix results as text, with one table per case */
export function reportMatrixResults(
  results: MatrixResults,
  options?: MatrixReportOptions,
): string {
  if (results.variants.length === 0) return `Matrix: ${results.name}`;

  // all variants have the same cases
  const caseIds = results.variants[0].cases.map(c => c.caseId);
  const tables = caseIds.map(caseId =>
    buildCaseTable(results, caseId, options),
  );
  return [`Matrix: ${results.name}`, ...tables].join("\n\n");
}

/** Build table for a single case showing all variants */
function buildCaseTable(
  results: MatrixResults,
  caseId: string,
  options?: MatrixReportOptions,
): string {
  const title = formatCaseTitle(results, caseId);
  const sections = options?.sections ?? defaultSections;
  const variantTitle = options?.variantTitle ?? "variant";
  const primaryCol = findPrimaryColumn(sections);

  const caseResults = collectCaseResults(results, caseId);
  const shared = sharedBaseline(caseResults);

  const rows: Row[] = caseResults.flatMap(({ variant, cr }) => {
    const vals = extractSectionValues(cr.measured, sections, cr.metadata);
    const row: Row = { name: truncate(variant.id, 25), ...vals };
    if (cr.baseline && primaryCol?.statKind) {
      const { statKind, higherIsBetter } = primaryCol;
      row.diffCI = computeDiffCI(
        cr.baseline,
        cr.measured,
        statKind,
        options?.comparison,
        higherIsBetter,
      );
    }
    const out: Row[] = [row];
    if (cr.baseline && !shared)
      out.push({
        name: " \u21B3 baseline",
        ...extractSectionValues(cr.baseline, sections, cr.metadata),
      });
    return out;
  });

  if (shared)
    rows.push({
      name: "=> baseline",
      ...extractSectionValues(shared, sections),
    });

  const hasDiff = rows.some(r => r.diffCI);
  const cols = sectionColumnGroups(sections, hasDiff, variantTitle);
  return `${title}\n${buildTable(cols, [{ results: rows }])}`;
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

/** @return shared baseline if all variants reference the same one (baselineVariant mode) */
function sharedBaseline(
  caseResults: VariantCase[],
): MeasuredResults | undefined {
  const baselines = caseResults.map(({ cr }) => cr.baseline).filter(Boolean);
  if (baselines.length < 2) return undefined;
  return baselines.every(b => b === baselines[0]) ? baselines[0] : undefined;
}
