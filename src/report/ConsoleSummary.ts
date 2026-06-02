import type { CIDirection, DifferenceCI } from "../stats/StatisticalUtils.ts";
import type {
  BenchmarkEntry,
  BenchmarkGroup,
  ReportData,
  ViewerRow,
} from "../viewer/ReportData.ts";
import colors from "./Colors.ts";
import { verdictWord } from "./Verdict.ts";

const { bold, dim, green, red } = colors;

/** Render a pithy console summary: per benchmark a headline metric line and,
 *  when a baseline exists, a verdict line (direction, Δ%, CI). Reads the metric
 *  rows already computed in ReportData; scalar sections (gc, runs) are omitted
 *  here -- they live in the markdown report and HTML viewer. */
export function consoleSummary(data: ReportData): string {
  return data.groups.flatMap(groupLines).join("\n");
}

/** Each benchmark's headline (+ verdict) for one group; no group header. */
function groupLines(group: BenchmarkGroup): string[] {
  return group.benchmarks.flatMap(b => benchmarkLines(b, group.name));
}

/** Headline + optional verdict for one benchmark. The label is the group name
 *  when it already identifies the benchmark (matrix "variant / case", whose
 *  entry name is just the variant), else the benchmark name prefixed by a
 *  distinct group name. */
function benchmarkLines(entry: BenchmarkEntry, groupName: string): string[] {
  const metric = entry.sections?.flatMap(s => s.rows).find(r => r.primary);
  if (!metric) return [];

  const head = `${bold(benchLabel(entry.name, groupName))}  ${headline(metric)}`;
  const ci = entry.comparisonCI;
  if (!ci) return [head];
  return [head, `  ${dim("->")} ${verdict(ci)}`];
}

/** @return a label that names the benchmark without repeating segments. */
function benchLabel(name: string, groupName: string): string {
  if (!groupName || groupName === name) return name;
  // matrix group names are "variant / case"; the entry name repeats the variant.
  if (groupName.split(" / ").includes(name)) return groupName;
  return `${groupName} / ${name}`;
}

/** The headline value with its unit and stat, e.g. "285,200 lines / sec (mean)". */
function headline(metric: ViewerRow): string {
  const entry = metric.entries[0];
  const value = entry?.bootstrapCI?.estimateLabel ?? entry?.value ?? "";
  const stat = metric.statLabel ? ` ${dim(`(${metric.statLabel})`)}` : "";
  return `${value} ${metric.label}${stat}`.trim();
}

/** The verdict line body: colored direction word, Δ%, CI, "vs baseline". */
function verdict(ci: DifferenceCI): string {
  const word = colorVerdict(ci.direction);
  const [lo, hi] = ci.ci.map(signed);
  return `${word} ${signed(ci.percent)} [${lo}, ${hi}] vs baseline`;
}

function colorVerdict(direction: CIDirection): string {
  const word = verdictWord(direction);
  if (word === "better") return green(word);
  if (word === "worse") return red(word);
  return dim(word);
}

function signed(v: number): string {
  return `${v >= 0 ? "+" : ""}${v.toFixed(1)}%`;
}
