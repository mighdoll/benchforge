import type { MeasuredResults } from "../runners/MeasuredResults.ts";
import {
  type MetricSection,
  metricSection,
  type ReportSection,
  type ScalarSection,
  scalarSection,
} from "./BenchmarkReport.ts";
import { timeMs } from "./Formatters.ts";
import { gcStatsSection } from "./GcSections.ts";

/** Timing section: the mean (+ a Δ% CI when a baseline exists). Per-percentile
 *  detail lives in the markdown report and HTML viewer (shift function), so the
 *  console stays a one-glance headline. */
export const timeSection: MetricSection = metricSection({
  title: "time",
  statKind: "mean",
  formatter: timeMs,
});

/** Report section: number of sample iterations. Footer-placed -- it's run
 *  metadata, not a headline result, so it sits once at the bottom of a case. */
export const runsSection: ScalarSection = scalarSection({
  title: "",
  placement: "footer",
  rows: [
    {
      key: "runs",
      title: "runs",
      formatter: v => String(v),
      value: (r: MeasuredResults) => r.iterations ?? r.samples.length,
    },
  ],
});

/** Default report sections: time, optional GC stats, then the runs footer. */
export function defaultReportSections(gcStats: boolean): ReportSection[] {
  return [timeSection, ...(gcStats ? [gcStatsSection] : []), runsSection];
}
