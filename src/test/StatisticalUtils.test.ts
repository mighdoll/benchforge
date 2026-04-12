import { expect, test } from "vitest";
import {
  blockDifferenceCI,
  sampleDifferenceCI,
} from "../stats/BootstrapDifference.ts";
import {
  average,
  blockBootstrap,
  coefficientOfVariation,
  findOutliers,
  median,
  medianAbsoluteDeviation,
  percentile,
  sampleBootstrap,
  standardDeviation,
} from "../stats/StatisticalUtils.ts";
import { assertValid, getSampleData } from "./TestUtils.ts";

test("calculates mean correctly", () => {
  const subset = getSampleData(0, 10);
  const expected = subset.reduce((a, b) => a + b, 0) / subset.length;
  expect(average(subset)).toBeCloseTo(expected, 5);
  expect(average([10])).toBe(10);
  expect(average([-5, 5])).toBe(0);
});

test("calculates standard deviation", () => {
  const subset = getSampleData(50, 100);
  const stddev = standardDeviation(subset);
  expect(stddev).toBeGreaterThan(0);
  expect(stddev).toBeLessThan(10);
  expect(standardDeviation([5, 5, 5])).toBe(0);
  expect(standardDeviation([5])).toBe(0);
});

test("calculates percentiles in order", () => {
  const subset = getSampleData(100, 200);
  const p25 = percentile(subset, 0.25);
  const p50 = percentile(subset, 0.5);
  const p75 = percentile(subset, 0.75);
  const p99 = percentile(subset, 0.99);

  assertValid.percentileOrder(p25, p50, p75, p99);
  expect(p50).toBeGreaterThan(40);
  expect(p50).toBeLessThan(60);
  expect(percentile([42], 0.5)).toBe(42);
});

test("calculates coefficient of variation", () => {
  const stable = getSampleData(200, 300);
  const cv = coefficientOfVariation(stable);
  expect(cv).toBeGreaterThan(0);
  expect(cv).toBeLessThan(0.2);
  expect(coefficientOfVariation([-1, 0, 1])).toBe(0);
  expect(coefficientOfVariation([5, 5, 5])).toBe(0);
});

test("calculates median absolute deviation", () => {
  const warmup = getSampleData(0, 30);
  const mad = medianAbsoluteDeviation(warmup);
  expect(mad).toBeGreaterThan(0);
  expect(mad).toBeLessThan(15);
  expect(medianAbsoluteDeviation([1, 2, 3, 4, 5])).toBe(1);
});

test("identifies outliers in mixed data", () => {
  const mixed = [...getSampleData(0, 50)];
  mixed.push(200, 5);
  const outliers = findOutliers(mixed);

  expect(outliers.rate).toBeGreaterThan(0);
  expect(outliers.indices).toContain(50);
  expect(outliers.indices).toContain(51);
});

test("sampleBootstrap estimates median with CI", () => {
  const stable = getSampleData(400, 450);
  const result = sampleBootstrap(stable, median, { resamples: 1000 });
  expect(result.ciLevel).toBe("sample");
  expect(result.ci[0]).toBeLessThanOrEqual(result.estimate);
  expect(result.ci[1]).toBeGreaterThanOrEqual(result.estimate);
});

test("blockBootstrap estimates median with confidence intervals", () => {
  const stable = getSampleData(400, 450);
  const actual = percentile(stable, 0.5);
  const blocks = Array.from({ length: 5 }, (_, i) => i * 10);
  const result = blockBootstrap(stable, blocks, median, { resamples: 1000 });

  expect(result.ciLevel).toBe("block");
  expect(result.estimate).toBeCloseTo(actual, 1);
  expect(result.ci[0]).toBeLessThanOrEqual(result.estimate);
  expect(result.ci[1]).toBeGreaterThanOrEqual(result.estimate);
  expect(result.ci[1] - result.ci[0]).toBeLessThan(5);
  expect(result.samples).toHaveLength(1000);
});

test("sampleDifferenceCI detects improvement", () => {
  const baseline = getSampleData(0, 100);
  const improved = baseline.map(v => v * 0.8);
  const result = sampleDifferenceCI(baseline, improved, median, {
    resamples: 1000,
  });
  expect(result.ciLevel).toBe("sample");
  expect(result.percent).toBeCloseTo(-20, 0);
});

test("blockDifferenceCI detects improvement", () => {
  const baseline = getSampleData(0, 100);
  const improved = baseline.map(v => v * 0.8);
  const blocks = Array.from({ length: 10 }, (_, i) => i * 10);
  const result = blockDifferenceCI(baseline, blocks, improved, median, {
    resamples: 1000,
  });

  expect(result.ciLevel).toBe("block");
  expect(result.percent).toBeCloseTo(-20, 0);
  expect(result.ci[1]).toBeLessThan(0);
  expect(result.direction).toBe("faster");
});

test("blockDifferenceCI detects regression", () => {
  const baseline = getSampleData(0, 100);
  const slower = baseline.map(v => v * 1.2);
  const blocks = Array.from({ length: 10 }, (_, i) => i * 10);
  const result = blockDifferenceCI(baseline, blocks, slower, median, {
    resamples: 1000,
  });

  expect(result.ciLevel).toBe("block");
  expect(result.percent).toBeCloseTo(20, 0);
  expect(result.ci[0]).toBeGreaterThan(0);
  expect(result.direction).toBe("slower");
});

test("blockDifferenceCI shows uncertainty for noise", () => {
  const baseline = getSampleData(0, 100);
  const noisy = baseline.map(v => v + (Math.random() - 0.5) * 2);
  const blocks = Array.from({ length: 10 }, (_, i) => i * 10);
  const result = blockDifferenceCI(baseline, blocks, noisy, median, {
    resamples: 1000,
  });

  expect(result.ciLevel).toBe("block");
  expect(result.ci[0]).toBeLessThanOrEqual(0);
  expect(result.ci[1]).toBeGreaterThanOrEqual(0);
  expect(result.direction).toBe("uncertain");
});
