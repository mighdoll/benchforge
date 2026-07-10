import type { CIDirection, DifferenceCI } from "../stats/Bootstrap.ts";
import {
  type NoiseFloor,
  noiseFloorAtOrAboveMargin,
  significantDrift,
} from "../stats/NoiseFloor.ts";
import type {
  BenchmarkGroup,
  ReportData,
  ViewerEntry,
  ViewerRow,
} from "../viewer/ReportData.ts";
import { marginArg } from "./CiFormatting.ts";
import colors from "./Colors.ts";
import {
  formatPercentCI,
  formatSignedPercent,
  percentMagnitude,
} from "./Formatters.ts";
import { verdictWord } from "./Verdict.ts";

const { bold, dim, green, red, yellow } = colors;

/** Render a pithy console summary: per comparison track a headline metric line
 *  and, when a baseline exists, a verdict line (direction, Δ%, CI). Reads the
 *  case-level metric row already computed in ReportData; scalar sections (gc,
 *  runs) are omitted here -- they live in the markdown report and HTML viewer. */
export function consoleSummary(data: ReportData): string {
  const margin = marginArg(data.metadata.cliArgs);
  return data.groups.flatMap(g => groupLines(g, margin)).join("\n");
}

/** @return the group's primary (verdict-driving) metric row, if any. */
export function primaryMetricRow(group: BenchmarkGroup): ViewerRow | undefined {
  return group.sections?.flatMap(s => s.rows).find(r => r.primary);
}

/** The equivalence half-width to quote in a noise-floor reading: for a metric
 *  with a display transform, max(|lo|, |hi|) of the transformed band (the raw
 *  time-percent margin no longer names the visible axis); else the CLI margin. */
export function displayMargin(
  group: BenchmarkGroup,
  margin?: number,
): number | undefined {
  const entry = primaryMetricRow(group)?.entries.find(e => e.shiftFunction);
  const band = entry?.shiftFunction?.equivMarginBand;
  if (!band) return margin;
  return Math.max(Math.abs(band[0]), Math.abs(band[1]));
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
 *  Baseline tracks are skipped -- the verdict lines already read "vs baseline".
 *  A "noisy run" caption trails the group when the environment looks unclean. */
function groupLines(group: BenchmarkGroup, margin?: number): string[] {
  const metric = primaryMetricRow(group);
  if (!metric) return [];
  const tracks = metric.entries
    .filter(e => !e.isBaseline)
    .flatMap(e => trackLines(e, metric, group.name));
  const quoted = displayMargin(group, margin);
  const noise = noiseLine(group.noiseFloor, margin, quoted, metric.label);
  return noise ? [...tracks, noise] : tracks;
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

/** A single yellow "noisy run" caption for the group, present only when the
 *  baseline floor reaches the margin or the run drifted mid-run (the same gates
 *  the markdown report uses). Only the clause whose gate fired is included, so a
 *  clean run stays silent. When the primary metric has a display transform, the
 *  margin clause appends the display-domain equivalent (e.g. "about +/-5.3% in
 *  lines / sec"). Context for the verdict, not a second test. */
function noiseLine(
  nf?: NoiseFloor,
  margin?: number,
  quoted?: number,
  metricLabel?: string,
): string | undefined {
  if (!nf) return undefined;
  const clauses: string[] = [];
  if (noiseFloorAtOrAboveMargin(nf, margin))
    clauses.push(marginClause(nf, margin!, quoted, metricLabel));
  if (significantDrift(nf))
    clauses.push(`timing drifted ${formatSignedPercent(nf.driftPct)} mid-run`);
  if (!clauses.length) return undefined;
  return `  ${yellow(`noisy run: ${clauses.join("; ")}`)}`;
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
  return `${word} ${formatSignedPercent(ci.percent)} ${formatPercentCI(ci.ci)} vs baseline`;
}

/** The margin clause: the time-domain "noise vs margin" comparison, plus a
 *  display-domain parenthetical when the quoted margin differs from the CLI
 *  margin (i.e. the primary metric transforms, so the visible axis is not time). */
function marginClause(
  nf: NoiseFloor,
  margin: number,
  quoted?: number,
  metricLabel?: string,
): string {
  const base =
    `baseline noise +/-${percentMagnitude(nf.halfWidthPct, 1)} ` +
    `vs margin ${percentMagnitude(margin, 1)}`;
  if (quoted === undefined || quoted === margin) return base;
  return `${base} (about +/-${percentMagnitude(quoted, 1)} in ${metricLabel})`;
}

function colorVerdict(direction: CIDirection): string {
  const word = verdictWord(direction);
  if (word === "better") return green(word);
  if (word === "worse") return red(word);
  return dim(word);
}
