import { cliDefaults } from "../cli/CliArgs.ts";
import type { CoverageData } from "../profiling/node/CoverageTypes.ts";
import {
  filterSites,
  flattenProfile,
  isNodeUserCode,
  totalBytes,
} from "../profiling/node/HeapSampleReport.ts";
import type { HeapProfile } from "../profiling/node/HeapSampler.ts";
import { resolveProfile } from "../profiling/node/ResolvedProfile.ts";
import {
  poolFolds,
  siteKey,
  sortedTimeSites,
  summarizeTimeProfile,
  type TimeFold,
} from "../profiling/node/TimeSampleReport.ts";
import type { TimeProfile } from "../profiling/node/TimeSampler.ts";
import type { GcEvent } from "../runners/GcStats.ts";
import type { MeasuredResults } from "../runners/MeasuredResults.ts";
import {
  splitByOffsets,
  trimOutlierBatches,
  tukeyKeep,
} from "../stats/BlockBootstrap.ts";
import {
  computeInterval,
  defaultConfidence,
  resampleInto,
} from "../stats/Bootstrap.ts";
import { mean } from "../stats/CoreStats.ts";
import type {
  BenchmarkEntry,
  BenchmarkGroup,
  CoverageSummary,
  HeapSummary,
  ProfileSummary,
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

/** How many CPU self-time rows to show and whether to hide runtime internals. */
export interface ProfileReportOptions {
  topN: number;
  userOnly: boolean;
}

const defaultProfileOptions: ProfileReportOptions = {
  topN: 20,
  userOnly: false,
};

/** Minimum batches for a per-function delta CI, and the bootstrap resample count.
 *  A function's self-time share is one number per batch, so the CI is a block
 *  bootstrap over batches (its width is set by batch count, not batch length --
 *  prefer many short batches). Below the floor the share spread can't be
 *  estimated and the delta is withheld. */
const minDeltaBatches = 4;
const deltaResamples = 2000;

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
  const profile = profileOptions(cliArgs);
  return {
    groups: groups.map(g => prepareGroupData(g, sections, comparison, profile)),
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

/** The CPU profiles to pool for a result: every batch's profile when present,
 *  else the single last-batch profile (unbatched / single-batch runs). */
export function profilesOf(m: MeasuredResults): TimeProfile[] {
  if (m.timeProfiles?.length) return m.timeProfiles;
  return m.timeProfile ? [m.timeProfile] : [];
}

/** Profiles plus the iteration count they cover, restricted to the batches the
 *  timing verdict keeps: drops slow-outlier batches with the same Tukey mask the
 *  headline stat uses, so the flamegraph and hot-functions summary describe the
 *  same population (a noisy batch's wall-clock ticks land on arbitrary frames,
 *  skewing self-time shares, not just adding ticks). Falls back to every profile
 *  when unbatched, trimming is off, or per-batch profiles aren't aligned with the
 *  batch boundaries. */
export function keptProfilesOf(
  m: MeasuredResults,
  noTrim?: boolean,
): { profiles: TimeProfile[]; iterations?: number } {
  const profiles = profilesOf(m);
  const offsets = m.batchOffsets;
  const aligned =
    !!offsets && offsets.length >= 2 && profiles.length === offsets.length;
  if (noTrim || !aligned) return { profiles, iterations: m.iterations };

  const means = splitByOffsets(m.samples, offsets).map(mean);
  const keep = tukeyKeep(means);
  if (keep.length === profiles.length)
    return { profiles, iterations: m.iterations };

  const iterations = m.batchIterations
    ? keep.reduce((sum, i) => sum + (m.batchIterations![i] ?? 0), 0)
    : undefined;
  return { profiles: keep.map(i => profiles[i]), iterations };
}

/** Top CPU self-time functions for the markdown report and console, optionally
 *  diffed against a baseline. Pools each side's per-batch profiles, joins by
 *  name+file (so a function matches across builds despite line drift), filters to
 *  user code when asked, then ranks by current self-time. A matched function
 *  carries a baseline delta and its 95% CI whenever both sides have enough batches
 *  to bootstrap the per-batch share spread; the CI (which may span 0, i.e. no
 *  clear change) is what shows whether the shift stands out from between-batch
 *  noise (profiler ticks are autocorrelated, so the run-to-run spread, not the
 *  tick count, is the honest error bar). */
export function summarizeTime(
  cur: TimeProfile[],
  base: TimeProfile[] | undefined,
  options: ProfileReportOptions = defaultProfileOptions,
  iterations?: number,
): ProfileSummary {
  const foldsCur = cur.map(summarizeTimeProfile);
  const foldsBase = base?.length ? base.map(summarizeTimeProfile) : undefined;
  const pooled = poolFolds(foldsCur);
  const pooledBase = foldsBase ? poolFolds(foldsBase) : undefined;
  const sorted = sortedTimeSites(pooled.byKey);
  const filtered = options.userOnly ? sorted.filter(isNodeUserCode) : sorted;
  const rows = filtered.slice(0, options.topN).map(s => {
    const key = siteKey(s);
    const baseUs = pooledBase?.byKey.get(key)?.selfUs;
    const delta =
      baseUs != null && foldsBase
        ? batchDeltaCI(key, foldsCur, foldsBase)
        : undefined;
    const selfPct = pooled.totalUs > 0 ? (s.selfUs / pooled.totalUs) * 100 : 0;
    const { name, url, line, col, selfUs } = s;
    return {
      name,
      url,
      line,
      col,
      selfUs,
      selfPct,
      baseUs,
      deltaPct: delta?.pct,
      deltaCI: delta?.ci,
    };
  });
  return {
    totalUs: pooled.totalUs,
    baseTotalUs: pooledBase?.totalUs,
    iterations,
    rows,
  };
}

/** Resolve the profile report options from raw (kebab-case) CLI args. */
function profileOptions(
  cliArgs?: Record<string, unknown>,
): ProfileReportOptions {
  if (!cliArgs) return defaultProfileOptions;
  const topN = cliArgs["profile-rows"];
  return {
    topN: typeof topN === "number" ? topN : defaultProfileOptions.topN,
    userOnly: cliArgs["profile-user-only"] === true,
  };
}

/** @return case data: raw per-series benchmarks plus the case-level,
 *  track-columned sections (trimmed + raw views). */
function prepareGroupData(
  group: ReportGroup,
  sections?: ReportSection[],
  comparison?: ComparisonOptions,
  profile?: ProfileReportOptions,
): BenchmarkGroup {
  const built = sections
    ? buildCaseSections(sections, resolveTracks(group), comparison)
    : undefined;
  return {
    name: group.name,
    baseline: group.baseline
      ? prepareBenchmarkData(group.baseline, profile, comparison?.noBatchTrim)
      : undefined,
    benchmarks: group.reports.map(r =>
      benchmarkEntry(r, profile, comparison?.noBatchTrim),
    ),
    warnings: groupWarnings(group, comparison),
    sections: built?.sections,
    rawSections: built?.rawSections,
  };
}

/** The function's percent change in self-time share vs baseline with a 95%
 *  bootstrap CI over per-batch shares, or undefined when there are too few
 *  batches to resample. Comparing shares, not absolute self-time, localizes where
 *  time shifted rather than reflecting a uniform global change. */
function batchDeltaCI(
  key: string,
  foldsCur: TimeFold[],
  foldsBase: TimeFold[],
): { pct: number; ci: [number, number] } | undefined {
  if (foldsCur.length < minDeltaBatches || foldsBase.length < minDeltaBatches)
    return undefined;
  const cur = foldsCur.map(f => selfFraction(f, key));
  const base = foldsBase.map(f => selfFraction(f, key));
  const mb = mean(base);
  if (mb <= 0) return undefined;
  const pct = ((mean(cur) - mb) / mb) * 100;

  const cBuf = new Array<number>(cur.length);
  const bBuf = new Array<number>(base.length);
  const deltas: number[] = [];
  for (let i = 0; i < deltaResamples; i++) {
    resampleInto(cur, cBuf);
    resampleInto(base, bBuf);
    const rb = mean(bBuf);
    if (rb > 0) deltas.push(((mean(cBuf) - rb) / rb) * 100);
  }
  if (deltas.length < deltaResamples / 2) return undefined;
  return { pct, ci: computeInterval(deltas, defaultConfidence) };
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

/** @return raw per-series benchmark data (samples, stats, profiling summaries).
 *  The profile summary here is standalone (no baseline delta); benchmarkEntry
 *  overrides it with a current-vs-baseline summary when both sides profiled. */
function prepareBenchmarkData(
  report: BenchmarkReport,
  profile?: ProfileReportOptions,
  noTrim?: boolean,
): BenchmarkEntry {
  const { measuredResults: m, name, metadata } = report;
  const kept = keptProfilesOf(m, noTrim);
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
    profileSummary: kept.profiles.length
      ? summarizeTime(kept.profiles, undefined, profile, kept.iterations)
      : undefined,
  };
}

/** A benchmark entry: raw per-series data plus its own paired baseline (for the
 *  analyze command's per-batch diagnostics). When both current and baseline were
 *  profiled, the entry's profile summary carries the per-function baseline delta. */
function benchmarkEntry(
  report: BenchmarkReport,
  profile?: ProfileReportOptions,
  noTrim?: boolean,
): BenchmarkEntry {
  const baseline = report.baseline
    ? prepareBenchmarkData(report.baseline, profile, noTrim)
    : undefined;
  const entry = prepareBenchmarkData(report, profile, noTrim);
  const cur = keptProfilesOf(report.measuredResults, noTrim);
  const base = report.baseline
    ? keptProfilesOf(report.baseline.measuredResults, noTrim)
    : undefined;
  const profileSummary = cur.profiles.length
    ? summarizeTime(cur.profiles, base?.profiles, profile, cur.iterations)
    : undefined;
  return { ...entry, profileSummary, baseline };
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

/** A function's share of one batch's sampled time (normalizes batch duration). */
function selfFraction(fold: TimeFold, key: string): number {
  const self = fold.byKey.get(key)?.selfUs ?? 0;
  return fold.totalUs > 0 ? self / fold.totalUs : 0;
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
