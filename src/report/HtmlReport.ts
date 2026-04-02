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
  bootstrapDifferenceCI,
  bootstrapStat,
  type DifferenceCI,
  swapDirection,
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
export interface PrepareHtmlOptions {
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
  const sections = options.sections ?? defaultSections(groups, cliArgs);
  return {
    groups: groups.map(group => prepareGroupData(group, sections)),
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

const minBatches = 8;

/** @return group data with structured ViewerSections and bootstrap CIs */
function prepareGroupData(
  group: ReportGroup,
  sections?: ResultsMapper[],
): BenchmarkGroup {
  const base = group.baseline;
  const baseM = base?.measuredResults;
  const baseData = base ? prepareBenchmarkData(base) : undefined;
  const baseline = baseData
    ? { ...baseData, comparisonCI: undefined }
    : undefined;
  const primaryCol = findPrimaryColumn(sections);
  const lowBatches = hasLowBatchCount(baseM, group.reports[0]?.measuredResults);

  return {
    name: group.name,
    baseline,
    warning: lowBatches
      ? `Too few batches for reliable comparison (need ${minBatches}+)`
      : undefined,
    benchmarks: group.reports.map(report => {
      const m = report.measuredResults;
      const ci = computeDiffCI(baseM, m, primaryCol, report.metadata);
      if (lowBatches && ci) ci.direction = "uncertain";
      const sects = sections
        ? buildViewerSections(
            sections,
            m,
            baseM,
            report.metadata,
            base?.metadata,
          )
        : undefined;
      return {
        ...prepareBenchmarkData(report),
        sections: sects,
        comparisonCI: ci,
      };
    }),
  };
}

/** @return true if batched but below the minimum for reliable block bootstrap */
function hasLowBatchCount(
  baseline: MeasuredResults | undefined,
  current: MeasuredResults | undefined,
): boolean {
  const batchCount = (m?: MeasuredResults) => m?.batchOffsets?.length ?? 0;
  const baseN = batchCount(baseline);
  const curN = batchCount(current);
  if (baseN === 0 && curN === 0) return false; // not batched
  return baseN < minBatches || curN < minBatches;
}

/** Find the first comparable column with a statFn across all sections */
function findPrimaryColumn(
  sections?: ResultsMapper[],
): ReportColumn<Record<string, unknown>> | undefined {
  if (!sections) return undefined;
  const allColumns = sections.flatMap(s => s.columns().flatMap(g => g.columns));
  return allColumns.find(c => c.comparable && c.statFn) as
    | ReportColumn<Record<string, unknown>>
    | undefined;
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

/** Build ViewerSection[] from ResultsMapper sections, with bootstrap CIs for perRun columns */
function buildViewerSections(
  sections: ResultsMapper[],
  current: MeasuredResults,
  baseline: MeasuredResults | undefined,
  currentMeta?: UnknownRecord,
  baselineMeta?: UnknownRecord,
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

  const entries: ViewerEntry[] = [
    buildEntry(
      ctx.current.name,
      format(curRaw),
      col,
      ctx.current,
      ctx.currentMeta,
    ),
  ];
  if (ctx.baseline && baseRaw !== undefined)
    entries.push(
      buildEntry(
        "baseline",
        format(baseRaw),
        col,
        ctx.baseline,
        ctx.baselineMeta,
      ),
    );
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
  const ci = computeDiffCI(ctx.baseline, ctx.current, col, ctx.currentMeta);
  if (ci && hasLowBatchCount(ctx.baseline, ctx.current))
    ci.direction = "uncertain";
  return ci;
}

/** Shared bootstrap difference CI computation for a column */
function computeDiffCI(
  baseline: MeasuredResults | undefined,
  current: MeasuredResults,
  col: ReportColumn<Record<string, unknown>> | undefined,
  metadata: UnknownRecord | undefined,
): DifferenceCI | undefined {
  if (!baseline?.samples?.length || !current.samples?.length) return undefined;
  if (col && !col.statFn) return undefined;
  const statFn = col?.statFn
    ? (s: number[]) => col.statFn!(s, metadata)
    : undefined;
  const opts = {
    statFn,
    blocks: baseline.batchOffsets,
    blocksB: current.batchOffsets,
  };
  const rawCI = bootstrapDifferenceCI(baseline.samples, current.samples, opts);
  // statFn computes in the metric's natural domain. bootstrapDifferenceCI
  // assumes lower-is-better for direction labels. For higher-is-better
  // metrics (like loc/sec), swap the direction without negating the values.
  return col?.higherIsBetter ? swapDirection(rawCI) : rawCI;
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
  const fmt = (v: number) =>
    (col.formatter ? col.formatter(v) : String(v)) ?? String(v);
  const bootstrapCI = {
    ...binBootstrapResult(result),
    ciLabels: [fmt(result.ci[0]), fmt(result.ci[1])] as [string, string],
  };
  return { runName, value, bootstrapCI };
}

/** Compute heap allocation summary from profile */
function summarizeHeap(profile: HeapProfile): HeapSummary {
  const resolved = resolveProfile(profile);
  const userSites = filterSites(flattenProfile(resolved));
  return { totalBytes: resolved.totalBytes, userBytes: totalBytes(userSites) };
}

/** Compute coverage summary from V8 coverage data */
function summarizeCoverage(coverage: CoverageData): CoverageSummary {
  const calledFns = coverage.scripts
    .flatMap(s => s.functions)
    .filter(fn => fn.ranges.length > 0 && fn.ranges[0].count > 0);
  return {
    functionCount: calledFns.length,
    totalCalls: calledFns.reduce((sum, fn) => sum + fn.ranges[0].count, 0),
  };
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
