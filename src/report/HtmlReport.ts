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
  flipCI,
} from "../stats/StatisticalUtils.ts";
import type {
  BenchmarkEntry,
  BenchmarkGroup,
  BootstrapCIData,
  CoverageSummary,
  HeapSummary,
  ReportData,
  ViewerEntry,
  ViewerRow,
  ViewerSection,
} from "../viewer/ReportData.ts";
import {
  groupReports,
  isHigherIsBetter,
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
  const higherIsBetter = isHigherIsBetter(sections);
  return {
    groups: groups.map(group =>
      prepareGroupData(group, sections, higherIsBetter),
    ),
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

/** @return group data with structured ViewerSections and bootstrap CIs */
function prepareGroupData(
  group: ReportGroup,
  sections?: ResultsMapper[],
  higherIsBetter?: boolean,
): BenchmarkGroup {
  const base = group.baseline;
  const baseM = base?.measuredResults;
  const baseData = base ? prepareBenchmarkData(base) : undefined;
  const baseline = baseData
    ? { ...baseData, comparisonCI: undefined }
    : undefined;

  return {
    name: group.name,
    baseline,
    benchmarks: group.reports.map(report => {
      const m = report.measuredResults;
      const rawCI =
        baseM?.samples && m.samples
          ? bootstrapDifferenceCI(baseM.samples, m.samples)
          : undefined;
      const comparisonCI = rawCI && higherIsBetter ? flipCI(rawCI) : rawCI;
      const viewerSections = sections
        ? buildViewerSections(
            sections,
            m,
            baseM,
            report.metadata,
            base?.metadata,
            higherIsBetter,
          )
        : undefined;
      return {
        ...prepareBenchmarkData(report),
        sections: viewerSections,
        comparisonCI,
      };
    }),
  };
}

/** @return benchmark data with samples, stats, and profiling summaries */
function prepareBenchmarkData(report: {
  name: string;
  measuredResults: MeasuredResults;
  metadata?: UnknownRecord;
}): Omit<BenchmarkEntry, "comparisonCI" | "sections"> {
  const m = report.measuredResults;
  return {
    name: report.name,
    samples: m.samples,
    warmupSamples: m.warmupSamples,
    allocationSamples: m.allocationSamples,
    heapSamples: m.heapSamples,
    gcEvents: m.nodeGcTime?.events,
    optSamples: m.optSamples,
    pausePoints: m.pausePoints,
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
  higherIsBetter?: boolean,
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
      higherIsBetter,
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
  higherIsBetter?: boolean;
}

/** Build ViewerRow[] for a column group */
function buildGroupRows(
  columns: ReportColumn<Record<string, unknown>>[],
  ctx: RowContext,
): ViewerRow[] {
  return columns
    .map(col => buildColumnRow(col, ctx))
    .filter((row): row is ViewerRow => row !== undefined);
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
      ctx.current.samples,
      ctx.currentMeta,
    ),
  ];
  if (ctx.baseline && baseRaw !== undefined) {
    entries.push(
      buildEntry(
        "baseline",
        format(baseRaw),
        col,
        ctx.baseline.samples,
        ctx.baselineMeta,
      ),
    );
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
  if (
    !col.statFn ||
    !ctx.baseline?.samples?.length ||
    !ctx.current.samples?.length
  )
    return undefined;
  const rawCI = bootstrapDifferenceCI(
    ctx.baseline.samples,
    ctx.current.samples,
    { statFn: s => col.statFn!(s, ctx.currentMeta) },
  );
  return ctx.higherIsBetter ? flipCI(rawCI) : rawCI;
}

/** Build a ViewerEntry with optional bootstrap CI */
function buildEntry(
  runName: string,
  value: string,
  col: ReportColumn<Record<string, unknown>>,
  samples: number[] | undefined,
  metadata?: UnknownRecord,
): ViewerEntry {
  let bootstrapCI: BootstrapCIData | undefined;
  if (col.comparable && col.statFn && samples && samples.length > 1) {
    const fn = (s: number[]) => col.statFn!(s, metadata);
    const result = bootstrapStat(samples, fn);
    bootstrapCI = binBootstrapResult(result);
  }
  return { runName, value, bootstrapCI };
}

/** Compute heap allocation summary from profile */
function summarizeHeap(profile: HeapProfile): HeapSummary {
  const resolved = resolveProfile(profile);
  const allSites = flattenProfile(resolved);
  const userSites = filterSites(allSites);
  return {
    totalBytes: resolved.totalBytes,
    userBytes: totalBytes(userSites),
  };
}

/** Compute coverage summary from V8 coverage data */
function summarizeCoverage(coverage: CoverageData): CoverageSummary {
  let functionCount = 0;
  let totalCalls = 0;
  for (const script of coverage.scripts) {
    for (const fn of script.functions) {
      if (!fn.ranges.length) continue;
      const count = fn.ranges[0].count;
      if (count > 0) {
        functionCount++;
        totalCalls += count;
      }
    }
  }
  return { functionCount, totalCalls };
}

/** Build default sections when caller doesn't provide custom ones */
function defaultSections(
  groups: ReportGroup[],
  cliArgs?: Record<string, unknown>,
): ResultsMapper[] {
  const hasGcStats = cliArgs?.["gc-stats"] === true;
  const hasOpt = groups.some(g =>
    groupReports(g).some(r => r.measuredResults.optStatus !== undefined),
  );
  return [
    timeSection,
    ...(hasGcStats ? [gcStatsSection] : []),
    ...(hasOpt ? [optSection] : []),
    runsSection,
  ];
}
