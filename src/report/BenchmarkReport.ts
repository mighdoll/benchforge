import type { MeasuredResults } from "../runners/MeasuredResults.ts";
import { computeStat, type StatKind } from "../stats/StatisticalUtils.ts";

/** Options that affect baseline comparison statistics */
export interface ComparisonOptions {
  /** Equivalence margin in percent (0 to disable) */
  equivMargin?: number;
  /** Disable Tukey trimming of outlier batches. Trimming compares per-batch
   *  means and drops slow-side outliers only; fast batches are kept since
   *  they reflect less environmental noise rather than errors. */
  noBatchTrim?: boolean;
  /** Bootstrap resample count (default 10000). Lower it only in tests that
   *  check shift-function structure rather than CI precision. */
  resamples?: number;
}

/** Benchmark results with optional baseline for comparison */
export interface ReportGroup {
  name: string;
  reports: BenchmarkReport[];
  baseline?: BenchmarkReport;

  /** Id of a sibling report used as the shared baseline (matrix baselineVariant
   *  mode), so the viewer can name it. Undefined when the baseline is a separate
   *  version (baselineDir) or absent. */
  baselineVariantId?: string;
}

/** Results from a single benchmark run */
export interface BenchmarkReport {
  name: string;
  measuredResults: MeasuredResults;
  metadata?: UnknownRecord;
  /** Per-report baseline, interleaved with this report specifically. Overrides
   *  the group baseline for this report's comparison (matrix variants each have
   *  their own baseline; suite groups share one group-level baseline instead). */
  baseline?: BenchmarkReport;
}

export type UnknownRecord = Record<string, unknown>;

/** Formats a value for display (e.g. timeMs, integer, percent). */
export type Formatter = (value: unknown) => string | null;

/** A report section is either one comparable metric or a bag of scalar rows. */
export type ReportSection = MetricSection | ScalarSection;

/** One comparable metric: drives the verdict, the HTML header, and the
 *  shift-function fan. Percentiles are not listed -- the fan is fixed. */
export interface MetricSection {
  kind: "metric";
  title: string;
  /** Stat computed from samples to drive verdict/headline/fan; defaults to "mean". */
  statKind?: StatKind;
  /** Set true for throughput metrics where higher values are better (lines/sec). */
  higherIsBetter?: boolean;
  /** Convert a timing-domain value to display domain (e.g. ms to lines/sec). */
  toDisplay?: (timingValue: number, metadata?: UnknownRecord) => number;
  formatter: Formatter;
  /** Extra scalar cells shown alongside the metric (e.g. line counts). */
  extras?: ScalarRow[];
}

/** A bag of named values pulled from results/metadata (gc, runs, v8 opt). */
export interface ScalarSection {
  kind: "scalar";
  title: string;
  rows: ScalarRow[];
  /** Rendering layout hint; "matrix" packs scalar metrics into a dense table. */
  layout?: "matrix";
}

/** A single scalar value pulled from results/metadata. */
export interface ScalarRow {
  key?: string;
  title: string;
  formatter: Formatter;
  value: (results: MeasuredResults, metadata?: UnknownRecord) => unknown;
  /** Add a diff column when a baseline exists (point-ratio, no bootstrap CI). */
  comparable?: boolean;
}

/** @return a MetricSection with kind filled in. */
export function metricSection(s: Omit<MetricSection, "kind">): MetricSection {
  return { kind: "metric", ...s };
}

/** @return a ScalarSection with kind filled in. */
export function scalarSection(s: Omit<ScalarSection, "kind">): ScalarSection {
  return { kind: "scalar", ...s };
}

/** @return a metric section's verdict stat, defaulting to "mean". */
export function metricStatKind(s: MetricSection): StatKind {
  return s.statKind ?? "mean";
}

/** @return the metric's display value: statKind over samples, then toDisplay.
 *  Pass statSamples to use a trimmed sample array (defaults to results.samples). */
export function metricValue(
  section: MetricSection,
  results: MeasuredResults,
  metadata?: UnknownRecord,
  statSamples?: number[],
): number {
  const samples = statSamples ?? results.samples;
  const raw = computeStat(samples, metricStatKind(section));
  return section.toDisplay ? section.toDisplay(raw, metadata) : raw;
}

/** @return scalar row values keyed by row key/title. */
export function scalarValues(
  rows: ScalarRow[],
  results: MeasuredResults,
  metadata?: UnknownRecord,
): UnknownRecord {
  return Object.fromEntries(
    rows.map(row => [row.key ?? row.title, row.value(results, metadata)]),
  );
}

/** All reports in a group, including each report's own baseline and the
 *  group baseline, de-duplicated (per-report baselines may repeat the group
 *  baseline, or share measured results across reports). */
export function groupReports(group: ReportGroup): BenchmarkReport[] {
  const seen = new Set<MeasuredResults>();
  const out: BenchmarkReport[] = [];
  const add = (r?: BenchmarkReport) => {
    if (!r || seen.has(r.measuredResults)) return;
    seen.add(r.measuredResults);
    out.push(r);
  };
  for (const report of group.reports) {
    add(report);
    add(report.baseline);
  }
  add(group.baseline);
  return out;
}

/** True if any result in the groups has the specified field with a defined value */
export function hasField(
  groups: ReportGroup[],
  field: keyof MeasuredResults,
): boolean {
  return groups.some(group =>
    groupReports(group).some(
      ({ measuredResults }) => measuredResults[field] !== undefined,
    ),
  );
}
