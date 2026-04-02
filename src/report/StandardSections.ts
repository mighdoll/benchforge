import type {
  MeasuredResults,
  OptStatusInfo,
} from "../runners/MeasuredResults.ts";
import { average, percentile } from "../stats/StatisticalUtils.ts";
import type { ReportColumnGroup, ResultsMapper } from "./BenchmarkReport.ts";
import { formatBytes, integer, percent, timeMs } from "./Formatters.ts";
import { formatConvergence } from "./text/ConvergenceFormatters.ts";

/** Extracted timing statistics for a benchmark */
export interface TimeStats {
  mean?: number;
  p50?: number;
  p99?: number;
}

/** GC overhead from Node performance hooks */
export interface GcSectionStats {
  /** GC time as fraction of total bench time */
  gc?: number;
}

/** Detailed GC stats from --trace-gc-nvp parsing */
export interface GcStatsInfo {
  allocPerIter?: number;
  collected?: number;
  scavenges?: number;
  fullGCs?: number;
  promoPercent?: number;
  pausePerIter?: number;
}

/** Iteration count for a benchmark run */
export interface RunStats {
  runs?: number;
}

/** Stats for adaptive sampling mode including convergence confidence */
export interface AdaptiveStats {
  median?: number;
  mean?: number;
  p99?: number;
  convergence?: number;
}

/** V8 optimization tier distribution and deoptimization count */
export interface OptStats {
  /** Tier distribution summary (e.g. "turbofan:85% sparkplug:15%") */
  tiers?: string;
  /** Number of deoptimizations observed */
  deopt?: number;
}

/** Section: mean, p50, p99 timing */
export const timeSection: ResultsMapper<TimeStats> = {
  extract: (results: MeasuredResults) => ({
    mean: results.time?.avg,
    p50: results.time?.p50,
    p99: results.time?.p99,
  }),
  columns: (): ReportColumnGroup<TimeStats>[] => [
    {
      groupTitle: "time",
      columns: [
        {
          key: "mean",
          title: "mean",
          formatter: timeMs,
          comparable: true,
          statFn: average,
        },
        {
          key: "p50",
          title: "p50",
          formatter: timeMs,
          comparable: true,
          statFn: s => percentile(s, 0.5),
        },
        {
          key: "p99",
          title: "p99",
          formatter: timeMs,
          comparable: true,
          statFn: s => percentile(s, 0.99),
        },
      ],
    },
  ],
};

/** Section: GC time as fraction of total benchmark time (Node performance hooks) */
export const gcSection: ResultsMapper<GcSectionStats> = {
  extract: (results: MeasuredResults) => {
    const { nodeGcTime, time, samples } = results;
    if (!nodeGcTime || !time?.avg) return { gc: undefined };
    const totalBenchTime = time.avg * samples.length;
    if (totalBenchTime <= 0) return { gc: undefined };
    const gcTime = nodeGcTime.inRun / totalBenchTime;
    // GC time can't exceed total time
    return { gc: gcTime <= 1 ? gcTime : undefined };
  },
  columns: (): ReportColumnGroup<GcSectionStats>[] => [
    {
      groupTitle: "gc",
      columns: [
        { key: "gc", title: "mean", formatter: percent, comparable: true },
      ],
    },
  ],
};

/** Section: detailed GC stats from --trace-gc-nvp (allocation, promotion, pauses) */
export const gcStatsSection: ResultsMapper<GcStatsInfo> = {
  extract: (results: MeasuredResults) => {
    const { gcStats, samples } = results;
    if (!gcStats) return {};
    const iterations = samples.length || 1;
    const alloc = gcStats.totalAllocated;
    const hasAlloc = alloc && alloc > 0;
    const promoPercent = hasAlloc
      ? (gcStats.totalPromoted ?? 0) / alloc
      : undefined;
    return {
      allocPerIter: alloc != null ? alloc / iterations : undefined,
      collected: gcStats.totalCollected || undefined,
      scavenges: gcStats.scavenges,
      fullGCs: gcStats.markCompacts,
      promoPercent,
      pausePerIter: gcStats.gcPauseTime / iterations,
    };
  },
  columns: (): ReportColumnGroup<GcStatsInfo>[] => [
    {
      groupTitle: "gc",
      columns: [
        {
          key: "allocPerIter",
          title: "alloc/iter",
          formatter: formatBytes,
          comparable: true,
        },
        {
          key: "collected",
          title: "collected",
          formatter: formatBytes,
          comparable: true,
        },
        {
          key: "scavenges",
          title: "scav",
          formatter: integer,
          comparable: true,
        },
        { key: "fullGCs", title: "full", formatter: integer, comparable: true },
        {
          key: "promoPercent",
          title: "promo%",
          formatter: percent,
          comparable: true,
        },
        {
          key: "pausePerIter",
          title: "pause/iter",
          formatter: timeMs,
          comparable: true,
        },
      ],
    },
  ],
};

