import type { CIDirection, DifferenceCI } from "../stats/StatisticalUtils.ts";
import type {
  BenchmarkGroup,
  ReportData,
  ViewerEntry,
  ViewerRow,
} from "../viewer/ReportData.ts";
import colors from "./Colors.ts";
import { formatSignedPercent } from "./Formatters.ts";
import { verdictWord } from "./Verdict.ts";

const { bold, dim, green, red } = colors;

/** Render a pithy console summary: per comparison track a headline metric line
 *  and, when a baseline exists, a verdict line (direction, Δ%, CI). Reads the
 *  case-level metric row already computed in ReportData; scalar sections (gc,
 *  runs) are omitted here -- they live in the markdown report and HTML viewer. */
export function consoleSummary(data: ReportData): string {
  return data.groups.flatMap(groupLines).join("\n");
}

/** @return a label that names the benchmark without repeating segments. The
 *  group name (matrix name, or "matrix / case") prefixes the benchmark name,
 *  unless a segment already is that name (avoids "X / X"). */
export function benchLabel(name: string, groupName: string): string {
  if (!groupName || groupName === name) return name;
  if (groupName.split(" / ").includes(name)) return groupName;
  return `${groupName} / ${name}`;
}

/** Each comparison track's headline (+ verdict) for one group; no group header.
 *  Baseline tracks are skipped -- the verdict lines already read "vs baseline". */
function groupLines(group: BenchmarkGroup): string[] {
  const metric = group.sections?.flatMap(s => s.rows).find(r => r.primary);
  if (!metric) return [];
  return metric.entries
    .filter(e => !e.isBaseline)
    .flatMap(e => trackLines(e, metric, group.name));
}

/** Headline + optional verdict for one track. The label is the group name when
 *  it already identifies the track (matrix "variant / case", whose track name is
 *  just the variant), else the track name prefixed by a distinct group name. */
function trackLines(
  entry: ViewerEntry,
  metric: ViewerRow,
  groupName: string,
): string[] {
  const head = `${bold(benchLabel(entry.runName, groupName))}  ${headline(entry, metric)}`;
  const ci = entry.comparisonCI;
  if (!ci) return [head];
  return [head, `  ${dim("->")} ${verdict(ci)}`];
}

/** The headline value with its unit and stat, e.g. "285,200 lines / sec (mean)". */
function headline(entry: ViewerEntry, metric: ViewerRow): string {
  const value = entry.bootstrapCI?.estimateLabel ?? entry.value ?? "";
  const stat = metric.statLabel ? ` ${dim(`(${metric.statLabel})`)}` : "";
  return `${value} ${metric.label}${stat}`.trim();
}

/** The verdict line body: colored direction word, Δ%, CI, "vs baseline". */
function verdict(ci: DifferenceCI): string {
  const word = colorVerdict(ci.direction);
  const [lo, hi] = ci.ci.map(formatSignedPercent);
  return `${word} ${formatSignedPercent(ci.percent)} [${lo}, ${hi}] vs baseline`;
}

function colorVerdict(direction: CIDirection): string {
  const word = verdictWord(direction);
  if (word === "better") return green(word);
  if (word === "worse") return red(word);
  return dim(word);
}
