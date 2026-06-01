import type {
  MeasuredResults,
  OptStatusInfo,
} from "../runners/MeasuredResults.ts";
import {
  type MetricSection,
  metricSection,
  type ReportSection,
  type ScalarSection,
  scalarSection,
} from "./BenchmarkReport.ts";
import { formatConvergence, timeMs } from "./Formatters.ts";

/** Timing section: the mean (+ a Δ% CI when a baseline exists). Per-percentile
 *  detail lives in the markdown report and HTML viewer (shift function), so the
 *  console stays a one-glance headline. */
export const timeSection: MetricSection = metricSection({
  title: "time",
  statKind: "mean",
  formatter: timeMs,
});

/** Report section: number of sample iterations. */
export const runsSection: ScalarSection = scalarSection({
  title: "",
  rows: [
    {
      key: "runs",
      title: "runs",
      formatter: v => String(v),
      value: (r: MeasuredResults) => r.iterations ?? r.samples.length,
    },
  ],
});

/** Report section: total sampling duration. */
export const totalTimeSection: ScalarSection = scalarSection({
  title: "",
  rows: [
    {
      key: "totalTime",
      title: "time",
      formatter: formatTotalTime,
      value: (r: MeasuredResults) => r.totalTime,
    },
  ],
});

/** Report sections for adaptive mode: median time (the shift fan covers the
 *  rest of the distribution) plus convergence confidence. */
export const adaptiveSections: ReportSection[] = [
  metricSection({
    title: "time",
    statKind: { percentile: 0.5 },
    formatter: timeMs,
  }),
  scalarSection({
    title: "",
    rows: [
      {
        key: "convergence",
        title: "conv%",
        formatter: formatConvergence,
        value: (r: MeasuredResults) => r.convergence?.confidence,
      },
    ],
  }),
];

/** Report section: V8 optimization tier distribution and deopt count. */
export const optSection: ScalarSection = scalarSection({
  title: "v8 opt",
  rows: [
    {
      key: "tiers",
      title: "tiers",
      formatter: v => (typeof v === "string" ? v : ""),
      value: (r: MeasuredResults) =>
        r.optStatus ? formatTierSummary(r.optStatus) : undefined,
    },
    {
      key: "deopt",
      title: "deopt",
      formatter: v => (typeof v === "number" ? String(v) : ""),
      value: (r: MeasuredResults) => {
        const deoptCount = r.optStatus?.deoptCount;
        return deoptCount && deoptCount > 0 ? deoptCount : undefined;
      },
    },
  ],
});

/** Format V8 tier distribution sorted by count (e.g. "turbofan:85% sparkplug:15%"). */
export function formatTierSummary(
  opt: OptStatusInfo,
  nameValueSep = ":",
  entrySep = " ",
): string {
  const tiers = Object.entries(opt.byTier);
  const total = tiers.reduce((s, [, t]) => s + t.count, 0);
  const pct = (n: number) => `${((n / total) * 100).toFixed(0)}%`;
  return tiers
    .sort((a, b) => b[1].count - a[1].count)
    .map(([name, t]) => `${name}${nameValueSep}${pct(t.count)}`)
    .join(entrySep);
}

/** Format total time; brackets indicate >= 30s. */
function formatTotalTime(v: unknown): string {
  if (typeof v !== "number") return "";
  return v >= 30 ? `[${v.toFixed(1)}s]` : `${v.toFixed(1)}s`;
}
