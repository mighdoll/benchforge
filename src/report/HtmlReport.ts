import { cliDefaults } from "../cli/CliArgs.ts";
import type { CoverageData } from "../profiling/node/CoverageTypes.ts";
import {
  filterSites,
  flattenProfile,
  totalBytes,
} from "../profiling/node/HeapSampleReport.ts";
import type { HeapProfile } from "../profiling/node/HeapSampler.ts";
import { resolveProfile } from "../profiling/node/ResolvedProfile.ts";
import type { MeasuredResults } from "../runners/MeasuredResults.ts";
import type { DifferenceCI } from "../stats/StatisticalUtils.ts";
import type {
  BenchmarkEntry,
  BenchmarkGroup,
  CoverageSummary,
  HeapSummary,
  ReportData,
  ViewerSection,
} from "../viewer/ReportData.ts";
import {
  type BenchmarkReport,
  type ComparisonOptions,
  hasField,
  type ReportGroup,
  type ReportSection,
  type UnknownRecord,
} from "./BenchmarkReport.ts";
import { gcStatsSection } from "./GcSections.ts";
import type { GitVersion } from "./GitUtils.ts";
import {
  buildTimeSection,
  optSection,
  runsSection,
} from "./StandardSections.ts";
import {
  buildViewerSections,
  hasLowBatchCount,
  isSingleBatch,
  minBatches,
} from "./ViewerSections.ts";

/** Options for prepareHtmlData: report sections, git versions, and CLI args */
export interface PrepareHtmlOptions extends ComparisonOptions {
  cliArgs?: Record<string, unknown>;
  sections?: ReportSection[];
  currentVersion?: GitVersion;
  baselineVersion?: GitVersion;
}

/** Context shared across reports in a group */
interface GroupContext {
  baseM?: MeasuredResults;
  baseMeta?: UnknownRecord;
  sections?: ReportSection[];
  comparison?: ComparisonOptions;
  lowBatches: boolean;
}

/** Convert benchmark results into a ReportData payload for the HTML viewer */
export function prepareHtmlData(
  groups: ReportGroup[],
  options: PrepareHtmlOptions,
): ReportData {
  const { cliArgs, currentVersion, baselineVersion, equivMargin, noBatchTrim } =
    options;
  const comparison: ComparisonOptions = { equivMargin, noBatchTrim };
  const sections = options.sections ?? defaultSections(groups, cliArgs);
  return {
    groups: groups.map(g => prepareGroupData(g, sections, comparison)),
    metadata: {
      timestamp: new Date().toISOString(),
      bencherVersion: process.env.npm_package_version || "unknown",
      cliArgs,
      cliDefaults,
      gcTrackingEnabled: cliArgs?.["gc-stats"] === true,
      currentVersion,
      baselineVersion,
      environment: {
        node: process.version,
        platform: process.platform,
        arch: process.arch,
      },
    },
  };
}

/** Build default sections when caller doesn't provide custom ones */
function defaultSections(
  groups: ReportGroup[],
  cliArgs?: Record<string, unknown>,
): ReportSection[] {
  const hasGc = cliArgs?.["gc-stats"] === true;
  const hasOpt = hasField(groups, "optStatus");
  const stats = typeof cliArgs?.stats === "string" ? cliArgs.stats : undefined;
  return [
    buildTimeSection(stats),
    hasGc ? gcStatsSection : undefined,
    hasOpt ? optSection : undefined,
    runsSection,
  ].filter((s): s is ReportSection => s !== undefined);
}

