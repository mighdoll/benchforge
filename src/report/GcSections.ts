import type { NavTiming } from "../profiling/browser/BrowserProfiler.ts";
import type { MeasuredResults } from "../runners/MeasuredResults.ts";
import { average, median, percentile } from "../stats/StatisticalUtils.ts";
import type { ReportSection } from "./BenchmarkReport.ts";
import { formatBytes, integer, percent, timeMs } from "./Formatters.ts";

/** Report section: GC time as fraction of total benchmark time. */
export const gcSection: ReportSection = {
  title: "gc",
  columns: [
    {
      key: "gc",
      title: "mean",
      formatter: percent,
      comparable: true,
      value: (r: MeasuredResults) => {
        const { nodeGcTime, time, samples } = r;
        if (!nodeGcTime || !time?.avg) return undefined;
        const totalBenchTime = time.avg * samples.length;
        if (totalBenchTime <= 0) return undefined;
        const gcFraction = nodeGcTime.inRun / totalBenchTime;
        return gcFraction <= 1 ? gcFraction : undefined;
      },
    },
  ],
};

/** Report section: detailed GC stats from --trace-gc-nvp. */
export const gcStatsSection: ReportSection = {
  title: "gc",
  columns: [
    {
      key: "allocPerIter",
      title: "alloc/iter",
      formatter: formatBytes,
      comparable: true,
      value: (r: MeasuredResults) => {
        const { gcStats, samples } = r;
        if (!gcStats) return undefined;
        const alloc = gcStats.totalAllocated;
        return alloc != null ? alloc / (samples.length || 1) : undefined;
      },
    },
    {
      key: "collected",
      title: "collected",
      formatter: formatBytes,
      comparable: true,
      value: (r: MeasuredResults) => r.gcStats?.totalCollected || undefined,
    },
    {
      key: "scavenges",
      title: "scav",
      formatter: integer,
      comparable: true,
      value: (r: MeasuredResults) => r.gcStats?.scavenges,
    },
    {
      key: "fullGCs",
      title: "full",
      formatter: integer,
      comparable: true,
      value: (r: MeasuredResults) => r.gcStats?.markCompacts,
    },
    {
      key: "promoPercent",
      title: "promo%",
      formatter: percent,
      comparable: true,
      value: (r: MeasuredResults) => {
        const gs = r.gcStats;
        if (!gs) return undefined;
        const alloc = gs.totalAllocated;
        return alloc && alloc > 0 ? (gs.totalPromoted ?? 0) / alloc : undefined;
      },
    },
    {
      key: "pausePerIter",
      title: "pause/iter",
      formatter: timeMs,
      comparable: true,
      value: (r: MeasuredResults) => {
        const gs = r.gcStats;
        return gs ? gs.gcPauseTime / (r.samples.length || 1) : undefined;
      },
    },
  ],
};

/** Report section: browser GC stats from CDP tracing (subset of gcStatsSection). */
export const browserGcStatsSection: ReportSection = {
  title: "gc",
  columns: [
    gcStatsSection.columns.find(c => c.key === "collected")!,
    gcStatsSection.columns.find(c => c.key === "scavenges")!,
    gcStatsSection.columns.find(c => c.key === "fullGCs")!,
    {
      key: "pausePerIter",
      title: "pause",
      formatter: timeMs,
      comparable: true,
      value: gcStatsSection.columns.find(c => c.key === "pausePerIter")!.value!,
    },
  ],
};

/** Report sections: page-load stats (mean/p50/p99) across multiple iterations. */
export const pageLoadStatsSections: ReportSection[] = [
  pageLoadSection("DCL", n => n.domContentLoaded || undefined),
  pageLoadSection("load", n => n.loadEvent || undefined),
  pageLoadSection("LCP", n => n.lcp),
];

/** @return GC stats sections if enabled by CLI flags */
export function gcSections(args: { "gc-stats"?: boolean }): ReportSection[] {
  return args["gc-stats"] ? [gcStatsSection] : [];
}

/** Build a page-load section with mean/p50/p99 columns from NavTiming data */
function pageLoadSection(
  title: string,
  extract: (n: NavTiming) => number | undefined,
): ReportSection {
  const vals = (r: MeasuredResults) => navValues(r.navTimings, extract);
  const col = (suffix: string, stat: (v: number[]) => number) => ({
    key: `${title.toLowerCase()}${suffix}`,
    title: suffix.toLowerCase(),
    formatter: timeMs,
    value: (r: MeasuredResults) => {
      const v = vals(r);
      return v.length ? stat(v) : undefined;
    },
  });
  return {
    title,
    columns: [
      col("Mean", average),
      col("P50", median),
      col("P99", v => percentile(v, 0.99)),
    ],
  };
}

/** Extract one field from all NavTimings, filtering undefineds. */
function navValues(
  navs: NavTiming[] | undefined,
  fn: (n: NavTiming) => number | undefined,
): number[] {
  if (!navs?.length) return [];
  return navs.map(fn).filter((v): v is number => v != null);
}
