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

/** @return the group's primary (verdict-driving) metric row, if any. */
export function primaryMetricRow(group: BenchmarkGroup): ViewerRow | undefined {
  return group.sections?.flatMap(s => s.rows).find(r => r.primary);
}

/** An entry's display value: its bootstrap estimate when present, else its
 *  plain value. Undefined when there is no entry. */
export function entryValue(entry?: ViewerEntry): string | undefined {
  if (!entry) return undefined;
  return entry.bootstrapCI?.estimateLabel ?? entry.value;
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
  const metric = primaryMetricRow(group);
  if (!metric) return [];
  return metric.entries
    .filter(e => !e.isBaseline)
    .flatMap(e => trackLines(e, metric, group.name));
}

/** Headline line plus an optional verdict line for one track. */
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
  const value = entryValue(entry) ?? "";
  const stat = metric.statLabel ? ` ${dim(`(${metric.statLabel})`)}` : "";
  return `${value} ${metric.label}${stat}`.trim();
}

/** The verdict line body: colored direction word, Δ%, CI, "vs baseline". */
function verdict(ci: DifferenceCI): string {
  const word = colorVerdict(ci.direction);
  const [lo, hi] = ci.ci.map(v => formatSignedPercent(v));
  return `${word} ${formatSignedPercent(ci.percent)} [${lo}, ${hi}] vs baseline`;
}

function colorVerdict(direction: CIDirection): string {
  const word = verdictWord(direction);
  if (word === "better") return green(word);
  if (word === "worse") return red(word);
  return dim(word);
}
