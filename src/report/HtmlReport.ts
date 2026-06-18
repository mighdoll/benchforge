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
import { trimOutlierBatches } from "../stats/BlockBootstrap.ts";
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
} from "./BenchmarkReport.ts";
import { hasLowBatchCount, isSingleBatch, minBatches } from "./CiFormatting.ts";
import { gcByBatch } from "./GcByBatch.ts";
import type { GitVersion } from "./GitUtils.ts";
import { defaultReportSections } from "./StandardSections.ts";
import { resolveTracks } from "./TrackResolution.ts";
import {
  buildViewerSections,
  type CaseContext,
  type CaseTrack,
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

/** Convert benchmark results into a ReportData payload for the HTML viewer */
export function prepareHtmlData(
  groups: ReportGroup[],
  options: PrepareHtmlOptions,
): ReportData {
  const { cliArgs, currentVersion, baselineVersion } = options;
  const { equivMargin, noBatchTrim, resamples } = options;
  const comparison: ComparisonOptions = { equivMargin, noBatchTrim, resamples };
  const sections =
    options.sections ?? defaultReportSections(cliArgs?.["gc-stats"] === true);
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

/** @return case data: raw per-series benchmarks plus the case-level,
 *  track-columned sections (trimmed + raw views). */
function prepareGroupData(
  group: ReportGroup,
  sections?: ReportSection[],
  comparison?: ComparisonOptions,
): BenchmarkGroup {
  const built = sections
    ? buildCaseSections(sections, resolveTracks(group), comparison)
    : undefined;
  return {
    name: group.name,
    baseline: group.baseline ? prepareBenchmarkData(group.baseline) : undefined,
    benchmarks: group.reports.map(benchmarkEntry),
    warnings: groupWarnings(group, comparison),
    sections: built?.sections,
    rawSections: built?.rawSections,
  };
}

/** Build the case-level trimmed sections plus the raw (untrimmed) view when
 *  trimming changed something. */
function buildCaseSections(
  sections: ReportSection[],
  tracks: CaseTrack[],
  comparison?: ComparisonOptions,
): { sections: ViewerSection[]; rawSections?: ViewerSection[] } | undefined {
  if (!tracks.length) return undefined;
  const ctx: CaseContext = { tracks, comparison };
  const trimmed = buildViewerSections(sections, ctx);
  return {
    sections: trimmed.sections,
    rawSections: buildRawCaseSections(sections, ctx, trimmed.caches),
  };
}

/** @return raw per-series benchmark data (samples, stats, profiling summaries) */
function prepareBenchmarkData(report: BenchmarkReport): BenchmarkEntry {
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

/** A benchmark entry: raw per-series data plus its own paired baseline (for the
 *  analyze command's per-batch diagnostics). */
function benchmarkEntry(report: BenchmarkReport): BenchmarkEntry {
  const baseline = report.baseline
    ? prepareBenchmarkData(report.baseline)
    : undefined;
  return { ...prepareBenchmarkData(report), baseline };
}

/** Worst-case batch-reliability warnings across the group, using each report's
 *  effective baseline (its own paired baseline, else the group baseline). */
function groupWarnings(
  group: ReportGroup,
  comparison?: ComparisonOptions,
): string[] | undefined {
  const noTrim = comparison?.noBatchTrim;
  const pairs = group.reports.map(report => ({
    base: (report.baseline ?? group.baseline)?.measuredResults,
    cur: report.measuredResults,
  }));
  const singleBatch = pairs.some(p => isSingleBatch(p.base, p.cur));
  const lowBatches = pairs.some(p => hasLowBatchCount(p.base, p.cur, noTrim));
  return buildWarnings(singleBatch, lowBatches);
}

/** @return the untrimmed section view, or undefined when trimming changed
 *  nothing. Reuses the trimmed view's per-track bootstrap for tracks (and diffs)
 *  trimming left untouched. */
function buildRawCaseSections(
  sections: ReportSection[],
  ctx: CaseContext,
  trimmedCaches: SectionCICache[],
): ViewerSection[] | undefined {
  if (ctx.comparison?.noBatchTrim) return undefined;
  const untrimmed = (m?: MeasuredResults) =>
    !m || trimOutlierBatches(m.samples, m.batchOffsets).trimCount === 0;
  const anyTrimmed = ctx.tracks.some(
    t =>
      !untrimmed(t.measured) || (t.baseline && !untrimmed(t.baseline.measured)),
  );
  if (!anyTrimmed) return undefined;

  const reuse: SectionCICache[] = trimmedCaches.map(c => ({
    track: c.track?.map((r, i) =>
      untrimmed(ctx.tracks[i]?.measured) ? r : undefined,
    ),
    // diff depends on both sides; reuse only when neither was trimmed
    diff: c.diff?.map((d, i) => {
      const t = ctx.tracks[i];
      const ok = untrimmed(t?.measured) && untrimmed(t?.baseline?.measured);
      return ok ? d : undefined;
    }),
  }));
  const rawCtx: CaseContext = {
    tracks: ctx.tracks,
    comparison: { ...ctx.comparison, noBatchTrim: true },
  };
  return buildViewerSections(sections, rawCtx, reuse).sections;
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

/** @return user-facing warning strings about CI reliability, or undefined if none apply */
function buildWarnings(
  singleBatch: boolean,
  lowBatches: boolean,
): string[] | undefined {
  const parts: string[] = [];
  const single =
    "Confidence intervals may be too narrow (single batch). Use --batches for more accurate intervals.";
  const low = `Too few batches for reliable comparison (need ${minBatches}+).`;
  if (singleBatch) parts.push(single);
  if (lowBatches) parts.push(low);
  return parts.length ? parts : undefined;
}
