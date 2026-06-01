import {
  type ComparisonOptions,
  computeDiffCI,
  findPrimaryMetric,
  metricStatKind,
  type ReportSection,
} from "../report/BenchmarkReport.ts";
import colors from "../report/Colors.ts";
import { truncate } from "../report/Formatters.ts";
import { runsSection, timeSection } from "../report/StandardSections.ts";
import { verdictWord } from "../report/Verdict.ts";
import type { CIDirection, DifferenceCI } from "../stats/StatisticalUtils.ts";
import { flipCI } from "../stats/StatisticalUtils.ts";
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

interface LabeledDiff {
  label: string;
  ci: DifferenceCI;
}

const defaultSections: ReportSection[] = [timeSection, runsSection];

/** Format matrix results as a pithy console verdict (matrix name + per-case
 *  better/worse summary). Detailed distributions live in the markdown report
 *  and HTML viewer. */
export function reportMatrixResults(
  results: MatrixResults,
  options?: MatrixReportOptions,
): string {
  if (results.variants.length === 0) return `Matrix: ${results.name}`;

  // all variants have the same cases
  const caseIds = results.variants[0].cases.map(c => c.caseId);
  const diffs = caseIds.flatMap(caseId => caseDiffs(results, caseId, options));
  const sections = [`Matrix: ${results.name}`];
  const summary = verdictSummary(diffs);
  if (summary) sections.push(summary);
  return sections.join("\n\n");
}

/** Compute labeled comparison diffs for a single case across all variants. */
function caseDiffs(
  results: MatrixResults,
  caseId: string,
  options?: MatrixReportOptions,
): LabeledDiff[] {
  const sections = options?.sections ?? defaultSections;
  const primary = findPrimaryMetric(sections);
  if (!primary) return [];
  const statKind = metricStatKind(primary);
  const higher = !!primary.higherIsBetter;

  return collectCaseResults(results, caseId).flatMap(
    ({ variant, caseResult }) => {
      if (!caseResult.baseline) return [];
      const ci = computeDiffCI(
        caseResult.baseline,
        caseResult.measured,
        statKind,
        options?.comparison,
      );
      if (!ci) return [];
      const label = `${caseId}/${truncate(variant.id, 25)}`;
      return [{ label, ci: higher ? flipCI(ci) : ci }];
    },
  );
}

/** One-line verdict line. For a single comparison, includes name + Δ% inline.
 *  For multiple, tally + names of non-equivalent results. */
function verdictSummary(diffs: LabeledDiff[]): string | undefined {
  if (diffs.length === 0) return undefined;
  if (diffs.length === 1) return singleVerdict(diffs[0]);
  return multiVerdict(diffs);
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

function singleVerdict(d: LabeledDiff): string {
  const { percent, ci, direction } = d.ci;
  const [lo, hi] = ci;
  const sign = (n: number) => (n >= 0 ? "+" : "");
  const range = `${sign(percent)}${percent.toFixed(1)}% [${sign(lo)}${lo.toFixed(1)}%, ${sign(hi)}${hi.toFixed(1)}%]`;
  return `Verdict: ${d.label} ${coloredVerdict(direction)} ${range} vs baseline`;
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
    green(`${tally.faster.length} better`),
    red(`${tally.slower.length} worse`),
    green(`${tally.equivalent.length} equivalent`),
    dim(`${tally.uncertain.length} uncertain`),
  ];
  const head = `Verdicts (${diffs.length} vs baseline): ${parts.join(", ")}`;
  const names = (xs: LabeledDiff[]) => xs.map(d => d.label).join(", ");
  const detail: string[] = [];
  if (tally.faster.length)
    detail.push(green(`  better: ${names(tally.faster)}`));
  if (tally.slower.length) detail.push(red(`  worse: ${names(tally.slower)}`));
  if (tally.uncertain.length)
    detail.push(dim(`  uncertain: ${names(tally.uncertain)}`));
  return [head, ...detail].join("\n");
}

/** @return the verdict word colored green (better/equivalent) or red (worse). */
function coloredVerdict(d: CIDirection): string {
  const { green, red, dim } = colors;
  const word = verdictWord(d);
  if (word === "better" || word === "equivalent") return green(word);
  if (word === "worse") return red(word);
  return dim(word);
}
