import { expect, test } from "vitest";
import type { ReportGroup } from "../report/BenchmarkReport.ts";
import {
  metricSection,
  metricStatKind,
  metricValue,
} from "../report/BenchmarkReport.ts";
import { consoleSummary } from "../report/ConsoleSummary.ts";
import { timeMs } from "../report/Formatters.ts";
import { prepareHtmlData } from "../report/HtmlReport.ts";
import { timeSection } from "../report/StandardSections.ts";
import type { MeasuredResults } from "../runners/MeasuredResults.ts";
import { batchOffsets, repeatedBatches } from "./TestUtils.ts";

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

function batchedValues(values: number[], perBatch: number): MeasuredResults {
  const samples = repeatedBatches(values, perBatch);
  return {
    ...measured(samples),
    batchOffsets: batchOffsets(values.length, perBatch),
  };
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

test("comparison metric values use the pairwise kept batch set", () => {
  // Batch 3 is a paired outlier: a slow 1000 in current matched to a fast 50 in
  // baseline. Pairwise trimming drops the pair, so the kept means are 110 vs 100.
  const groups: ReportGroup[] = [
    {
      name: "g",
      reports: [
        {
          name: "bench",
          measuredResults: batchedValues(
            [110, 110, 110, 1000, 110, 110, 110, 110],
            5,
          ),
        },
      ],
      baseline: {
        name: "baseline",
        measuredResults: batchedValues(
          [100, 100, 100, 50, 100, 100, 100, 100],
          5,
        ),
      },
    },
  ];

  const data = prepareHtmlData(groups, {
    sections: [timeSection],
    resamples: 100,
  });
  const entries = data.groups[0].sections?.[0].rows[0].entries;
  expect(entries?.[0].value).toBe("110ms");
  expect(entries?.[1].value).toBe("100ms");
  expect(entries?.[0].comparisonCI?.percent).toBeCloseTo(10, 6);
});

test("higherIsBetter + toDisplay reports the reciprocal comparison delta", () => {
  const locSection = metricSection({
    title: "lines / sec",
    higherIsBetter: true,
    toDisplay: (ms: number) => 1000 / ms,
    formatter: timeMs,
  });
  const groups: ReportGroup[] = [
    {
      name: "g",
      reports: [
        {
          name: "bench",
          measuredResults: batchedValues(Array(24).fill(1.15), 5),
        },
      ],
      baseline: {
        name: "baseline",
        measuredResults: batchedValues(Array(24).fill(4), 5),
      },
    },
  ];
  const data = prepareHtmlData(groups, {
    sections: [locSection],
    resamples: 100,
  });
  const entries = data.groups[0].sections?.[0].rows[0].entries;
  // 1.15ms vs 4ms baseline: -71.25% time ==> ~+247.8% loc/sec throughput.
  expect(entries?.[0].comparisonCI?.percent).toBeCloseTo(247.8, 0);
  expect(entries?.[0].comparisonCI?.direction).toBe("faster");
});

test("two variants pair each against the shared baseline", () => {
  const base = () => batchedValues([100, 100, 100, 100, 100, 100, 100, 100], 5);
  const groups: ReportGroup[] = [
    {
      name: "g",
      reports: [
        {
          name: "v1",
          measuredResults: batchedValues(
            [110, 110, 110, 110, 110, 110, 110, 110],
            5,
          ),
        },
        {
          name: "v2",
          measuredResults: batchedValues([90, 90, 90, 90, 90, 90, 90, 90], 5),
        },
      ],
      baseline: { name: "baseline", measuredResults: base() },
    },
  ];

  const data = prepareHtmlData(groups, {
    sections: [timeSection],
    resamples: 100,
  });
  // version mode lays out [v1, base1, v2, base2]; each baseline cell reuses the
  // pairing prepared for the variant immediately before it.
  const entries = data.groups[0].sections?.[0].rows[0].entries;
  expect(entries?.map(e => e.value)).toEqual([
    "110ms",
    "100ms",
    "90.0ms",
    "100ms",
  ]);
  expect(entries?.[0].comparisonCI?.percent).toBeCloseTo(10, 6);
  expect(entries?.[2].comparisonCI?.percent).toBeCloseTo(-10, 6);
  expect(entries?.[1].isBaseline).toBe(true);
  expect(entries?.[3].isBaseline).toBe(true);
});
