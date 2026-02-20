import { expect, test } from "vitest";
import { compareWithBaseline } from "../PermutationTest.ts";
import { assertValid, getSampleData } from "./TestUtils.ts";

test("detects 20% performance improvement", () => {
  const baseline = getSampleData(0, 100);
  const improved = baseline.map(v => v * 0.8);
  const result = compareWithBaseline(baseline, improved);

  expect(result.currentMedian).toBeLessThan(result.baselineMedian);
  expect(result.currentMean).toBeLessThan(result.baselineMean);
  expect(result.medianChange.percent).toBeCloseTo(-20, 0);
  expect(result.meanChange.percent).toBeCloseTo(-20, 0);
  expect(result.medianChange.significant).toBe(true);
  expect(["good", "strong"]).toContain(result.medianChange.significance);
  expect(result.meanChange.significant).toBe(true);
  expect(["good", "strong"]).toContain(result.meanChange.significance);
});

test("detects 30% performance regression", () => {
  const baseline = getSampleData(100, 200);
  const regressed = baseline.map(v => v * 1.3);
  const result = compareWithBaseline(baseline, regressed);

  expect(result.currentMedian).toBeGreaterThan(result.baselineMedian);
  expect(result.currentMean).toBeGreaterThan(result.baselineMean);
  expect(result.medianChange.percent).toBeCloseTo(30, 0);
  expect(result.meanChange.percent).toBeCloseTo(30, 0);
  expect(result.medianChange.significant).toBe(true);
  expect(result.meanChange.significant).toBe(true);
});

test("detects no change with noise", () => {
  const baseline = getSampleData(200, 300);
  const noisy = baseline.map(v => v + (Math.random() - 0.5) * 2);
  const result = compareWithBaseline(baseline, noisy);

  expect(Math.abs(result.medianChange.percent)).toBeLessThan(5);
  expect(Math.abs(result.meanChange.percent)).toBeLessThan(5);
  expect(result.medianChange.significant).toBe(false);
  expect(result.medianChange.significance).toBe("none");
  expect(result.meanChange.significant).toBe(false);
  expect(result.meanChange.significance).toBe("none");
});

test("compares early vs late benchmark runs", () => {
  const early = getSampleData(0, 50);
  const late = getSampleData(560, 610);
  const result = compareWithBaseline(early, late);

  expect(result.baselineMedian).toBeGreaterThan(40);
  expect(result.currentMedian).toBeGreaterThan(40);
  expect(result.baselineMean).toBeGreaterThan(40);
  expect(result.currentMean).toBeGreaterThan(40);
  assertValid.pValue(result.medianChange.pValue);
  assertValid.pValue(result.meanChange.pValue);
});

test("produces high p-values for identical data", () => {
  const samples = getSampleData(300, 350);
  const identical = [...samples];
  const result = compareWithBaseline(samples, identical);

  expect(result.medianChange.pValue).toBeGreaterThan(0.5);
  expect(result.meanChange.pValue).toBeGreaterThan(0.5);
});

test("produces low p-values for 4x performance difference", () => {
  const fast = getSampleData(400, 450).map(v => v * 0.5);
  const slow = getSampleData(450, 500).map(v => v * 2.0);
  const result = compareWithBaseline(fast, slow);

  expect(result.medianChange.pValue).toBeLessThan(0.01);
  expect(result.meanChange.pValue).toBeLessThan(0.01);
});

test("handles single value vs identical values", () => {
  const single = [50];
  const identical = [50, 50, 50, 50, 50];
  const result = compareWithBaseline(single, identical);

  expect(result.baselineMedian).toBe(50);
  expect(result.currentMedian).toBe(50);
  expect(result.baselineMean).toBe(50);
  expect(result.currentMean).toBe(50);
  expect(result.medianChange.percent).toBe(0);
  expect(result.meanChange.percent).toBe(0);
  expect(result.medianChange.significant).toBe(false);
  expect(result.meanChange.significant).toBe(false);
});

test("categorizes change significance by magnitude", () => {
  const baseline = getSampleData(0, 100);

  const slight = baseline.map(v => v * 1.05);
  const moderate = baseline.map(v => v * 1.15);
  const large = baseline.map(v => v * 1.5);

  const slightResult = compareWithBaseline(baseline, slight);
  const moderateResult = compareWithBaseline(baseline, moderate);
  const largeResult = compareWithBaseline(baseline, large);

  assertValid.significance(slightResult.medianChange.significance);
  assertValid.significance(moderateResult.medianChange.significance);
  assertValid.significance(largeResult.medianChange.significance);

  const levels = ["none", "weak", "good", "strong"];
  const slightIdx = levels.indexOf(slightResult.medianChange.significance);
  const largeIdx = levels.indexOf(largeResult.medianChange.significance);
  expect(largeIdx).toBeGreaterThanOrEqual(slightIdx);
});

test("compares warmup vs stable performance", () => {
  const warmup = getSampleData(0, 20);
  const stable = getSampleData(100, 120);
  const result = compareWithBaseline(warmup, stable);

  expect(result.baselineMedian).toBeGreaterThan(result.currentMedian);
  expect(result.medianChange.percent).toBeLessThan(0);
  expect(result.medianChange.absolute).toBeLessThan(0);
});