/** Browser GC section: only fields available from CDP tracing */
export const browserGcStatsSection: ResultsMapper<GcStatsInfo> = {
  extract: gcStatsSection.extract,
  columns: (): ReportColumnGroup<GcStatsInfo>[] => [
    {
      groupTitle: "gc",
      columns: [
        {
          key: "collected",
          title: "collected",
          formatter: formatBytes,
          comparable: true,
        },
        {
          key: "scavenges",
          title: "scav",
          formatter: integer,
          comparable: true,
        },
        { key: "fullGCs", title: "full", formatter: integer, comparable: true },
        {
          key: "pausePerIter",
          title: "pause",
          formatter: timeMs,
          comparable: true,
        },
      ],
    },
  ],
};

/** Section: number of sample iterations */
export const runsSection: ResultsMapper<RunStats> = {
  extract: (results: MeasuredResults) => ({
    runs: results.samples.length,
  }),
  columns: (): ReportColumnGroup<RunStats>[] => [
    { columns: [{ key: "runs", title: "runs", formatter: integer }] },
  ],
};

const fmtString = (v: unknown): string => (typeof v === "string" ? v : "");
const fmtNumber = (v: unknown): string =>
  typeof v === "number" ? String(v) : "";

/** Format total time; brackets indicate runs exceeding 30s threshold */
function formatTotalTime(v: unknown): string {
  if (typeof v !== "number") return "";
  return v >= 30 ? `[${v.toFixed(1)}s]` : `${v.toFixed(1)}s`;
}

/** Section: total sampling duration in seconds (brackets if >= 30s) */
export const totalTimeSection: ResultsMapper<{ totalTime?: number }> = {
  extract: (results: MeasuredResults) => ({
    totalTime: results.totalTime,
  }),
  columns: (): ReportColumnGroup<{ totalTime?: number }>[] => [
    {
      columns: [
        { key: "totalTime", title: "time", formatter: formatTotalTime },
      ],
    },
  ],
};

/** Section: median, mean, p99, and convergence for adaptive mode */
export const adaptiveSection: ResultsMapper<AdaptiveStats> = {
  extract: (results: MeasuredResults) => ({
    median: results.time?.p50,
    mean: results.time?.avg,
    p99: results.time?.p99,
    convergence: results.convergence?.confidence,
  }),
  columns: (): ReportColumnGroup<AdaptiveStats>[] => [
    {
      groupTitle: "time",
      columns: [
        {
          key: "median",
          title: "median",
          formatter: timeMs,
          comparable: true,
          statFn: s => percentile(s, 0.5),
        },
        {
          key: "mean",
          title: "mean",
          formatter: timeMs,
          comparable: true,
          statFn: average,
        },
        { key: "p99", title: "p99", formatter: timeMs },
      ],
    },
    {
      columns: [
        { key: "convergence", title: "conv%", formatter: formatConvergence },
      ],
    },
  ],
};

/** Section: V8 optimization tier distribution and deopt count */
export const optSection: ResultsMapper<OptStats> = {
  extract: (results: MeasuredResults) => {
    const opt = results.optStatus;
    if (!opt) return {};

    return {
      tiers: formatTierSummary(opt),
      deopt: opt.deoptCount > 0 ? opt.deoptCount : undefined,
    };
  },
  columns: (): ReportColumnGroup<OptStats>[] => [
    {
      groupTitle: "v8 opt",
      columns: [
        { key: "tiers", title: "tiers", formatter: fmtString },
        { key: "deopt", title: "deopt", formatter: fmtNumber },
      ],
    },
  ],
};

/** Format V8 tier distribution sorted by count (e.g. "turbofan:85% sparkplug:15%") */
export function formatTierSummary(
  opt: OptStatusInfo,
  sep = ":",
  join = " ",
): string {
  const tiers = Object.entries(opt.byTier);
  const total = tiers.reduce((s, [, t]) => s + t.count, 0);
  const pct = (n: number) => `${((n / total) * 100).toFixed(0)}%`;
  return tiers
    .sort((a, b) => b[1].count - a[1].count)
    .map(([name, t]) => `${name}${sep}${pct(t.count)}`)
    .join(join);
}

/** Extracted page-load timing metrics */
export interface PageLoadStats {
  dcl?: number;
  load?: number;
  lcp?: number;
}

/** Section: page-load navigation timing (DCL, Load Event, LCP) */
export const pageLoadSection: ResultsMapper<PageLoadStats> = {
  extract: (results: MeasuredResults) => {
    const nav = results.navTiming;
    if (!nav) return {};
    return {
      dcl: nav.domContentLoaded || undefined,
      load: nav.loadEvent || undefined,
      lcp: nav.lcp,
    };
  },
  columns: (): ReportColumnGroup<PageLoadStats>[] => [
    {
      groupTitle: "page load",
      columns: [
        { key: "dcl", title: "DCL", formatter: timeMs },
        { key: "load", title: "load", formatter: timeMs },
        { key: "lcp", title: "LCP", formatter: timeMs },
      ],
    },
  ],
};

/** @return GC stats sections if enabled by CLI flags */
export function gcSections(args: { "gc-stats"?: boolean }): ResultsMapper[] {
  return args["gc-stats"] ? [gcStatsSection] : [];
}

/** Build default report sections (GC stats if enabled, plus run count) from CLI flags */
export function buildGenericSections(args: {
  "gc-stats"?: boolean;
  alloc?: boolean;
}): ResultsMapper[] {
  return [...gcSections(args), runsSection];
}
