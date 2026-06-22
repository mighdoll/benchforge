import type { CaseResult, MatrixResults } from "../matrix/BenchMatrix.ts";
import {
  formatHeapReport,
  formatRawSamples,
} from "../profiling/node/HeapReportFormatter.ts";
import {
  aggregateSites,
  filterSites,
  flattenProfile,
  type HeapReportOptions,
} from "../profiling/node/HeapSampleReport.ts";
import { resolveProfile } from "../profiling/node/ResolvedProfile.ts";
import type {
  BenchmarkReport,
  ReportGroup,
  ReportSection,
} from "../report/BenchmarkReport.ts";
import { groupReports } from "../report/BenchmarkReport.ts";
import colors from "../report/Colors.ts";
import {
  baselineLabel,
  formatPercentCI,
  formatSignedPercent,
  frameLocation,
  timeMs,
} from "../report/Formatters.ts";
import type { GitVersion } from "../report/GitUtils.ts";
import {
  type ProfileReportOptions,
  prepareHtmlData,
  profilesOf,
  summarizeTime,
} from "../report/HtmlReport.ts";
import { selfPerIterUs } from "../report/MarkdownReport.ts";
import { defaultReportSections } from "../report/StandardSections.ts";
import type { HotFunction, ReportData } from "../viewer/ReportData.ts";
import type { DefaultCliArgs } from "./CliArgs.ts";
import { cliComparisonOptions } from "./CliOptions.ts";

/** Options for defaultReportData: custom sections replace the CLI-derived
 *  defaults; versions are stamped into the report metadata. */
export interface DefaultReportOptions {
  sections?: ReportSection[];
  currentVersion?: GitVersion;
  baselineVersion?: GitVersion;
}

const { dim } = colors;

/** Show a transient status message on stderr, run a sync computation, then clear. */
export function withStatus<T>(msg: string, fn: () => T): T {
  process.stderr.write(`◊ ${msg}...\r`);
  const result = fn();
  process.stderr.write("\r" + " ".repeat(40) + "\r");
  return result;
}

/** Build the report data once, using custom or CLI-derived sections. The bench
 *  pipeline reuses this for the console summary, markdown, and the viewer. */
export function defaultReportData(
  groups: ReportGroup[],
  args: DefaultCliArgs,
  opts?: DefaultReportOptions,
): ReportData {
  const sections = opts?.sections?.length
    ? opts.sections
    : cliDefaultSections(args);
  return prepareHtmlData(groups, {
    cliArgs: args,
    sections,
    currentVersion: opts?.currentVersion,
    baselineVersion: opts?.baselineVersion,
    ...cliComparisonOptions(args),
  });
}

/** Print heap allocation profiles for each benchmark in the report groups. */
export function printHeapReports(
  groups: ReportGroup[],
  options: HeapReportOptions,
): void {
  for (const report of groups.flatMap(g => groupReports(g))) {
    const { heapProfile } = report.measuredResults;
    if (!heapProfile) continue;
    console.log(dim(`\n─── Heap profile: ${report.name} ───`));
    const resolved = resolveProfile(heapProfile);
    const sites = flattenProfile(resolved);
    const userSites = filterSites(sites, options.isUserCode);
    const agg = aggregateSites(options.userOnly ? userSites : sites);
    const { totalBytes, sortedSamples } = resolved;
    const totalUserCode = userSites.reduce((sum, s) => sum + s.bytes, 0);
    const sampleCount = sortedSamples?.length;
    const heapOpts = {
      ...options,
      totalAll: totalBytes,
      totalUserCode,
      sampleCount,
    };
    console.log(formatHeapReport(agg, heapOpts));
    if (options.raw) {
      console.log(dim(`\n─── Raw samples: ${report.name} ───`));
      console.log(formatRawSamples(resolved));
    }
  }
}

/** Print the top CPU self-time functions for each profiled benchmark, with the
 *  per-function baseline delta when a baseline was also profiled. */
export function printTimeReports(
  groups: ReportGroup[],
  options: ProfileReportOptions,
): void {
  for (const report of groups.flatMap(g => groupReports(g))) {
    const cur = profilesOf(report.measuredResults);
    if (!cur.length) continue;
    const base = report.baseline && profilesOf(report.baseline.measuredResults);
    const summary = summarizeTime(
      cur,
      base || undefined,
      options,
      report.measuredResults.iterations,
    );
    if (!summary.rows.length) continue;
    const withBase = summary.rows.some(r => r.baseUs != null);
    console.log(dim(`\n─── CPU self-time per iteration: ${report.name} ───`));
    for (const row of summary.rows)
      console.log(formatHotRow(row, withBase, summary.iterations));
  }
}

