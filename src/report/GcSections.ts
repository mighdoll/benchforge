import type { NavTiming } from "../profiling/browser/BrowserProfiler.ts";
import type { MeasuredResults } from "../runners/MeasuredResults.ts";
import { average, median, percentile } from "../stats/StatisticalUtils.ts";
import {
  type ReportSection,
  type ScalarSection,
  scalarSection,
} from "./BenchmarkReport.ts";
import { formatBytes, integer, percent, timeMs } from "./Formatters.ts";

/** Report section: detailed GC stats from --trace-gc-nvp. */
export const gcStatsSection: ScalarSection = scalarSection({
  title: "gc",
  layout: "matrix",
  rows: [
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
      key: "fullPerBatch",
      title: "full/batch",
      comparable: true,
      formatter: v => (typeof v === "string" ? v : ""),
      value: (r: MeasuredResults) => {
        const counts = r.batchGcStats?.map(g => g.markCompacts ?? 0);
        if (!counts?.length) return undefined;
        const min = Math.min(...counts);
        const max = Math.max(...counts);
        return min === max ? `${min}` : `${min}..${max}`;
      },
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
});

/** Report section: browser GC stats from CDP tracing (subset of gcStatsSection). */
export const browserGcStatsSection: ScalarSection = scalarSection({
  title: "gc",
  rows: [
    gcStatsSection.rows.find(r => r.key === "collected")!,
    gcStatsSection.rows.find(r => r.key === "scavenges")!,
    gcStatsSection.rows.find(r => r.key === "fullGCs")!,
    {
      key: "pausePerIter",
      title: "pause",
      formatter: timeMs,
      comparable: true,
      value: gcStatsSection.rows.find(r => r.key === "pausePerIter")!.value,
    },
  ],
});

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

/** Build a page-load section with mean/p50/p99 rows from NavTiming data */
function pageLoadSection(
  title: string,
  extract: (n: NavTiming) => number | undefined,
): ReportSection {
  const vals = (r: MeasuredResults) => navValues(r.navTimings, extract);
  const row = (suffix: string, stat: (v: number[]) => number) => ({
    key: `${title.toLowerCase()}${suffix}`,
    title: suffix.toLowerCase(),
    formatter: timeMs,
    value: (r: MeasuredResults) => {
      const v = vals(r);
      return v.length ? stat(v) : undefined;
    },
  });
  return scalarSection({
    title,
    rows: [
      row("Mean", average),
      row("P50", median),
      row("P99", v => percentile(v, 0.99)),
    ],
  });
}

/** Extract one field from all NavTimings, filtering undefineds. */
function navValues(
  navs: NavTiming[] | undefined,
  fn: (n: NavTiming) => number | undefined,
): number[] {
  if (!navs?.length) return [];
  return navs.map(fn).filter((v): v is number => v != null);
}
