import { cliDefaults } from "../cli/CliArgs.ts";
import type { CoverageData } from "../profiling/node/CoverageTypes.ts";
import {
  aggregateSites,
  filterSites,
  flattenProfile,
  type HeapReportOptions,
  type HeapSite,
  isNodeUserCode,
  totalBytes,
  type UserCodeFilter,
} from "../profiling/node/HeapSampleReport.ts";
import type { HeapProfile } from "../profiling/node/HeapSampler.ts";
import {
  type ResolvedFrame,
  resolveProfile,
} from "../profiling/node/ResolvedProfile.ts";
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
import { type NoiseFloor, noiseFloor } from "../stats/NoiseFloor.ts";
import type {
  BenchmarkEntry,
  BenchmarkGroup,
  CoverageSummary,
  HeapSiteRow,
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
import { frameLocation } from "./Formatters.ts";
import { gcByBatch } from "./GcByBatch.ts";
import type { GitVersion } from "./GitUtils.ts";
import { defaultReportSections } from "./StandardSections.ts";
import { resolveTracks } from "./TrackResolution.ts";
import { pairedCurrentTrack } from "./ViewerRows.ts";
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

  /** Heap attribution display options (topN, userOnly, user-code filter). When
   *  omitted they are derived from cliArgs; the browser path passes its own to
   *  supply the browser user-code filter. */
  heapReport?: HeapReportOptions;
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
  const heap = options.heapReport ?? heapOptions(cliArgs);
  return {
    groups: groups.map(g =>
      prepareGroupData(g, sections, comparison, profile, heap),
    ),
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

/** Heap display options from raw (kebab-case) CLI args, with the same defaults
 *  as the --alloc-* flags. */
function heapOptions(cliArgs?: Record<string, unknown>): HeapReportOptions {
  return {
    topN: numArg(cliArgs, "alloc-rows", 20),
    stackDepth: numArg(cliArgs, "alloc-stack", 3),
    userOnly: cliArgs?.["alloc-user-only"] === true,
  };
}

/** @return case data: raw per-series benchmarks plus the case-level,
 *  track-columned sections (trimmed + raw views). */
function prepareGroupData(
  group: ReportGroup,
  sections?: ReportSection[],
  comparison?: ComparisonOptions,
  profile?: ProfileReportOptions,
  heap?: HeapReportOptions,
): BenchmarkGroup {
  const tracks = resolveTracks(group);
  const built = sections
    ? buildCaseSections(sections, tracks, comparison)
    : undefined;
  const noTrim = comparison?.noBatchTrim;
  return {
    name: group.name,
    baseline: group.baseline
      ? prepareBenchmarkData(group.baseline, profile, heap, noTrim)
      : undefined,
    benchmarks: group.reports.map(r =>
      benchmarkEntry(r, profile, heap, noTrim),
    ),
    warnings: groupWarnings(group, comparison),
    noiseFloor: groupNoiseFloor(tracks, comparison?.noBatchTrim),
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
    resampleInto(cur, cBuf, Math.random);
    resampleInto(base, bBuf, Math.random);
    const rb = mean(bBuf);
    if (rb > 0) deltas.push(((mean(cBuf) - rb) / rb) * 100);
  }
  if (deltas.length < deltaResamples / 2) return undefined;
  return { pct, ci: computeInterval(deltas, defaultConfidence) };
}

/** Read a numeric CLI arg, falling back to a default when absent or non-numeric. */
function numArg(
  cliArgs: Record<string, unknown> | undefined,
  key: string,
  fallback: number,
): number {
  const v = cliArgs?.[key];
  return typeof v === "number" ? v : fallback;
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
  heap?: HeapReportOptions,
  noTrim?: boolean,
): BenchmarkEntry {
  const { measuredResults: m, name, metadata } = report;
  const kept = keptProfilesOf(m, noTrim);
  const heapData = m.heapProfile
    ? summarizeHeap(m.heapProfile, heap)
    : undefined;
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
    heapSummary: heapData?.summary,
    heapSites: heapData?.sites,
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
  heap?: HeapReportOptions,
  noTrim?: boolean,
): BenchmarkEntry {
  const baseline = report.baseline
    ? prepareBenchmarkData(report.baseline, profile, heap, noTrim)
    : undefined;
  const entry = prepareBenchmarkData(report, profile, heap, noTrim);
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

/** The case's noise floor, read off the baseline series the verdict compares
 *  against. Takes the same resolved tracks the tables and plots use (the named
 *  baseline in variant mode, the shadow baseline in version mode); falls back
 *  to a comparison track's paired baseline. */
function groupNoiseFloor(
  tracks: CaseTrack[],
  noTrim?: boolean,
): NoiseFloor | undefined {
  const base =
    tracks.find(t => t.isBaseline)?.measured ??
    tracks.find(t => t.baseline)?.baseline?.measured;
  if (!base) return undefined;
  return noiseFloor(base.samples, base.batchOffsets, noTrim);
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
    track: c.track?.map((r, i) => {
      const t = ctx.tracks[i];
      const other = t?.baseline?.measured ?? pairedCurrent(ctx.tracks, i);
      const ok = untrimmed(t?.measured) && untrimmed(other);
      return ok ? r : undefined;
    }),
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

/** Resolve a heap profile once into the two-number summary plus the top
 *  allocation-site rows (when display options are available). */
function summarizeHeap(
  profile: HeapProfile,
  options?: HeapReportOptions,
): { summary: HeapSummary; sites?: HeapSiteRow[] } {
  const resolved = resolveProfile(profile);
  const allSites = flattenProfile(resolved);
  // the summary and the site rows must agree on what "user code" means (the
  // browser path supplies its own filter), so resolve the predicate once.
  const isUser = options?.isUserCode ?? isNodeUserCode;
  const userSites = filterSites(allSites, isUser);
  const summary: HeapSummary = {
    totalBytes: resolved.totalBytes,
    userBytes: totalBytes(userSites),
    sampleCount: resolved.sortedSamples?.length,
  };
  const sites = options
    ? heapSiteRows({ all: allSites, user: userSites }, summary, isUser, options)
    : undefined;
  return { summary, sites };
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

/** The current results paired with a baseline cell, so the raw-view reuse gate
 *  can require both paired sides untrimmed before reusing the baseline's CI. */
function pairedCurrent(
  tracks: CaseTrack[],
  baselineIndex: number,
): MeasuredResults | undefined {
  return pairedCurrentTrack(tracks, baselineIndex)?.measured;
}

/** Aggregate resolved sites into display-ready rows, applying topN and
 *  user-only filtering. Percent is a share of the reported total (all bytes, or
 *  user-code bytes under userOnly), matching the footer total. */
function heapSiteRows(
  sites: { all: HeapSite[]; user: HeapSite[] },
  summary: HeapSummary,
  isUser: UserCodeFilter,
  options: HeapReportOptions,
): HeapSiteRow[] {
  const agg = aggregateSites(options.userOnly ? sites.user : sites.all);
  const total = options.userOnly ? summary.userBytes : summary.totalBytes;
  const depth = options.stackDepth ?? 3;
  return agg
    .slice(0, options.topN)
    .map(s => heapSiteRow(s, total, depth, isUser));
}

/** One aggregated site as a JSON-serializable row: location string, byte share,
 *  and caller function names (nearest-first, filtered to user code). */
function heapSiteRow(
  site: HeapSite,
  total: number,
  depth: number,
  isUser: UserCodeFilter,
): HeapSiteRow {
  const location = site.url
    ? frameLocation(site.url, site.line, site.col)
    : "(unknown)";
  const pct = total > 0 ? (site.bytes / total) * 100 : 0;
  const callers = siteCallers(site, depth, isUser);
  return { name: site.name, location, bytes: site.bytes, pct, callers };
}

/** The nearest `depth` user-code caller names (parent frames excluding self,
 *  nearest-first); internal frames are skipped, not counted against depth.
 *  Undefined when none remain. */
function siteCallers(
  site: HeapSite,
  depth: number,
  isUser: UserCodeFilter,
): string[] | undefined {
  if (!site.stack || site.stack.length <= 1) return undefined;
  const names = site.stack
    .slice(0, -1)
    .reverse()
    .filter((f: ResolvedFrame) => f.url && isUser(f))
    .slice(0, depth)
    .map((f: ResolvedFrame) => f.name);
  return names.length ? names : undefined;
}