/** One console hot-function row: right-aligned self time per iteration / percent
 *  / delta, then the function name and its dimmed source location. */
function formatHotRow(
  r: HotFunction,
  withBase: boolean,
  iterations?: number,
): string {
  const cols = [
    (timeMs(selfPerIterUs(r, iterations) / 1000) ?? "").padStart(9),
  ];
  cols.push(`${r.selfPct.toFixed(1)}%`.padStart(7));
  if (withBase) cols.push(deltaText(r).padStart(24));
  const loc = dim(frameLocation(r.url, r.line));
  return `${cols.join(" ")}  ${r.name || "(anonymous)"}  ${loc}`;
}

/** Share change with its 95% CI when enough batches supported one; "~" when
 *  matched but too few batches, "new" when the function had no baseline match. */
function deltaText(r: HotFunction): string {
  if (r.deltaPct != null && r.deltaCI)
    return `${formatSignedPercent(r.deltaPct)} ${formatPercentCI(r.deltaCI)}`;
  return r.baseUs != null ? "~" : "new";
}

/** Convert MatrixResults to ReportGroup[]: one group per case, each variant a
 *  report in it carrying its own paired baseline (see caseGroups). */
export function matrixToReportGroups(results: MatrixResults[]): ReportGroup[] {
  return results.flatMap(caseGroups);
}

/** Build sections from CLI feature flags (time/gc/runs). */
function cliDefaultSections(args: DefaultCliArgs): ReportSection[] {
  return defaultReportSections(args["gc-stats"]);
}

/** One ReportGroup per case in a matrix, preserving case order across variants. */
function caseGroups(matrix: MatrixResults): ReportGroup[] {
  const order: string[] = [];
  const byCase = new Map<string, BenchmarkReport[]>();
  for (const variant of matrix.variants) {
    for (const c of variant.cases) {
      if (!byCase.has(c.caseId)) {
        byCase.set(c.caseId, []);
        order.push(c.caseId);
      }
      byCase.get(c.caseId)!.push(variantReport(variant.id, c));
    }
  }
  const single = order.length === 1;
  return order.map(caseId => {
    const reports = byCase.get(caseId)!;
    const name = single ? matrix.name : `${matrix.name} / ${caseId}`;
    // No group-level baseline: each variant carries its own (a single shared
    // baseline would mislabel "vs <one variant>" for the others). The shared
    // baseline variant is named instead, so the viewer can label it.
    return {
      name,
      reports,
      baselineVariantId: baselineVariantId(matrix, caseId),
    };
  });
}

/** One variant's report for a case, carrying its own interleaved baseline. The
 *  baseline is named for the variant that produced it (the reference variant for
 *  baselineVariant, this variant's own id for a baselineDir comparison), not the
 *  current variant. */
function variantReport(variantId: string, c: CaseResult): BenchmarkReport {
  const { metadata, baseline: baselineMeasured, baselineId } = c;
  const baseline = baselineMeasured
    ? {
        name: baselineLabel(baselineId ?? variantId),
        measuredResults: baselineMeasured,
        metadata,
      }
    : undefined;
  return { name: variantId, measuredResults: c.measured, metadata, baseline };
}

/** @return the sibling variant id used as the shared baseline for a case, when
 *  there is exactly one (baselineVariant mode). Undefined when each variant is
 *  its own baseline (baselineDir version comparison) or there is no baseline.
 *
 *  The configured `matrix.baselineVariant` is authoritative: it selects
 *  peer-baseline mode even when the reference variant was filtered out (the
 *  surviving variants still diff against their own interleaved measurement of
 *  it). Fall back to inferring the shared ref from the cases' baselineIds when
 *  the matrix didn't carry a configured baselineVariant. */
function baselineVariantId(
  matrix: MatrixResults,
  caseId: string,
): string | undefined {
  const caseUsesBaseline = matrix.variants.some(v =>
    Boolean(v.cases.find(c => c.caseId === caseId)?.baselineId),
  );
  if (matrix.baselineVariant)
    return caseUsesBaseline ? matrix.baselineVariant : undefined;

  const variantIds = new Set(matrix.variants.map(v => v.id));
  const refs = new Set<string>();
  for (const variant of matrix.variants) {
    const baselineId = variant.cases.find(c => c.caseId === caseId)?.baselineId;
    if (baselineId && baselineId !== variant.id && variantIds.has(baselineId))
      refs.add(baselineId);
  }
  return refs.size === 1 ? [...refs][0] : undefined;
}
