import { expect, test } from "vitest";
import type { CaseResult, MatrixResults } from "../matrix/BenchMatrix.ts";
import { reportMatrixResults } from "../matrix/MatrixReport.ts";

/** Create simple measured results for testing */
function mockMeasured(avg: number, count = 10): CaseResult["measured"] {
  const samples = Array(count).fill(avg);
  return {
    name: "test",
    samples,
    time: { avg, min: avg, max: avg, p50: avg, p75: avg, p99: avg, p999: avg },
  };
}

/** Create a mock matrix result */
function mockResults(
  name: string,
  variants: Array<{
    id: string;
    cases: Array<{
      caseId: string;
      mean: number;
      metadata?: Record<string, unknown>;
    }>;
  }>,
): MatrixResults {
  const mapped = variants.map(v => ({
    id: v.id,
    cases: v.cases.map(c => ({
      caseId: c.caseId,
      measured: mockMeasured(c.mean),
      metadata: c.metadata,
    })),
  }));
  return { name, variants: mapped };
}

test("reportMatrixResults: basic output includes matrix name", () => {
  const results = mockResults("TestMatrix", [
    { id: "fast", cases: [{ caseId: "a", mean: 1.0 }] },
  ]);
  const report = reportMatrixResults(results);
  expect(report).toContain("Matrix: TestMatrix");
});

test("reportMatrixResults: no baselines yields just the matrix name", () => {
  const results = mockResults("MultiCase", [
    { id: "fast", cases: [{ caseId: "case1", mean: 1.0 }] },
    { id: "slow", cases: [{ caseId: "case1", mean: 10.0 }] },
  ]);
  const report = reportMatrixResults(results);
  expect(report).toBe("Matrix: MultiCase");
});

test("reportMatrixResults: empty variants returns header only", () => {
  const results: MatrixResults = { name: "Empty", variants: [] };
  const report = reportMatrixResults(results);
  expect(report).toBe("Matrix: Empty");
});

test("reportMatrixResults: with baseline shows a verdict with the diff percentage", () => {
  const baseline = mockMeasured(2.0, 20);
  const measured = mockMeasured(1.0, 20);
  const results: MatrixResults = {
    name: "WithBaseline",
    variants: [
      {
        id: "current",
        cases: [{ caseId: "test", measured, baseline, deltaPercent: -50 }],
      },
    ],
  };
  const report = reportMatrixResults(results);
  expect(report).toContain("Verdict:");
  expect(report).toContain("test/current");
  expect(report).toContain("-50.0%");
  expect(report).toContain("vs baseline");
});

test("reportMatrixResults: truncates long variant names in the verdict", () => {
  const baseline = mockMeasured(2.0, 20);
  const measured = mockMeasured(1.0, 20);
  const results: MatrixResults = {
    name: "TruncTest",
    variants: [
      {
        id: "this_is_a_very_long_variant_name_that_should_be_truncated",
        cases: [{ caseId: "test", measured, baseline }],
      },
    ],
  };
  const report = reportMatrixResults(results);
  // 25 char limit => 22 chars + "..."
  expect(report).toContain("this_is_a_very_long_va...");
});
