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
  binBootstrapResult,
  bootstrapStat,
} from "../stats/StatisticalUtils.ts";
import type {
  BenchmarkEntry,
  BenchmarkGroup,
  CoverageSummary,
  HeapSummary,
  ReportData,
  ViewerEntry,
  ViewerRow,
  ViewerSection,
} from "../viewer/ReportData.ts";
import {
  type BenchmarkReport,
  type ComparisonOptions,
  computeDiffCI,
  findPrimaryColumn,
  groupReports,
  type ReportColumn,
  type ReportGroup,
  type ResultsMapper,
  type UnknownRecord,
} from "./BenchmarkReport.ts";
import type { GitVersion } from "./GitUtils.ts";
import {
  gcStatsSection,
  optSection,
  runsSection,
  timeSection,
} from "./StandardSections.ts";

/** Options for prepareHtmlData: report sections, git versions, and CLI args */
export interface PrepareHtmlOptions extends ComparisonOptions {
  cliArgs?: Record<string, unknown>;
  sections?: ResultsMapper[];
  currentVersion?: GitVersion;
  baselineVersion?: GitVersion;
}

/** Convert benchmark results into a ReportData payload for the HTML viewer */
export function prepareHtmlData(
  groups: ReportGroup[],
  options: PrepareHtmlOptions,
): ReportData {
  const { cliArgs, currentVersion, baselineVersion } = options;
  const { equivMargin, noBatchTrim } = options;
  const comparison: ComparisonOptions = { equivMargin, noBatchTrim };
  const sections = options.sections ?? defaultSections(groups, cliArgs);
  return {
    groups: groups.map(g => prepareGroupData(g, sections, comparison)),
    metadata: {
      timestamp: new Date().toISOString(),
      bencherVersion: process.env.npm_package_version || "unknown",
      cliArgs,
      gcTrackingEnabled: cliArgs?.["gc-stats"] === true,
      currentVersion,
      baselineVersion,
    },
  };
}

const minBatches = 20;

/** Context shared across reports in a group */
interface GroupContext {
  baseM?: MeasuredResults;
  baseMeta?: UnknownRecord;
  primaryCol?: ReportColumn<Record<string, unknown>>;
  sections?: ResultsMapper[];
  comparison?: ComparisonOptions;
  lowBatches: boolean;
}

/** @return group data with structured ViewerSections and bootstrap CIs */
function prepareGroupData(
  group: ReportGroup,
  sections?: ResultsMapper[],
  comparison?: ComparisonOptions,
): BenchmarkGroup {
  const base = group.baseline;
  const baseM = base?.measuredResults;
  const baseData = base ? prepareBenchmarkData(base) : undefined;
  const baseline = baseData
    ? { ...baseData, comparisonCI: undefined }
    : undefined;
  const ctx: GroupContext = {
    baseM,
    baseMeta: base?.metadata,
    primaryCol: findPrimaryColumn(sections),
    sections,
    comparison,
    lowBatches: hasLowBatchCount(baseM, group.reports[0]?.measuredResults),
  };

  return {
    name: group.name,
    baseline,
    warning: ctx.lowBatches
      ? `Too few batches for reliable comparison (need ${minBatches}+)`
      : undefined,
    benchmarks: group.reports.map(r => prepareReportEntry(r, ctx)),
  };
}

/** @return a single benchmark entry with sections and comparison CI */
function prepareReportEntry(
  report: BenchmarkReport,
  ctx: GroupContext,
): BenchmarkEntry {
  const m = report.measuredResults;
  const ci = annotateCI(
    computeDiffCI(
      ctx.baseM,
      m,
      ctx.primaryCol,
      report.metadata,
      ctx.comparison,
    ),
    ctx.primaryCol?.title,
    ctx.lowBatches,
  );
  const sections = ctx.sections
    ? buildViewerSections(
        ctx.sections,
        m,
        ctx.baseM,
        report.metadata,
        ctx.baseMeta,
        ctx.comparison,
      )
    : undefined;
  return { ...prepareBenchmarkData(report), sections, comparisonCI: ci };
}

/** Add label and override direction to uncertain when batch count is low */
function annotateCI<
  T extends { direction: string; label?: string } | undefined,
>(ci: T, title?: string, lowBatches?: boolean): T {
  if (!ci) return ci;
  if (lowBatches) ci.direction = "uncertain";
  if (title) ci.label = `${title} Δ%`;
  return ci;
}

