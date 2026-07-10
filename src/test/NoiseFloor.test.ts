import { expect, test } from "vitest";
import { noiseFloor } from "../stats/NoiseFloor.ts";
import { batchOffsets, repeatedBatches } from "./TestUtils.ts";

test("reads between-batch dispersion, drift, and kept batch count", () => {
  // batch means 10, 10, 12, 12: a step up in the second half of the run
  const samples = repeatedBatches([10, 10, 12, 12], 2);
  const offsets = batchOffsets(4, 2);
  const nf = noiseFloor(samples, offsets);
  expect(nf).toBeDefined();
  expect(nf!.batches).toBe(4);
  // SD([10,10,12,12]) / 11 * 100, n-1 basis
  expect(nf!.dispersionPct).toBeCloseTo(10.5, 1);
  // second half (12) vs first half (10): +2 / 11 * 100
  expect(nf!.driftPct).toBeCloseTo(18.18, 1);
  expect(nf!.halfWidthPct).toBeGreaterThan(0);
  expect(Number.isFinite(nf!.halfWidthPct)).toBe(true);
});

test("is undefined without 2+ batches", () => {
  expect(noiseFloor([1, 2, 3], undefined)).toBeUndefined();
  expect(noiseFloor([1, 2, 3], [0])).toBeUndefined();
});

test("trims slow-outlier batches like the verdict, unless noTrim", () => {
  const samples = repeatedBatches([10, 10, 10, 10, 100], 2);
  const offsets = batchOffsets(5, 2);
  const trimmed = noiseFloor(samples, offsets);
  expect(trimmed!.batches).toBe(4);
  expect(trimmed!.dispersionPct).toBeCloseTo(0, 5);

  const raw = noiseFloor(samples, offsets, true);
  expect(raw!.batches).toBe(5);
  expect(raw!.dispersionPct).toBeGreaterThan(0);
});
