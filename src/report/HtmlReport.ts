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
import {
  type DifferenceCI,
  trimOutlierBatches,
} from "../stats/StatisticalUtils.ts";
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
  type SectionCICache,
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
  const lowBatches = hasLowBatchCount(baseM, curM, comparison?.noBatchTrim);
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
  const { measuredResults: m, name, metadata } = report;
  return {
    name,
    metadata,
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

/** @return user-facing warning strings about CI reliability, or undefined if none apply */
function buildWarnings(
  singleBatch: boolean,
  lowBatches: boolean,
): string[] | undefined {
  const parts: string[] = [];
  if (singleBatch)
    parts.push(
      "Confidence intervals may be too narrow (single batch). Use --batches for more accurate intervals.",
    );
  if (lowBatches)
    parts.push(
      `Too few batches for reliable comparison (need ${minBatches}+).`,
    );
  return parts.length ? parts : undefined;
}

/** @return a single benchmark entry with both trimmed and raw section views.
 *  When trimming was a no-op for a side, the raw view reuses the trimmed view's
 *  per-side bootstrap result for that side. When it was a no-op for both sides,
 *  the raw view is identical to the trimmed view and is omitted from the
 *  entry, hiding the toggle in the UI. */
function prepareReportEntry(
  report: BenchmarkReport,
  ctx: GroupContext,
): BenchmarkEntry {
  const m = report.measuredResults;
  const baseCtx = {
    current: m,
    baseline: ctx.baseM,
    currentMeta: report.metadata,
    baselineMeta: ctx.baseMeta,
  };
  const trimmedView = ctx.sections
    ? buildViewerSections(ctx.sections, {
        ...baseCtx,
        comparison: ctx.comparison,
      })
    : undefined;

  const noTrim = ctx.comparison?.noBatchTrim === true;
  const trimCount = (mr?: MeasuredResults) =>
    !mr || noTrim
      ? 0
      : trimOutlierBatches(mr.samples, mr.batchOffsets).trimCount;
  const curTrimCount = trimCount(m);
  const baseTrimCount = trimCount(ctx.baseM);
  const anyTrimmed = curTrimCount > 0 || baseTrimCount > 0;

  let rawView:
    | { sections: ViewerSection[]; caches: SectionCICache[] }
    | undefined;
  if (ctx.sections && anyTrimmed) {
    const reuse: SectionCICache[] | undefined = trimmedView?.caches.map(c => ({
      cur: curTrimCount === 0 ? c.cur : undefined,
      base: baseTrimCount === 0 ? c.base : undefined,
      // diff depends on both sides; only safe to reuse when neither was trimmed
      diff: undefined,
    }));
    const rawCtx = {
      ...baseCtx,
      comparison: { ...ctx.comparison, noBatchTrim: true },
    };
    rawView = buildViewerSections(ctx.sections, rawCtx, reuse);
  }

  return {
    ...prepareBenchmarkData(report),
    sections: trimmedView?.sections,
    rawSections: rawView?.sections,
    comparisonCI: findPrimarySectionCI(trimmedView?.sections),
    rawComparisonCI: rawView
      ? findPrimarySectionCI(rawView.sections)
      : undefined,
  };
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