/** @return true if batched but below the minimum for reliable block bootstrap */
function hasLowBatchCount(
  baseline: MeasuredResults | undefined,
  current: MeasuredResults | undefined,
): boolean {
  const batchCount = (m?: MeasuredResults) => m?.batchOffsets?.length ?? 0;
  const baseN = batchCount(baseline);
  const curN = batchCount(current);
  if (baseN === 0 || curN === 0) return false; // not batched or no comparison
  return baseN < minBatches || curN < minBatches;
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

/** Build ViewerSections from ResultsMapper sections, with bootstrap CIs for comparable columns */
function buildViewerSections(
  sections: ResultsMapper[],
  current: MeasuredResults,
  baseline: MeasuredResults | undefined,
  currentMeta?: UnknownRecord,
  baselineMeta?: UnknownRecord,
  comparison?: ComparisonOptions,
): ViewerSection[] {
  return sections.flatMap(section => {
    const curVals = section.extract(current, currentMeta);
    const baseVals = baseline
      ? section.extract(baseline, baselineMeta)
      : undefined;
    const ctx: RowContext = {
      current,
      baseline,
      curVals,
      baseVals,
      currentMeta,
      baselineMeta,
      comparison,
    };
    return section.columns().flatMap(group => {
      const cols = group.columns as ReportColumn<Record<string, unknown>>[];
      const rows = buildGroupRows(cols, ctx);
      if (!rows.length) return [];
      return [{ title: group.groupTitle ?? "", rows } satisfies ViewerSection];
    });
  });
}

/** Context for building viewer rows within a column group */
interface RowContext {
  current: MeasuredResults;
  baseline?: MeasuredResults;
  curVals: Record<string, unknown>;
  baseVals?: Record<string, unknown>;
  currentMeta?: UnknownRecord;
  baselineMeta?: UnknownRecord;
  comparison?: ComparisonOptions;
}

/** Build ViewerRow[] for a column group, marking the first CI row as primary */
function buildGroupRows(
  columns: ReportColumn<Record<string, unknown>>[],
  ctx: RowContext,
): ViewerRow[] {
  const rows = columns
    .map(col => buildColumnRow(col, ctx))
    .filter((row): row is ViewerRow => row !== undefined);
  const first = rows.find(r => r.entries.some(e => e.bootstrapCI));
  if (first) first.primary = true;
  return rows;
}

/** Build a ViewerRow for a single column, or undefined if no data */
function buildColumnRow(
  col: ReportColumn<Record<string, unknown>>,
  ctx: RowContext,
): ViewerRow | undefined {
  const curRaw = ctx.curVals[col.key as string];
  const baseRaw = ctx.baseVals?.[col.key as string];
  if (curRaw === undefined && baseRaw === undefined) return undefined;

  const format = (v: unknown) => {
    if (v === undefined) return "";
    return (col.formatter ? col.formatter(v) : String(v)) ?? "";
  };

  if (!col.comparable) {
    const value = format(curRaw ?? baseRaw);
    if (!value || value === "—") return undefined;
    return {
      label: col.title,
      entries: [{ runName: ctx.current.name, value }],
      shared: true,
    };
  }

  const curEntry = buildEntry(
    ctx.current.name,
    format(curRaw),
    col,
    ctx.current,
    ctx.currentMeta,
  );
  const entries: ViewerEntry[] = [curEntry];
  if (ctx.baseline && baseRaw !== undefined) {
    const baseEntry = buildEntry(
      "baseline",
      format(baseRaw),
      col,
      ctx.baseline,
      ctx.baselineMeta,
    );
    entries.push(baseEntry);
  }
  return {
    label: col.title,
    entries,
    comparisonCI: buildComparisonCI(col, ctx),
  };
}

/** Compute comparison CI for a comparable column with a statFn */
function buildComparisonCI(
  col: ReportColumn<Record<string, unknown>>,
  ctx: RowContext,
) {
  return annotateCI(
    computeDiffCI(
      ctx.baseline,
      ctx.current,
      col,
      ctx.currentMeta,
      ctx.comparison,
    ),
    col.title,
    hasLowBatchCount(ctx.baseline, ctx.current),
  );
}

/** Build a ViewerEntry with optional bootstrap CI */
function buildEntry(
  runName: string,
  value: string,
  col: ReportColumn<Record<string, unknown>>,
  measured: MeasuredResults | undefined,
  metadata?: UnknownRecord,
): ViewerEntry {
  const samples = measured?.samples;
  if (!col.comparable || !col.statFn || !samples || samples.length <= 1)
    return { runName, value };
  const fn = (s: number[]) => col.statFn!(s, metadata);
  const result = bootstrapStat(samples, fn, { blocks: measured?.batchOffsets });
  const display = col.toDisplay
    ? (v: number) => col.toDisplay!(v, metadata)
    : (v: number) => v;
  const fmt = (v: number) =>
    (col.formatter ? col.formatter(v) : String(v)) ?? String(v);

  // Transform bootstrap data to display domain so histogram x-axis matches labels
  const binned = binBootstrapResult(result);
  const estimate = display(binned.estimate);
  const dLo = display(binned.ci[0]), dHi = display(binned.ci[1]);
  const ci = (dLo <= dHi ? [dLo, dHi] : [dHi, dLo]) as [number, number];
  const histogram = binned.histogram.map(b => ({ x: display(b.x), count: b.count }));
  const ciLabels = [fmt(ci[0]), fmt(ci[1])] as [string, string];

  return {
    runName,
    value,
    bootstrapCI: { estimate, ci, histogram, ciLabels },
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

/** Build default sections when caller doesn't provide custom ones */
function defaultSections(
  groups: ReportGroup[],
  cliArgs?: Record<string, unknown>,
): ResultsMapper[] {
  const gc = cliArgs?.["gc-stats"] === true;
  const opt = groups.some(g =>
    groupReports(g).some(r => r.measuredResults.optStatus !== undefined),
  );
  return [
    timeSection,
    ...(gc ? [gcStatsSection] : []),
    ...(opt ? [optSection] : []),
    runsSection,
  ];
}
