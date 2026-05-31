import { expect, test } from "vitest";
import type {
  BenchmarkReport,
  ReportSection,
} from "../report/BenchmarkReport.ts";
import {
  computeColumnValues,
  findPrimaryCIColumn,
} from "../report/BenchmarkReport.ts";
import { timeSection } from "../report/StandardSections.ts";
import { reportResults, valuesForReports } from "../report/text/TextReport.ts";
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

function report(name: string, samples: number[]): BenchmarkReport {
  return { name, measuredResults: measured(samples) };
}

function range(n: number): number[] {
  return Array.from({ length: n }, (_, i) => i + 1);
}

/** A section mixing a non-bootstrappable max with a bootstrappable mean, to
 *  exercise primary-column and Δ% placement without the removed --stats parser. */
const maxMeanSection: ReportSection = {
  title: "time",
  columns: [
    { key: "max", title: "max", statKind: "max", comparable: true },
    { key: "mean", title: "mean", statKind: "mean", comparable: true },
  ],
};

test("timeSection is mean only", () => {
  expect(timeSection.columns.map(c => c.key ?? c.title)).toEqual(["mean"]);
});

test("computeColumnValues computes the mean from samples", () => {
  const row = computeColumnValues(timeSection, measured([10, 20, 30, 40, 50]));
  expect(row.mean).toBe(30);
});

test("findPrimaryCIColumn skips non-bootstrappable stats", () => {
  // max comes first but is non-bootstrappable; mean must win.
  expect(findPrimaryCIColumn([maxMeanSection])?.key).toBe("mean");
});

test("findPrimaryCIColumn returns undefined when no stat is bootstrappable", () => {
  const maxMin: ReportSection = {
    title: "time",
    columns: [
      { key: "max", title: "max", statKind: "max", comparable: true },
      { key: "min", title: "min", statKind: "min", comparable: true },
    ],
  };
  expect(findPrimaryCIColumn([maxMin])).toBeUndefined();
});

test("reportResults with a baseline shows Δ% next to the first bootstrappable column", () => {
  const groups = [
    {
      name: "g",
      reports: [report("bench", range(100))],
      baseline: report(
        "baseline",
        range(100).map(x => x * 2),
      ),
    },
  ];
  const table = reportResults(groups, [maxMeanSection]);
  expect(table).toContain("Δ% CI");
  // Δ% column sits after mean (the primary), not after the leading max.
  const lines = table.split("\n");
  const header = lines.find(l => l.includes("max") && l.includes("mean"));
  expect(header).toBeDefined();
  const maxIdx = header!.indexOf("max");
  const meanIdx = header!.indexOf("mean");
  const ciIdx = header!.indexOf("Δ% CI");
  expect(ciIdx).toBeGreaterThan(meanIdx);
  expect(meanIdx).toBeGreaterThan(maxIdx);
});

test("valuesForReports extracts the section's column keys", () => {
  const rows = valuesForReports([report("bench", range(100))], [timeSection]);
  expect(rows[0].mean).toBeCloseTo(50.5, 0);
});
