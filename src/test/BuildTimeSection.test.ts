import { expect, test } from "vitest";
import type { BenchmarkReport } from "../report/BenchmarkReport.ts";
import { computeColumnValues } from "../report/BenchmarkReport.ts";
import { buildTimeSection } from "../report/StandardSections.ts";
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

test("default buildTimeSection produces mean, p50, p99 columns", () => {
  const section = buildTimeSection();
  expect(section.columns.map(c => c.key ?? c.title)).toEqual([
    "mean",
    "p50",
    "p99",
  ]);
});

test("computeColumnValues computes values from samples", () => {
  const section = buildTimeSection("mean,p50,max,min");
  const row = computeColumnValues(section, measured([10, 20, 30, 40, 50]));
  expect(row.mean).toBe(30);
  expect(row.min).toBe(10);
  expect(row.max).toBe(50);
  expect(row.p50).toBeGreaterThanOrEqual(20);
  expect(row.p50).toBeLessThanOrEqual(40);
});

test("p70 returns value near 70th percentile of [1..100]", () => {
  const section = buildTimeSection("p70");
  const row = computeColumnValues(section, measured(range(100)));
  expect(row.p70).toBeGreaterThanOrEqual(69);
  expect(row.p70).toBeLessThanOrEqual(71);
});

test("p999 uses divide-by-1000 convention", () => {
  const section = buildTimeSection("p999");
  const row = computeColumnValues(section, measured(range(1000)));
  expect(row.p999).toBeGreaterThanOrEqual(999);
});

test("p9999 uses divide-by-10000 convention", () => {
  const section = buildTimeSection("p9999");
  const row = computeColumnValues(section, measured(range(10000)));
  expect(row.p9999).toBeGreaterThanOrEqual(9999);
});

test("median and p50 produce the same value", () => {
  const a = computeColumnValues(
    buildTimeSection("median"),
    measured(range(100)),
  );
  const b = computeColumnValues(buildTimeSection("p50"), measured(range(100)));
  expect(a.p50).toBe(b.p50);
});

test("mean and avg dedupe to a single column", () => {
  const section = buildTimeSection("mean,avg");
  expect(section.columns.length).toBe(1);
});

test("min and max return exact values", () => {
  const section = buildTimeSection("min,max");
  const row = computeColumnValues(section, measured([5, 1, 9, 3, 7]));
  expect(row.min).toBe(1);
  expect(row.max).toBe(9);
});

test("empty stats string throws", () => {
  expect(() => buildTimeSection("")).toThrow(/at least one column/);
  expect(() => buildTimeSection("  ,  ")).toThrow(/at least one column/);
});

test("unknown token throws with vocabulary hint", () => {
  expect(() => buildTimeSection("wat")).toThrow(
    /expected mean, median, min, max, or p<N>/,
  );
});

test("single-digit percentile token is rejected", () => {
  expect(() => buildTimeSection("p5")).toThrow(/at least 2 digits/);
});

test("3+ digit percentile tokens not starting with 9 are rejected", () => {
  expect(() => buildTimeSection("p100")).toThrow(/must start with 9/);
  expect(() => buildTimeSection("p500")).toThrow(/must start with 9/);
  expect(() => buildTimeSection("p1000")).toThrow(/must start with 9/);
});

test("reportResults renders user-chosen columns as table headers", () => {
  const groups = [{ name: "g", reports: [report("bench", range(100))] }];
  const table = reportResults(groups, [buildTimeSection("p70,p95")]);
  expect(table).toContain("p70");
  expect(table).toContain("p95");
});

test("valuesForReports extracts user-chosen keys", () => {
  const rows = valuesForReports(
    [report("bench", range(100))],
    [buildTimeSection("p70,p95")],
  );
  expect(rows[0].p70).toBeGreaterThanOrEqual(69);
  expect(rows[0].p70).toBeLessThanOrEqual(71);
  expect(rows[0].p95).toBeGreaterThanOrEqual(94);
  expect(rows[0].p95).toBeLessThanOrEqual(96);
});
