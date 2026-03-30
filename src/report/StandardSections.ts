import type { MeasuredResults } from "../runners/MeasuredResults.ts";
import type { ReportColumnGroup, ResultsMapper } from "./BenchmarkReport.ts";
import { formatBytes, integer, percent, timeMs } from "./Formatters.ts";
import { formatConvergence } from "./text/ConvergenceFormatters.ts";

export interface TimeStats {
  mean?: number;
  p50?: number;
  p99?: number;
}

export interface GcSectionStats {
  gc?: number; // GC time as fraction of total bench time
}

export interface GcStatsInfo {
  allocPerIter?: number;
  collected?: number;
  scavenges?: number;
  fullGCs?: number;
  promoPercent?: number;
  pausePerIter?: number;
}

export interface RunStats {
  runs?: number;
}

export interface AdaptiveStats {
  median?: number;
  mean?: number;
  p99?: number;
  convergence?: number;
}

export interface OptStats {
  tiers?: string; // tier distribution summary
  deopt?: number; // deopt count
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
        { key: "mean", title: "mean", formatter: timeMs, comparable: true },
        { key: "p50", title: "p50", formatter: timeMs, comparable: true },
        { key: "p99", title: "p99", formatter: timeMs, comparable: true },
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
        { key: "allocPerIter", title: "alloc/iter", formatter: formatBytes },
        { key: "collected", title: "collected", formatter: formatBytes },
        { key: "scavenges", title: "scav", formatter: integer },
        { key: "fullGCs", title: "full", formatter: integer },
        { key: "promoPercent", title: "promo%", formatter: percent },
        { key: "pausePerIter", title: "pause/iter", formatter: timeMs },
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
        { key: "collected", title: "collected", formatter: formatBytes },
        { key: "scavenges", title: "scav", formatter: integer },
        { key: "fullGCs", title: "full", formatter: integer },
        { key: "pausePerIter", title: "pause", formatter: timeMs },
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

/** Section: total sampling duration in seconds (brackets if >= 30s) */
export const totalTimeSection: ResultsMapper<{ totalTime?: number }> = {
  extract: (results: MeasuredResults) => ({
    totalTime: results.totalTime,
  }),
  columns: (): ReportColumnGroup<{ totalTime?: number }>[] => [
    {
      columns: [
        {
          key: "totalTime",
          title: "time",
          formatter: v =>
            typeof v !== "number"
              ? ""
              : v >= 30
                ? `[${v.toFixed(1)}s]`
                : `${v.toFixed(1)}s`,
        },
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
        { key: "median", title: "median", formatter: timeMs, comparable: true },
        { key: "mean", title: "mean", formatter: timeMs, comparable: true },
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

    const total = Object.values(opt.byTier).reduce((s, t) => s + t.count, 0);
    const tiers = Object.entries(opt.byTier)
      .sort((a, b) => b[1].count - a[1].count)
      .map(([name, t]) => `${name}:${((t.count / total) * 100).toFixed(0)}%`)
      .join(" ");

    return { tiers, deopt: opt.deoptCount > 0 ? opt.deoptCount : undefined };
  },
  columns: (): ReportColumnGroup<OptStats>[] => [
    {
      groupTitle: "v8 opt",
      columns: [
        {
          key: "tiers",
          title: "tiers",
          formatter: v => (typeof v === "string" ? v : ""),
        },
        {
          key: "deopt",
          title: "deopt",
          formatter: v => (typeof v === "number" ? String(v) : ""),
        },
      ],
    },
  ],
};

/** Build generic sections based on CLI flags */
export function buildGenericSections(args: {
  "gc-stats"?: boolean;
  alloc?: boolean;
}): ResultsMapper[] {
  const sections: ResultsMapper[] = [];
  if (args["gc-stats"]) sections.push(gcStatsSection);
  sections.push(runsSection);
  return sections;
}
