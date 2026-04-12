import type { MatrixResults } from "../matrix/BenchMatrix.ts";
import type { MatrixReportOptions } from "../matrix/MatrixReport.ts";
import { reportMatrixResults } from "../matrix/MatrixReport.ts";
import {
  aggregateSites,
  filterSites,
  flattenProfile,
  formatHeapReport,
  formatRawSamples,
  type HeapReportOptions,
} from "../profiling/node/HeapSampleReport.ts";
import { resolveProfile } from "../profiling/node/ResolvedProfile.ts";
import type { ReportGroup, ReportSection } from "../report/BenchmarkReport.ts";
import { groupReports, hasField } from "../report/BenchmarkReport.ts";
import colors from "../report/Colors.ts";
import { gcStatsSection } from "../report/GcSections.ts";
import {
  adaptiveSections,
  buildTimeSection,
  formatTierSummary,
  optSection,
  runsSection,
  totalTimeSection,
} from "../report/StandardSections.ts";
import { reportResults } from "../report/text/TextReport.ts";
import type { DefaultCliArgs } from "./CliArgs.ts";
import { cliComparisonOptions } from "./CliOptions.ts";

/** Options for defaultReport: custom sections replace the CLI-derived defaults. */
export interface DefaultReportOptions {
  sections?: ReportSection[];
}

const { yellow, dim } = colors;

/** Show a transient status message on stderr, run a sync computation, then clear. */
export function withStatus<T>(msg: string, fn: () => T): T {
  process.stderr.write(`◊ ${msg}...\r`);
  const result = fn();
  process.stderr.write("\r" + " ".repeat(40) + "\r");
  return result;
}

/** Generate text report table with standard sections based on CLI args. */
export function defaultReport(
  groups: ReportGroup[],
  args: DefaultCliArgs,
  opts?: DefaultReportOptions,
): string {
  const sections = opts?.sections?.length
    ? opts.sections
    : cliDefaultSections(groups, args);
  return reportResults(groups, sections, cliComparisonOptions(args));
}

/** Log V8 optimization tier distribution and deoptimizations. */
export function reportOptStatus(groups: ReportGroup[]): void {
  const optData = groups.flatMap(group =>
    groupReports(group)
      .filter(r => r.measuredResults.optStatus)
      .map(({ name, measuredResults: m }) => ({
        name,
        opt: m.optStatus!,
        samples: m.samples.length,
      })),
  );
  if (optData.length === 0) return;

  console.log(dim("\nV8 optimization:"));
  for (const { name, opt, samples } of optData) {
    const tierParts = formatTierSummary(opt, " ", ", ");
    console.log(`  ${name}: ${tierParts} ${dim(`(${samples} samples)`)}`);
  }

  const totalDeopts = optData.reduce((sum, d) => sum + d.opt.deoptCount, 0);
  if (totalDeopts > 0) {
    const plural = totalDeopts > 1 ? "s" : "";
    console.log(yellow(`  ⚠ ${totalDeopts} deoptimization${plural} detected`));
  }
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

/** Format matrix benchmark results as text, applying default sections from CLI args. */
export function defaultMatrixReport(
  results: MatrixResults[],
  reportOptions?: MatrixReportOptions,
  args?: DefaultCliArgs,
): string {
  const options = args
    ? mergeMatrixDefaults(reportOptions, args, results)
    : reportOptions;
  return results.map(r => reportMatrixResults(r, options)).join("\n\n");
}

/** Convert MatrixResults to ReportGroup[] for the standard export pipeline. */
export function matrixToReportGroups(results: MatrixResults[]): ReportGroup[] {
  return results.flatMap(matrix =>
    matrix.variants.flatMap(variant =>
      variant.cases.map(c => caseToReportGroup(variant.id, c)),
    ),
  );
}

/** Assemble report sections from CLI flags. Under --adaptive, the
 *  adaptive section provides its own time columns and `stats` is ignored. */
export function buildReportSections(
  adaptive: boolean,
  gcStats: boolean,
  hasOptData: boolean,
  stats?: string,
): ReportSection[] {
  return [
    ...(adaptive
      ? [...adaptiveSections, totalTimeSection]
      : [buildTimeSection(stats)]),
    ...(gcStats ? [gcStatsSection] : []),
    ...(hasOptData ? [optSection] : []),
    runsSection,
  ];
}

/** Build sections from CLI feature flags (time/gc/opt/runs). */
function cliDefaultSections(
  groups: ReportGroup[],
  args: DefaultCliArgs,
): ReportSection[] {
  const { adaptive, "gc-stats": gcStats, "trace-opt": traceOpt, stats } = args;
  const hasOpt = hasField(groups, "optStatus");
  return buildReportSections(adaptive, gcStats, traceOpt && hasOpt, stats);
}

/** Apply default sections and extra columns for matrix reports. */
function mergeMatrixDefaults(
  opts: MatrixReportOptions | undefined,
  args: DefaultCliArgs,
  results: MatrixResults[],
): MatrixReportOptions {
  const merged: MatrixReportOptions = { ...opts };
  if (!merged.sections?.length) {
    const groups = matrixToReportGroups(results);
    const hasOpt = args["trace-opt"] && hasField(groups, "optStatus");
    merged.sections = buildReportSections(
      args.adaptive,
      args["gc-stats"],
      hasOpt,
      args.stats,
    );
  }
  if (!merged.comparison) merged.comparison = cliComparisonOptions(args);
  return merged;
}

/** Wrap a single matrix case and its optional baseline into a ReportGroup. */
function caseToReportGroup(
  variantId: string,
  c: MatrixResults["variants"][0]["cases"][0],
): ReportGroup {
  const { metadata, baseline: baselineMeasured } = c;
  const report = { name: variantId, measuredResults: c.measured, metadata };
  const baseline = baselineMeasured
    ? {
        name: `${variantId} (baseline)`,
        measuredResults: baselineMeasured,
        metadata,
      }
    : undefined;
  return { name: `${variantId} / ${c.caseId}`, reports: [report], baseline };
}
