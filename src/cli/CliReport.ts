import type { CaseResult, MatrixResults } from "../matrix/BenchMatrix.ts";
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
import type {
  BenchmarkReport,
  ReportGroup,
  ReportSection,
} from "../report/BenchmarkReport.ts";
import { groupReports } from "../report/BenchmarkReport.ts";
import colors from "../report/Colors.ts";
import { gcStatsSection } from "../report/GcSections.ts";
import type { GitVersion } from "../report/GitUtils.ts";
import { prepareHtmlData } from "../report/HtmlReport.ts";
import { runsSection, timeSection } from "../report/StandardSections.ts";
import type { ReportData } from "../viewer/ReportData.ts";
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

/** Roll up the matrix verdicts from the prepared report data into a tally line. */
export function defaultMatrixReport(data: ReportData): string {
  return reportMatrixResults(data);
}

/** Convert MatrixResults to ReportGroup[]: one group per case, with each
 *  variant a report in it. Variants compared against a baseline carry their own
 *  paired (interleaved) baseline, so each variant is measured against its own
 *  reference rather than a single shared one. */
export function matrixToReportGroups(results: MatrixResults[]): ReportGroup[] {
  return results.flatMap(caseGroups);
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
    // baseline would mislabel "vs <one variant>" for the others).
    return { name, reports };
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
        name: `${baselineId ?? variantId} (baseline)`,
        measuredResults: baselineMeasured,
        metadata,
      }
    : undefined;
  return { name: variantId, measuredResults: c.measured, metadata, baseline };
}

/** Assemble report sections from CLI flags (time/gc/runs). */
export function buildReportSections(gcStats: boolean): ReportSection[] {
  return [
    timeSection,
    ...(gcStats ? [gcStatsSection] : []),
    runsSection,
  ];
}

/** Build sections from CLI feature flags (time/gc/runs). */
function cliDefaultSections(args: DefaultCliArgs): ReportSection[] {
  const { "gc-stats": gcStats } = args;
  return buildReportSections(gcStats);
}
