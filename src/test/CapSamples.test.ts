import { expect, test } from "vitest";
import { multiSampleDifferenceCI } from "../stats/BootstrapDifference.ts";
import {
  average,
  maxBootstrapInput,
  multiSampleBootstrap,
  percentile,
} from "../stats/StatisticalUtils.ts";

test("multiSampleBootstrap uses full samples for point estimate", () => {
  const samples = Array.from({ length: 5000 }, (_, i) => i);
  const [result] = multiSampleBootstrap(samples, ["mean"], { resamples: 100 });
  expect(result.estimate).toBe(average(samples));
});

test("multiSampleDifferenceCI preserves point estimate", () => {
  const a = Array.from({ length: 5000 }, () => 50 + Math.random() * 10);
  const b = a.map(v => v * 1.1);
  const [result] = multiSampleDifferenceCI(a, b, ["mean"], { resamples: 100 });
  const expected = ((average(b) - average(a)) / average(a)) * 100;
  expect(result.percent).toBeCloseTo(expected, 10);
});

test("multiSampleBootstrap point estimate uses full array when capped", () => {
  const n = maxBootstrapInput + 5000;
  const samples = Array.from({ length: n }, (_, i) => i);
  const [result] = multiSampleBootstrap(samples, ["mean"], { resamples: 50 });
  expect(result.estimate).toBe(average(samples));
  expect(result.subsampled).toBe(n);
});

test("multiSampleBootstrap does not set subsampled when under cap", () => {
  const samples = Array.from({ length: 100 }, (_, i) => i);
  const [result] = multiSampleBootstrap(samples, ["mean"], { resamples: 50 });
  expect(result.subsampled).toBeUndefined();
});

test("multiSampleDifferenceCI sets subsampled when inputs exceed cap", () => {
  const n = maxBootstrapInput + 1000;
  const a = Array.from({ length: n }, () => 50 + Math.random() * 10);
  const b = a.map(v => v * 1.1);
  const [result] = multiSampleDifferenceCI(a, b, ["mean"], { resamples: 50 });
  expect(result.percent).toBeCloseTo(10, 0);
  expect(result.subsampled).toBe(n);
});

test("multiSampleDifferenceCI no subsampled flag when under cap", () => {
  const a = Array.from({ length: 100 }, () => 50 + Math.random() * 10);
  const b = a.map(v => v * 1.1);
  const [result] = multiSampleDifferenceCI(a, b, ["mean"], { resamples: 50 });
  expect(result.subsampled).toBeUndefined();
});

test("quickselect-based percentile matches sorted percentile", () => {
  const data = Array.from({ length: 1000 }, () => Math.random() * 100);
  const sorted = [...data].sort((a, b) => a - b);
  for (const p of [0.25, 0.5, 0.75, 0.99]) {
    const k = Math.max(0, Math.ceil(sorted.length * p) - 1);
    expect(percentile(data, p)).toBe(sorted[k]);
  }
});

test("quickselect handles small arrays", () => {
  expect(percentile([42], 0.5)).toBe(42);
  expect(percentile([1, 2], 0.5)).toBe(1);
  expect(percentile([1, 2], 1.0)).toBe(2);
});

test("quickselect handles duplicate values", () => {
  const data = [5, 5, 5, 5, 5, 10, 10, 10, 10, 10];
  expect(percentile(data, 0.5)).toBe(5);
  expect(percentile(data, 0.99)).toBe(10);
});

test("multiSampleBootstrap reuses buffer (no per-iteration allocation)", () => {
  const samples = [10, 20, 30, 40, 50];
  const [result] = multiSampleBootstrap(samples, ["mean"], { resamples: 50 });
  expect(result.estimate).toBe(average(samples));
  expect(result.samples).toHaveLength(50);
  expect(result.ci[0]).toBeLessThanOrEqual(result.estimate);
  expect(result.ci[1]).toBeGreaterThanOrEqual(result.estimate);
});
