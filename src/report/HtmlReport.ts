import { cliDefaults } from "../cli/CliArgs.ts";
import type { CoverageData } from "../profiling/node/CoverageTypes.ts";
import {
  filterSites,
  flattenProfile,
  totalBytes,
} from "../profiling/node/HeapSampleReport.ts";
import type { HeapProfile } from "../profiling/node/HeapSampler.ts";
import { resolveProfile } from "../profiling/node/ResolvedProfile.ts";
import type { GcEvent } from "../runners/GcStats.ts";
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
  GcEvent as ViewerGcEvent,
  ViewerSection,
} from "../viewer/ReportData.ts";
import type {
  BenchmarkReport,
  ComparisonOptions,
  ReportGroup,
  ReportSection,
  UnknownRecord,
} from "./BenchmarkReport.ts";
import { gcByBatch } from "./GcByBatch.ts";
import { gcStatsSection } from "./GcSections.ts";
import type { GitVersion } from "./GitUtils.ts";
import { runsSection, timeSection } from "./StandardSections.ts";
import {
  buildViewerSections,
  hasLowBatchCount,
  isSingleBatch,
  minBatches,
  type SectionCICache,
} from "./ViewerSections.ts";
import { warmupShape } from "./WarmupShape.ts";

/** Options for prepareHtmlData: report sections, git versions, and CLI args */
export interface PrepareHtmlOptions extends ComparisonOptions {
  cliArgs?: Record<string, unknown>;
  sections?: ReportSection[];
  currentVersion?: GitVersion;
  baselineVersion?: GitVersion;
}

/** Context shared across reports in a group. The group baseline is the fallback
 *  for reports without their own paired baseline. */
interface GroupContext {
  baseM?: MeasuredResults;
  baseMeta?: UnknownRecord;
  baseName?: string;
  sections?: ReportSection[];
  comparison?: ComparisonOptions;
}

/** Viewer sections plus the per-section bootstrap caches that produced them. */
type ViewerView = { sections: ViewerSection[]; caches: SectionCICache[] };

/** Current + baseline results and metadata, before the trim/no-trim choice. */
interface BaseContext {
  current: MeasuredResults;
  baseline?: MeasuredResults;
  currentMeta?: UnknownRecord;
  baselineMeta?: UnknownRecord;
  baselineName?: string;
}

