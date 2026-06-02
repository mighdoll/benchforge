import colors from "../report/Colors.ts";
import { benchLabel } from "../report/ConsoleSummary.ts";
import type { CIDirection } from "../stats/StatisticalUtils.ts";
import type { BenchmarkGroup, ReportData } from "../viewer/ReportData.ts";

interface LabeledDiff {
  label: string;
  direction: CIDirection;
}

/** Roll up the per-benchmark verdicts already in ReportData into a one-line
 *  matrix tally (N better, M worse, ...) plus the names of the non-equivalent
 *  results. Reads each group's comparisonCI -- the SAME annotated CI the console
 *  summary prints per benchmark -- so the tally can never disagree with the
 *  per-benchmark verdict lines. The single-comparison verdict is omitted: the
 *  console summary already prints it. */
export function reportMatrixResults(data: ReportData): string {
  const diffs = data.groups.flatMap(labeledDiffs);
  if (diffs.length < 2) return "";
  return multiVerdict(diffs);
}

/** A labeled verdict per benchmark in a group that was compared to a baseline. */
function labeledDiffs(group: BenchmarkGroup): LabeledDiff[] {
  return group.benchmarks.flatMap(b => {
    const ci = b.comparisonCI;
    if (!ci) return [];
    return [{ label: benchLabel(b.name, group.name), direction: ci.direction }];
  });
}

/** Tally line + names of the non-equivalent results, grouped by direction. */
function multiVerdict(diffs: LabeledDiff[]): string {
  const tally: Record<CIDirection, LabeledDiff[]> = {
    faster: [],
    slower: [],
    equivalent: [],
    uncertain: [],
  };
  for (const d of diffs) tally[d.direction].push(d);
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
