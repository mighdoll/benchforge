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
import type { ReportGroup, ResultsMapper } from "../report/BenchmarkReport.ts";
import { groupReports } from "../report/BenchmarkReport.ts";
import colors from "../report/Colors.ts";
import {
  adaptiveSection,
  formatTierSummary,
  gcStatsSection,
  optSection,
  runsSection,
  timeSection,
  totalTimeSection,
} from "../report/StandardSections.ts";
import { reportResults } from "../report/text/TextReport.ts";
import type { MeasuredResults } from "../runners/MeasuredResults.ts";
import type { DefaultCliArgs } from "./CliArgs.ts";

const { yellow, dim } = colors;

/** Generate table with standard sections */
export function defaultReport(
  groups: ReportGroup[],
  args: DefaultCliArgs,
): string {
  const { adaptive, "gc-stats": gcStats, "trace-opt": traceOpt } = args;
  const hasOpt = hasField(groups, "optStatus");
  const sections = buildReportSections(adaptive, gcStats, traceOpt && hasOpt);
  return reportResults(groups, sections);
}

/** Build report sections based on CLI options */
export function buildReportSections(
  adaptive: boolean,
  gcStats: boolean,
  hasOptData: boolean,
): ResultsMapper<any>[] {
  return [
    ...(adaptive ? [adaptiveSection, totalTimeSection] : [timeSection]),
    ...(gcStats ? [gcStatsSection] : []),
    ...(hasOptData ? [optSection] : []),
    runsSection,
  ];
}

/** @return true if any result has the specified field with a defined value */
export function hasField(
  results: ReportGroup[],
  field: keyof MeasuredResults,
): boolean {
  return results.some(group =>
    groupReports(group).some(
      ({ measuredResults }) => measuredResults[field] !== undefined,
    ),
  );
}

/** Log V8 optimization tier distribution and deoptimizations */
export function reportOptStatus(groups: ReportGroup[]): void {
  const optData = groups.flatMap(group =>
    groupReports(group)
      .filter(r => r.measuredResults.optStatus)
      .map(r => ({
        name: r.name,
        opt: r.measuredResults.optStatus!,
        samples: r.measuredResults.samples.length,
      })),
  );
  if (optData.length === 0) return;

  console.log(dim("\nV8 optimization:"));
  for (const { name, opt, samples } of optData) {
    const tierParts = formatTierSummary(opt, " ", ", ");
    console.log(`  ${name}: ${tierParts} ${dim(`(${samples} samples)`)}`);
  }

  const deopts = optData.reduce((s, d) => s + d.opt.deoptCount, 0);
  if (deopts > 0) {
    const s = deopts > 1 ? "s" : "";
    console.log(yellow(`  ⚠ ${deopts} deoptimization${s} detected`));
  }
}

/** Print heap allocation reports for benchmarks with heap profiles */
export function printHeapReports(
  groups: ReportGroup[],
  options: HeapReportOptions,
): void {
  const reports = groups.flatMap(g => groupReports(g));
  for (const report of reports) {
    const { heapProfile } = report.measuredResults;
    if (!heapProfile) continue;

    console.log(dim(`\n─── Heap profile: ${report.name} ───`));
    const resolved = resolveProfile(heapProfile);
    const sites = flattenProfile(resolved);
    const userSites = filterSites(sites, options.isUserCode);
    const agg = aggregateSites(options.userOnly ? userSites : sites);
    const extra = {
      totalAll: resolved.totalBytes,
      totalUserCode: userSites.reduce((sum, s) => sum + s.bytes, 0),
      sampleCount: resolved.sortedSamples?.length,
    };
    console.log(formatHeapReport(agg, { ...options, ...extra }));
    if (options.raw) {
      console.log(dim(`\n─── Raw samples: ${report.name} ───`));
      console.log(formatRawSamples(resolved));
    }
  }
}

/** Generate report for matrix results */
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

/** Convert MatrixResults to ReportGroup[] for export compatibility */
export function matrixToReportGroups(results: MatrixResults[]): ReportGroup[] {
  return results.flatMap(matrix =>
    matrix.variants.flatMap(variant =>
      variant.cases.map(c => {
        const { metadata } = c;
        const report = {
          name: variant.id,
          measuredResults: c.measured,
          metadata,
        };
        const baseline = c.baseline
          ? {
              name: `${variant.id} (baseline)`,
              measuredResults: c.baseline,
              metadata,
            }
          : undefined;
        return {
          name: `${variant.id} / ${c.caseId}`,
          reports: [report],
          baseline,
        };
      }),
    ),
  );
}

/** Apply default sections and extra columns for matrix reports */
function mergeMatrixDefaults(
  reportOptions: MatrixReportOptions | undefined,
  args: DefaultCliArgs,
  results: MatrixResults[],
): MatrixReportOptions {
  const merged: MatrixReportOptions = { ...reportOptions };
  if (!merged.sections?.length) {
    const groups = matrixToReportGroups(results);
    const hasOpt = args["trace-opt"] && hasField(groups, "optStatus");
    const { adaptive, "gc-stats": gcStats } = args;
    merged.sections = buildReportSections(adaptive, gcStats, hasOpt);
  }
  return merged;
}
