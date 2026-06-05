import type { MeasuredResults } from "../runners/MeasuredResults.ts";
import {
  type MetricSection,
  metricSection,
  type ScalarSection,
  scalarSection,
} from "./BenchmarkReport.ts";
import { timeMs } from "./Formatters.ts";

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
