import { expect, test } from "vitest";
import type { CaseResult, MatrixResults } from "../BenchMatrix.ts";
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

test("reportMatrixResults: outputs one table per case", () => {
  const results = mockResults("MultiCase", [
    {
      id: "fast",
      cases: [
        { caseId: "case1", mean: 1.0 },
        { caseId: "case2", mean: 2.0 },
      ],
    },
    {
      id: "slow",
      cases: [
        { caseId: "case1", mean: 10.0 },
        { caseId: "case2", mean: 20.0 },
      ],
    },
  ]);
  const report = reportMatrixResults(results);
  expect(report).toContain("case1");
  expect(report).toContain("case2");
  expect(report).toContain("fast");
  expect(report).toContain("slow");
});

test("reportMatrixResults: includes metadata in case title", () => {
  const results = mockResults("WithMetadata", [
    {
      id: "fast",
      cases: [{ caseId: "bevy_env_map", mean: 1.0, metadata: { LOC: 1200 } }],
    },
  ]);
  const report = reportMatrixResults(results);
  expect(report).toContain("bevy_env_map (1200 LOC)");
});

test("reportMatrixResults: formats time in ms", () => {
  const results = mockResults("TimeFormat", [
    { id: "variant", cases: [{ caseId: "test", mean: 2.34 }] },
  ]);
  const report = reportMatrixResults(results);
  expect(report).toContain("2.34ms");
});

test("reportMatrixResults: formats time in seconds for large values", () => {
  const results = mockResults("TimeFormat", [
    { id: "variant", cases: [{ caseId: "test", mean: 1500 }] },
  ]);
  const report = reportMatrixResults(results);
  expect(report).toContain("1.50s");
});

test("reportMatrixResults: shows variant column", () => {
  const results = mockResults("VarCol", [
    { id: "my_variant", cases: [{ caseId: "test", mean: 1.0 }] },
  ]);
  const report = reportMatrixResults(results);
  expect(report).toContain("variant");
  expect(report).toContain("my_variant");
});

test("reportMatrixResults: truncates long variant names", () => {
  const results = mockResults("TruncTest", [
    {
      id: "this_is_a_very_long_variant_name_that_should_be_truncated",
      cases: [{ caseId: "test", mean: 1.0 }],
    },
  ]);
  const report = reportMatrixResults(results);
  // 25 char limit => 22 chars + "..."
  expect(report).toContain("this_is_a_very_long_va...");
});

test("reportMatrixResults: empty variants returns header only", () => {
  const results: MatrixResults = { name: "Empty", variants: [] };
  const report = reportMatrixResults(results);
  expect(report).toBe("Matrix: Empty");
});

test("reportMatrixResults: with baseline shows diff percentage", () => {
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
  // Should contain diff percentage inline (not as separate header)
  expect(report).toContain("-50.0%");
});
