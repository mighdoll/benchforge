import type {
  MeasuredResults,
  OptStatusInfo,
} from "../runners/MeasuredResults.ts";
import { isBootstrappable } from "../stats/StatisticalUtils.ts";
import type { ReportSection } from "./BenchmarkReport.ts";
import { formatConvergence, timeMs } from "./Formatters.ts";
import { gcSections } from "./GcSections.ts";
import { parseStatsArg } from "./ParseStats.ts";

/** Default timing section: mean, p50, p99. */
export const timeSection: ReportSection = buildTimeSection();

/** Report section: number of sample iterations. */
export const runsSection: ReportSection = {
  title: "",
  columns: [
    {
      key: "runs",
      title: "runs",
      formatter: v => String(v),
      value: (r: MeasuredResults) => r.samples.length,
    },
  ],
};

/** Report section: total sampling duration. */
export const totalTimeSection: ReportSection = {
  title: "",
  columns: [
    {
      key: "totalTime",
      title: "time",
      formatter: formatTotalTime,
      value: (r: MeasuredResults) => r.totalTime,
    },
  ],
};

/** Report sections: timing stats and convergence for adaptive mode. */
export const adaptiveSections: ReportSection[] = [
  {
    title: "time",
    columns: [
      {
        key: "median",
        title: "median",
        formatter: timeMs,
        comparable: true,
        statKind: { percentile: 0.5 },
      },
      {
        key: "mean",
        title: "mean",
        formatter: timeMs,
        comparable: true,
        statKind: "mean",
      },
      {
        key: "p99",
        title: "p99",
        formatter: timeMs,
        statKind: { percentile: 0.99 },
      },
    ],
  },
  {
    title: "",
    columns: [
      {
        key: "convergence",
        title: "conv%",
        formatter: formatConvergence,
        value: (r: MeasuredResults) => r.convergence?.confidence,
      },
    ],
  },
];

/** Report section: V8 optimization tier distribution and deopt count. */
export const optSection: ReportSection = {
  title: "v8 opt",
  columns: [
    {
      key: "tiers",
      title: "tiers",
      formatter: v => (typeof v === "string" ? v : ""),
      value: (r: MeasuredResults) => {
        const opt = r.optStatus;
        return opt ? formatTierSummary(opt) : undefined;
      },
    },
    {
      key: "deopt",
      title: "deopt",
      formatter: v => (typeof v === "number" ? String(v) : ""),
      value: (r: MeasuredResults) => {
        const opt = r.optStatus;
        return opt && opt.deoptCount > 0 ? opt.deoptCount : undefined;
      },
    },
  ],
};

/** Build a time section with user-chosen percentile/stat columns. */
export function buildTimeSection(stats = "mean,p50,p99"): ReportSection {
  const specs = parseStatsArg(stats);
  return {
    title: "time",
    columns: specs.map(s => ({
      key: s.key,
      title: s.title,
      formatter: timeMs,
      comparable: isBootstrappable(s.statKind),
      statKind: s.statKind,
    })),
  };
}

/** Format V8 tier distribution sorted by count (e.g. "turbofan:85% sparkplug:15%"). */
export function formatTierSummary(
  opt: OptStatusInfo,
  sep = ":",
  glue = " ",
): string {
  const tiers = Object.entries(opt.byTier);
  const total = tiers.reduce((s, [, t]) => s + t.count, 0);
  const pct = (n: number) => `${((n / total) * 100).toFixed(0)}%`;
  return tiers
    .sort((a, b) => b[1].count - a[1].count)
    .map(([name, t]) => `${name}${sep}${pct(t.count)}`)
    .join(glue);
}

/** @return default report sections from CLI flags (GC stats if enabled, plus run count). */
export function buildGenericSections(args: {
  "gc-stats"?: boolean;
  alloc?: boolean;
}): ReportSection[] {
  return [...gcSections(args), runsSection];
}

/** Format total time; brackets indicate >= 30s. */
function formatTotalTime(v: unknown): string {
  if (typeof v !== "number") return "";
  return v >= 30 ? `[${v.toFixed(1)}s]` : `${v.toFixed(1)}s`;
}
