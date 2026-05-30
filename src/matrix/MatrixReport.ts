import {
  type ComparisonOptions,
  computeDiffCI,
  extractSectionValues,
  findPrimaryCIColumn,
  type ReportSection,
} from "../report/BenchmarkReport.ts";
import colors from "../report/Colors.ts";
import { truncate } from "../report/Formatters.ts";
import { runsSection, timeSection } from "../report/StandardSections.ts";
import { buildTable } from "../report/text/TableReport.ts";
import { sectionColumnGroups } from "../report/text/TextReport.ts";
import type { MeasuredResults } from "../runners/MeasuredResults.ts";
import type { CIDirection, DifferenceCI } from "../stats/StatisticalUtils.ts";
import { flipCI, trimOutlierBatches } from "../stats/StatisticalUtils.ts";
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
  caseResult: CaseResult;
}

type Row = Record<string, unknown> & { name: string };

interface LabeledDiff {
  label: string;
  ci: DifferenceCI;
}

const defaultSections: ReportSection[] = [timeSection, runsSection];

/** Format matrix results as text, with one table per case */
export function reportMatrixResults(
  results: MatrixResults,
  options?: MatrixReportOptions,
): string {
  if (results.variants.length === 0) return `Matrix: ${results.name}`;

  // all variants have the same cases
  const caseIds = results.variants[0].cases.map(c => c.caseId);
  const built = caseIds.map(caseId => buildCaseTable(results, caseId, options));
  const tables = built.map(b => b.table);
  const diffs = built.flatMap(b => b.diffs);
  const sections = [`Matrix: ${results.name}`, ...tables];
  const summary = verdictSummary(diffs);
  if (summary) sections.push(summary);
  return sections.join("\n\n");
}

/** Build table for a single case showing all variants */
function buildCaseTable(
  results: MatrixResults,
  caseId: string,
  options?: MatrixReportOptions,
): { table: string; diffs: LabeledDiff[] } {
  const title = formatCaseTitle(results, caseId);
  const sections = options?.sections ?? defaultSections;
  const variantTitle = options?.variantTitle ?? "variant";
  const primaryCol = findPrimaryCIColumn(sections);

  const caseResults = collectCaseResults(results, caseId);
  const shared = sharedBaseline(caseResults);

  const noTrim = options?.comparison?.noBatchTrim;
  const trimSamples = (m: MeasuredResults) =>
    trimOutlierBatches(m.samples, m.batchOffsets, noTrim).samples;

  const extractVals = (m: MeasuredResults, meta?: Record<string, unknown>) =>
    extractSectionValues(m, sections, meta, trimSamples(m));

  const rows: Row[] = caseResults.flatMap(({ variant, caseResult }) => {
    const row: Row = {
      name: truncate(variant.id, 25),
      ...extractVals(caseResult.measured, caseResult.metadata),
    };
    if (caseResult.baseline && primaryCol?.statKind) {
      const comp = options?.comparison;
      row.diffCI = computeDiffCI(
        caseResult.baseline,
        caseResult.measured,
        primaryCol.statKind,
        comp,
      );
    }
    const out: Row[] = [row];
    if (caseResult.baseline && !shared)
      out.push({
        name: " \u21B3 baseline",
        ...extractVals(caseResult.baseline, caseResult.metadata),
      });
    return out;
  });

  if (shared)
    rows.push({
      name: "=> baseline",
      ...extractSectionValues(shared, sections, undefined, trimSamples(shared)),
    });

  const hasDiff = rows.some(r => r.diffCI);
  const cols = sectionColumnGroups(sections, hasDiff, variantTitle);
  const higher = !!primaryCol?.higherIsBetter;
  const diffs: LabeledDiff[] = rows.flatMap(r => {
    const ci = r.diffCI as DifferenceCI | undefined;
    if (!ci) return [];
    return [{ label: `${caseId}/${r.name}`, ci: higher ? flipCI(ci) : ci }];
  });
  const table = `${title}\n${buildTable(cols, [{ results: rows }])}`;
  return { table, diffs };
}

/** One-line verdict line. For a single comparison, includes name + Δ% inline.
 *  For multiple, tally + names of non-equivalent results. */
function verdictSummary(diffs: LabeledDiff[]): string | undefined {
  if (diffs.length === 0) return undefined;
  if (diffs.length === 1) return singleVerdict(diffs[0]);
  return multiVerdict(diffs);
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
    const caseResult = variant.cases.find(c => c.caseId === caseId);
    return caseResult ? [{ variant, caseResult }] : [];
  });
}

/** @return shared baseline if all variants reference the same one (baselineVariant mode) */
function sharedBaseline(
  caseResults: VariantCase[],
): MeasuredResults | undefined {
  const baselines = caseResults
    .map(({ caseResult }) => caseResult.baseline)
    .filter(Boolean);
  if (baselines.length < 2) return undefined;
  return baselines.every(b => b === baselines[0]) ? baselines[0] : undefined;
}

function singleVerdict(d: LabeledDiff): string {
  const { percent, ci, direction } = d.ci;
  const [lo, hi] = ci;
  const sign = (n: number) => (n >= 0 ? "+" : "");
  const range = `${sign(percent)}${percent.toFixed(1)}% [${sign(lo)}${lo.toFixed(1)}%, ${sign(hi)}${hi.toFixed(1)}%]`;
  return `Verdict: ${d.label} ${verdictWord(direction)} ${range} vs baseline`;
}

function multiVerdict(diffs: LabeledDiff[]): string {
  const tally: Record<CIDirection, LabeledDiff[]> = {
    faster: [],
    slower: [],
    equivalent: [],
    uncertain: [],
  };
  for (const d of diffs) tally[d.ci.direction].push(d);
  const { green, red, dim } = colors;
  const parts = [
    green(`${tally.faster.length} faster`),
    red(`${tally.slower.length} slower`),
    green(`${tally.equivalent.length} equivalent`),
    dim(`${tally.uncertain.length} uncertain`),
  ];
  const head = `Verdicts (${diffs.length} vs baseline): ${parts.join(", ")}`;
  const names = (xs: LabeledDiff[]) => xs.map(d => d.label).join(", ");
  const detail: string[] = [];
  if (tally.faster.length)
    detail.push(green(`  faster: ${names(tally.faster)}`));
  if (tally.slower.length) detail.push(red(`  slower: ${names(tally.slower)}`));
  if (tally.uncertain.length)
    detail.push(dim(`  uncertain: ${names(tally.uncertain)}`));
  return [head, ...detail].join("\n");
}

function verdictWord(d: CIDirection): string {
  const { green, red, dim } = colors;
  if (d === "faster") return green("faster");
  if (d === "slower") return red("slower");
  if (d === "equivalent") return green("equivalent");
  return dim("uncertain");
}