/** @return group data with structured ViewerSections and bootstrap CIs */
function prepareGroupData(
  group: ReportGroup,
  sections?: ReportSection[],
  comparison?: ComparisonOptions,
): BenchmarkGroup {
  const base = group.baseline;
  const baseM = base?.measuredResults;
  const baseline = base
    ? { ...prepareBenchmarkData(base), comparisonCI: undefined }
    : undefined;
  const curM = group.reports[0]?.measuredResults;
  const singleBatch = isSingleBatch(baseM, curM);
  const lowBatches = hasLowBatchCount(baseM, curM);
  const baseMeta = base?.metadata;
  const ctx: GroupContext = {
    baseM,
    baseMeta,
    sections,
    comparison,
    lowBatches,
  };

  return {
    name: group.name,
    baseline,
    warnings: buildWarnings(singleBatch, lowBatches),
    benchmarks: group.reports.map(r => prepareReportEntry(r, ctx)),
  };
}

/** @return benchmark data with samples, stats, and profiling summaries */
function prepareBenchmarkData(report: {
  name: string;
  measuredResults: MeasuredResults;
  metadata?: UnknownRecord;
}): Omit<BenchmarkEntry, "comparisonCI" | "sections"> {
  const { measuredResults: m, name } = report;
  return {
    name,
    samples: m.samples,
    warmupSamples: m.warmupSamples,
    allocationSamples: m.allocationSamples,
    heapSamples: m.heapSamples,
    gcEvents: m.nodeGcTime?.events,
    optSamples: m.optSamples,
    pausePoints: m.pausePoints,
    batchOffsets: m.batchOffsets,
    stats: m.time,
    heapSize: m.heapSize,
    totalTime: m.totalTime,
    heapSummary: m.heapProfile ? summarizeHeap(m.heapProfile) : undefined,
    coverageSummary: m.coverage ? summarizeCoverage(m.coverage) : undefined,
  };
}

function buildWarnings(
  singleBatch: boolean,
  lowBatches: boolean,
): string[] | undefined {
  const parts: string[] = [];
  const singleMsg =
    "Confidence intervals may be too narrow (single batch). Use --batches for more accurate intervals.";
  if (singleBatch) parts.push(singleMsg);
  if (lowBatches)
    parts.push(
      `Too few batches for reliable comparison (need ${minBatches}+).`,
    );
  return parts.length ? parts : undefined;
}

/** @return a single benchmark entry with sections and comparison CI */
function prepareReportEntry(
  report: BenchmarkReport,
  ctx: GroupContext,
): BenchmarkEntry {
  const m = report.measuredResults;
  const sectionCtx = {
    current: m,
    baseline: ctx.baseM,
    currentMeta: report.metadata,
    baselineMeta: ctx.baseMeta,
    comparison: ctx.comparison,
  };
  const sections = ctx.sections
    ? buildViewerSections(ctx.sections, sectionCtx)
    : undefined;
  // Primary CI comes from the first primary row's comparisonCI (avoids duplicate bootstrap)
  const comparisonCI = findPrimarySectionCI(sections);
  return { ...prepareBenchmarkData(report), sections, comparisonCI };
}

/** Compute heap allocation summary from profile */
function summarizeHeap(profile: HeapProfile): HeapSummary {
  const resolved = resolveProfile(profile);
  const userSites = filterSites(flattenProfile(resolved));
  return { totalBytes: resolved.totalBytes, userBytes: totalBytes(userSites) };
}

/** Compute coverage summary from V8 coverage data */
function summarizeCoverage(coverage: CoverageData): CoverageSummary {
  const fns = coverage.scripts.flatMap(s => s.functions);
  const called = fns.filter(
    fn => fn.ranges.length > 0 && fn.ranges[0].count > 0,
  );
  const totalCalls = called.reduce((sum, fn) => sum + fn.ranges[0].count, 0);
  return { functionCount: called.length, totalCalls };
}

/** Extract the comparison CI from the first primary row across all sections */
function findPrimarySectionCI(
  sections: ViewerSection[] | undefined,
): DifferenceCI | undefined {
  if (!sections) return undefined;
  for (const section of sections) {
    for (const row of section.rows) {
      if (row.primary && row.comparisonCI) return row.comparisonCI;
    }
  }
  return undefined;
}
