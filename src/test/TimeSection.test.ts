import { expect, test } from "vitest";
import type { ReportGroup } from "../report/BenchmarkReport.ts";
import { metricStatKind, metricValue } from "../report/BenchmarkReport.ts";
import { consoleSummary } from "../report/ConsoleSummary.ts";
import { prepareHtmlData } from "../report/HtmlReport.ts";
import { timeSection } from "../report/StandardSections.ts";
import type { MeasuredResults } from "../runners/MeasuredResults.ts";

/** @return minimal MeasuredResults with the given samples (time fields derived trivially). */
function measured(samples: number[]): MeasuredResults {
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    name: "t",
    samples,
    time: {
      min: sorted[0],
      max: sorted[sorted.length - 1],
      avg: samples.reduce((a, b) => a + b, 0) / samples.length,
      p50: sorted[Math.floor(sorted.length * 0.5)],
      p75: sorted[Math.floor(sorted.length * 0.75)],
      p99: sorted[Math.floor(sorted.length * 0.99)],
      p999: sorted[Math.floor(sorted.length * 0.999)],
    },
  };
}

function range(n: number): number[] {
  return Array.from({ length: n }, (_, i) => i + 1);
}

test("timeSection is a mean metric", () => {
  expect(timeSection.kind).toBe("metric");
  expect(metricStatKind(timeSection)).toBe("mean");
  expect(timeSection.higherIsBetter).toBeFalsy();
});

test("metricValue computes the mean from samples", () => {
  expect(metricValue(timeSection, measured([10, 20, 30, 40, 50]))).toBe(30);
});

test("consoleSummary with a baseline shows the headline and verdict", () => {
  const groups: ReportGroup[] = [
    {
      name: "g",
      reports: [{ name: "bench", measuredResults: measured(range(100)) }],
      baseline: {
        name: "baseline",
        measuredResults: measured(range(100).map(x => x * 2)),
      },
    },
  ];
  const data = prepareHtmlData(groups, { sections: [timeSection] });
  const summary = consoleSummary(data);
  expect(summary).toContain("(mean)");
  expect(summary).toContain("vs baseline");
});

test("metricValue extracts the section's stat", () => {
  expect(metricValue(timeSection, measured(range(100)))).toBeCloseTo(50.5, 0);
});