/** Convert benchmark results into a ReportData payload for the HTML viewer */
export function prepareHtmlData(
  groups: ReportGroup[],
  options: PrepareHtmlOptions,
): ReportData {
  const { cliArgs, currentVersion, baselineVersion, equivMargin, noBatchTrim } =
    options;
  const comparison: ComparisonOptions = {
    equivMargin,
    noBatchTrim,
    resamples: options.resamples,
  };
  const sections = options.sections ?? defaultSections(cliArgs);
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
  cliArgs?: Record<string, unknown>,
): ReportSection[] {
  const hasGc = cliArgs?.["gc-stats"] === true;
  return [
    timeSection,
    hasGc ? gcStatsSection : undefined,
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
  const baseline = base
    ? { ...prepareBenchmarkData(base), comparisonCI: undefined }
    : undefined;
  const ctx: GroupContext = {
    baseM: base?.measuredResults,
    baseMeta: base?.metadata,
    baseName: base?.name,
    sections,
    comparison,
  };

  const benchmarks = group.reports.map(r => prepareReportEntry(r, ctx));
  return {
    name: group.name,
    baseline,
    warnings: groupWarnings(group, ctx),
    benchmarks,
  };
}

/** Worst-case batch-reliability warnings across the group, using each report's
 *  effective baseline (its own paired baseline, else the group baseline). */
function groupWarnings(
  group: ReportGroup,
  ctx: GroupContext,
): string[] | undefined {
  const noTrim = ctx.comparison?.noBatchTrim;
  let singleBatch = false;
  let lowBatches = false;
  for (const report of group.reports) {
    const baseM = (report.baseline ?? group.baseline)?.measuredResults;
    const curM = report.measuredResults;
    singleBatch ||= isSingleBatch(baseM, curM);
    lowBatches ||= hasLowBatchCount(baseM, curM, noTrim);
  }
  return buildWarnings(singleBatch, lowBatches);
}

/** @return benchmark data with samples, stats, and profiling summaries */
function prepareBenchmarkData(
  report: BenchmarkReport,
): Omit<BenchmarkEntry, "comparisonCI" | "sections"> {
  const { measuredResults: m, name, metadata } = report;
  return {
    name,
    metadata,
    samples: m.samples,
    warmupSamples: m.warmupSamples,
    allocationSamples: m.allocationSamples,
    heapSamples: m.heapSamples,
    gcEvents: viewerGcEvents(m.gcEvents),
    pausePoints: m.pausePoints,
    batchOffsets: m.batchOffsets,
    gcByBatch: gcByBatch(m),
    warmupShape: warmupShape(m),
    stats: m.time,
    heapSize: m.heapSize,
    totalTime: m.totalTime,
    heapSummary: m.heapProfile ? summarizeHeap(m.heapProfile) : undefined,
    coverageSummary: m.coverage ? summarizeCoverage(m.coverage) : undefined,
  };
}

/** Map engine GC events to the viewer's {offset, duration} shape, keeping only
 *  events whose offset was rebased to loop-relative time (others can't be placed
 *  on the time-series axis). */
function viewerGcEvents(
  events: GcEvent[] | undefined,
): ViewerGcEvent[] | undefined {
  const placed = events?.filter(e => e.offset !== undefined);
  if (!placed?.length) return undefined;
  return placed.map(e => ({
    offset: e.offset!,
    duration: e.pauseMs,
    type: e.type,
    collected: e.collected,
  }));
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

/** @return a single benchmark entry with its trimmed sections and, when trimming
 *  changed something, the raw (untrimmed) sections for the UI toggle. */
function prepareReportEntry(
  report: BenchmarkReport,
  ctx: GroupContext,
): BenchmarkEntry {
  const base = report.baseline;
  const baseCtx = {
    current: report.measuredResults,
    baseline: base?.measuredResults ?? ctx.baseM,
    currentMeta: report.metadata,
    baselineMeta: base?.metadata ?? ctx.baseMeta,
    baselineName: base?.name ?? ctx.baseName,
  };
  const trimmedView = ctx.sections
    ? buildViewerSections(ctx.sections, {
        ...baseCtx,
        comparison: ctx.comparison,
      })
    : undefined;
  const rawView = buildRawView(ctx, baseCtx, trimmedView);

  const baseline = base
    ? { ...prepareBenchmarkData(base), comparisonCI: undefined }
    : undefined;
  return {
    ...prepareBenchmarkData(report),
    sections: trimmedView?.sections,
    rawSections: rawView?.sections,
    comparisonCI: findPrimarySectionCI(trimmedView?.sections),
    rawComparisonCI: findPrimarySectionCI(rawView?.sections),
    baseline,
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

/** @return the untrimmed section view, or undefined when trimming changed
 *  nothing (the raw view would equal the trimmed one). Reuses the trimmed
 *  view's bootstrap result for any side trimming left untouched. */
function buildRawView(
  ctx: GroupContext,
  baseCtx: BaseContext,
  trimmedView: ViewerView | undefined,
): ViewerView | undefined {
  if (!ctx.sections) return undefined;
  const noTrim = ctx.comparison?.noBatchTrim === true;
  const trimCount = (mr?: MeasuredResults) =>
    !mr || noTrim
      ? 0
      : trimOutlierBatches(mr.samples, mr.batchOffsets).trimCount;
  const curTrimCount = trimCount(baseCtx.current);
  const baseTrimCount = trimCount(baseCtx.baseline);
  if (curTrimCount === 0 && baseTrimCount === 0) return undefined;

  const reuse = trimmedView?.caches.map(c => ({
    cur: curTrimCount === 0 ? c.cur : undefined,
    base: baseTrimCount === 0 ? c.base : undefined,
    // diff depends on both sides; only safe to reuse when neither was trimmed
    diff: undefined,
  }));
  const rawCtx = {
    ...baseCtx,
    comparison: { ...ctx.comparison, noBatchTrim: true },
  };
  return buildViewerSections(ctx.sections, rawCtx, reuse);
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
