import colors from "../report/Colors.ts";
import { benchLabel, primaryMetricRow } from "../report/ConsoleSummary.ts";
import { verdictWord } from "../report/Verdict.ts";
import type { CIDirection } from "../stats/Bootstrap.ts";
import type { BenchmarkGroup, ReportData } from "../viewer/ReportData.ts";

interface LabeledDiff {
  label: string;
  direction: CIDirection;
}

/** Roll up the per-benchmark verdicts already in ReportData into a one-line
 *  matrix tally (N faster, M slower, ...) plus the names of the non-equivalent
 *  results. Reads each group's comparisonCI -- the SAME annotated CI the console
 *  summary prints per benchmark -- so the tally can never disagree with the
 *  per-benchmark verdict lines. The single-comparison verdict is omitted: the
 *  console summary already prints it. */
export function reportMatrixResults(data: ReportData): string {
  const diffs = data.groups.flatMap(labeledDiffs);
  if (diffs.length < 2) return "";
  return multiVerdict(diffs);
}

/** A labeled verdict per comparison track in a group's case-level metric row. */
function labeledDiffs(group: BenchmarkGroup): LabeledDiff[] {
  const metric = primaryMetricRow(group);
  if (!metric) return [];
  return metric.entries.flatMap(e => {
    const ci = e.comparisonCI;
    if (!ci || e.isBaseline) return [];
    return [
      { label: benchLabel(e.runName, group.name), direction: ci.direction },
    ];
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
  const paint: Record<CIDirection, (s: string) => string> = {
    faster: green,
    slower: red,
    equivalent: green,
    uncertain: dim,
  };
  const order: CIDirection[] = ["faster", "slower", "equivalent", "uncertain"];
  const parts = order.map(d =>
    paint[d](`${tally[d].length} ${verdictWord(d)}`),
  );
  const head = `Verdicts (${diffs.length} vs baseline): ${parts.join(", ")}`;
  const names = (xs: LabeledDiff[]) => xs.map(d => d.label).join(", ");
  const detail = order
    .filter(d => d !== "equivalent" && tally[d].length)
    .map(d => paint[d](`  ${verdictWord(d)}: ${names(tally[d])}`));
  return [head, ...detail].join("\n");
}
