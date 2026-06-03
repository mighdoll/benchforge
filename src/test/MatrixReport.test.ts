import { expect, test } from "vitest";
import { reportMatrixResults } from "../matrix/MatrixReport.ts";
import type { ReportGroup } from "../report/BenchmarkReport.ts";
import { prepareHtmlData } from "../report/HtmlReport.ts";
import { timeSection } from "../report/StandardSections.ts";
import type { ReportData } from "../viewer/ReportData.ts";
import { createBenchmarkReport } from "./TestUtils.ts";

/** Build a matrix-shaped group ("variant / case", single report + baseline). */
function matrixGroup(
  variant: string,
  caseId: string,
  current: [number, number],
  baseline: [number, number],
): ReportGroup {
  return {
    name: `${variant} / ${caseId}`,
    reports: [createBenchmarkReport(variant, current)],
    baseline: createBenchmarkReport(`${variant} (baseline)`, baseline),
  };
}

/** Build ReportData the way the matrix pipeline does, via prepareHtmlData. */
function matrixData(groups: ReportGroup[]): ReportData {
  return prepareHtmlData(groups, { sections: [timeSection], resamples: 200 });
}

test("reportMatrixResults: a single comparison yields no tally (console prints it)", () => {
  const data = matrixData([matrixGroup("current", "test", [0, 30], [30, 60])]);
  expect(reportMatrixResults(data)).toBe("");
});

test("reportMatrixResults: no comparisons yields an empty string", () => {
  const data = prepareHtmlData(
    [{ name: "v / a", reports: [createBenchmarkReport("v", [0, 30])] }],
    { sections: [timeSection] },
  );
  expect(reportMatrixResults(data)).toBe("");
});

test("reportMatrixResults: multiple comparisons roll up into a tally", () => {
  const data = matrixData([
    matrixGroup("fast", "a", [0, 30], [30, 60]),
    matrixGroup("slow", "b", [30, 60], [0, 30]),
  ]);
  const report = reportMatrixResults(data);
  expect(report).toContain("Verdicts (2 vs baseline):");
  expect(report).toContain("better");
  expect(report).toContain("worse");
});

test("reportMatrixResults: tally labels name each variant / case", () => {
  const data = matrixData([
    matrixGroup("fast", "a", [0, 30], [30, 60]),
    matrixGroup("slow", "b", [30, 60], [0, 30]),
  ]);
  const report = reportMatrixResults(data);
  expect(report).toContain("fast / a");
  expect(report).toContain("slow / b");
});
