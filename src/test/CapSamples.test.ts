import { expect, test } from "vitest";
import { blockPoolBootstrap, prepareBlocks } from "../stats/BlockBootstrap.ts";
import { blockDifferenceCI } from "../stats/BlockDifference.ts";
import { maxBootstrapInput, multiSampleBootstrap } from "../stats/Bootstrap.ts";
import { mean, percentile } from "../stats/CoreStats.ts";
import { multiSampleDifferenceCI } from "../stats/SingleSampleDifference.ts";

/** Batches of equal size starting at 0, total `batchSize * batches`. */
function offsetsFor(batchSize: number, batches: number): number[] {
  return Array.from({ length: batches }, (_, i) => i * batchSize);
}

test("multiSampleBootstrap uses full samples for point estimate", () => {
  const samples = Array.from({ length: 5000 }, (_, i) => i);
  const [result] = multiSampleBootstrap(samples, ["mean"], { resamples: 100 });
  expect(result.estimate).toBe(mean(samples));
});

test("multiSampleDifferenceCI preserves point estimate", () => {
  const a = Array.from({ length: 5000 }, () => 50 + Math.random() * 10);
  const b = a.map(v => v * 1.1);
  const [result] = multiSampleDifferenceCI(a, b, ["mean"], { resamples: 100 });
  const expected = ((mean(b) - mean(a)) / mean(a)) * 100;
  expect(result.percent).toBeCloseTo(expected, 10);
});

test("multiSampleBootstrap point estimate uses full array when capped", () => {
  const n = maxBootstrapInput + 5000;
  const samples = Array.from({ length: n }, (_, i) => i);
  const [result] = multiSampleBootstrap(samples, ["mean"], { resamples: 50 });
  expect(result.estimate).toBe(mean(samples));
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
  expect(result.estimate).toBe(mean(samples));
  expect(result.samples).toHaveLength(50);
  expect(result.ci[0]).toBeLessThanOrEqual(result.estimate);
  expect(result.ci[1]).toBeGreaterThanOrEqual(result.estimate);
});

// The block/pool bootstrap path (>=2 batches) must cap its resample source the
// same way the single-sample path does, or per-draw cost grows unbounded with
// the pooled sample count (the source of the multi-batch report hang).

test("prepareBlocks caps the resample source but keeps the full pool for estimates", () => {
  const batchSize = 3000;
  const batches = 6;
  const samples = Array.from({ length: batchSize * batches }, (_, i) => i);
  const side = prepareBlocks(
    samples,
    offsetsFor(batchSize, batches),
    mean,
    true,
    maxBootstrapInput,
  );
  const drawn = side.keptSplits.reduce((n, b) => n + b.length, 0);
  expect(drawn).toBeLessThanOrEqual(maxBootstrapInput);
  expect(side.filtered).toHaveLength(batchSize * batches);
});

test("prepareBlocks leaves splits untouched when under the cap", () => {
  const samples = Array.from({ length: 600 }, (_, i) => i);
  const side = prepareBlocks(
    samples,
    offsetsFor(200, 3),
    mean,
    true,
    maxBootstrapInput,
  );
  expect(side.keptSplits.reduce((n, b) => n + b.length, 0)).toBe(600);
});

test("blockPoolBootstrap point estimate uses the full pool when capped", () => {
  const batchSize = 3000;
  const batches = 6;
  const samples = Array.from({ length: batchSize * batches }, (_, i) => i);
  const offsets = offsetsFor(batchSize, batches);
  const result = blockPoolBootstrap(samples, offsets, s => percentile(s, 0.5), {
    resamples: 50,
    noTrim: true,
  });
  expect(result.estimate).toBe(percentile(samples, 0.5));
});

test("blockDifferenceCI preserves the point estimate when capped", () => {
  const batchSize = 3000;
  const batches = 6;
  const a = Array.from(
    { length: batchSize * batches },
    () => 50 + Math.random() * 10,
  );
  const b = a.map(v => v * 1.1);
  const offsets = offsetsFor(batchSize, batches);
  const result = blockDifferenceCI(a, offsets, b, mean, {
    resamples: 50,
    noBatchTrim: true,
  });
  expect(result.percent).toBeCloseTo(((mean(b) - mean(a)) / mean(a)) * 100, 10);
});
