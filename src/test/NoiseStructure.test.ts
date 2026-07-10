import { expect, test } from "vitest";
import { splitByOffsets } from "../stats/BlockBootstrap.ts";
import { seededRng } from "../stats/Bootstrap.ts";
import {
  batchMeanAutocorrelation,
  pairingBenefit,
  roundPairCorrelation,
  varianceInflation,
  withinBatchAutocorrelation,
} from "../stats/NoiseStructure.ts";
import { batchOffsets, sharedDriftData } from "./TestUtils.ts";

const resamples = 4000;

// Data generation and bootstrap resampling (the `random` option) share one
// seeded PRNG stream per test, so every asserted statistic is deterministic.
// Bounds stay loose anyway: they document the claim (e.g. vif ~ 1 for IID
// data), and seeds are chosen so the realized dataset sits mid-band -- a
// finite draw shifts the center (e.g. the realized batch-mean variance of 20
// batches swings the IID vif by ~30%), and an unlucky seed parks it on a
// bound.

/** Independent batches of IID samples around 100. */
function iidBatches(
  n: number,
  perBatch: number,
  rand: () => number,
): number[][] {
  return Array.from({ length: n }, () =>
    Array.from({ length: perBatch }, () => 100 + (rand() - 0.5) * 10),
  );
}

/** Independent batches, each an AR(1) series (consecutive samples correlated). */
function arBatches(
  n: number,
  perBatch: number,
  phi: number,
  rand: () => number,
): number[][] {
  return Array.from({ length: n }, () => {
    const out: number[] = [];
    let prev = 0;
    for (let i = 0; i < perBatch; i++) {
      prev = phi * prev + (rand() - 0.5) * 10;
      out.push(100 + prev);
    }
    return out;
  });
}

/** One batch per level, samples clustered at that level with small jitter. */
function leveledBatches(
  levels: number[],
  perBatch: number,
  rand: () => number,
): number[][] {
  return levels.map(level =>
    Array.from({ length: perBatch }, () => level + (rand() - 0.5) * 2),
  );
}

test("IID samples show no variance inflation or autocorrelation", () => {
  const rand = seededRng(6);
  const batches = iidBatches(20, 100, rand);
  const offsets = batchOffsets(20, 100);
  const vif = varianceInflation(batches.flat(), offsets, "mean", {
    resamples,
    random: rand,
  });

  expect(vif.vif).toBeGreaterThan(0.5);
  expect(vif.vif).toBeLessThan(1.8);
  expect(Math.abs(withinBatchAutocorrelation(batches)[0])).toBeLessThan(0.2);
  expect(Math.abs(batchMeanAutocorrelation(batches)[0])).toBeLessThan(0.4);
});

test("within-batch autocorrelation inflates variance and shows in the ACF", () => {
  const rand = seededRng(2);
  const batches = arBatches(30, 150, 0.9, rand);
  const offsets = batchOffsets(30, 150);
  const vif = varianceInflation(batches.flat(), offsets, "mean", {
    resamples,
    random: rand,
  });

  expect(vif.vif).toBeGreaterThan(1.2);
  expect(withinBatchAutocorrelation(batches)[0]).toBeGreaterThan(0.4);
});

test("shared round drift makes pairing sharpen the delta", () => {
  const { baseline, current, blocks } = sharedDriftData(20, 50, 1.05);
  const pairing = pairingBenefit(baseline, blocks, current, blocks, "mean", {
    resamples,
    random: seededRng(3),
  });
  const corr = roundPairCorrelation(
    splitByOffsets(baseline, blocks),
    splitByOffsets(current, blocks),
  );

  expect(pairing.ratio).toBeLessThan(0.3);
  expect(corr.overall).toBeGreaterThan(0.9);
});

test("independent rounds give ~zero correlation and no pairing benefit", () => {
  const rand = seededRng(11);
  const baseLevels = Array.from({ length: 24 }, () => 100 + rand() * 40);
  const curLevels = Array.from({ length: 24 }, () => 100 + rand() * 40);
  const baseBatches = leveledBatches(baseLevels, 50, rand);
  const curBatches = leveledBatches(curLevels, 50, rand);
  const offsets = batchOffsets(24, 50);
  const pairing = pairingBenefit(
    baseBatches.flat(),
    offsets,
    curBatches.flat(),
    offsets,
    "mean",
    { resamples, random: rand },
  );

  expect(
    Math.abs(roundPairCorrelation(baseBatches, curBatches).overall),
  ).toBeLessThan(0.4);
  expect(pairing.ratio).toBeGreaterThan(0.75);
});

test("anti-correlated rounds make pairing widen the delta", () => {
  const rand = seededRng(4);
  const deltas = Array.from({ length: 24 }, () => rand() * 20);
  const baseBatches = leveledBatches(
    deltas.map(d => 100 + d),
    50,
    rand,
  );
  const curBatches = leveledBatches(
    deltas.map(d => 100 - d),
    50,
    rand,
  );
  const offsets = batchOffsets(24, 50);
  const pairing = pairingBenefit(
    baseBatches.flat(),
    offsets,
    curBatches.flat(),
    offsets,
    "mean",
    { resamples, random: rand },
  );

  expect(roundPairCorrelation(baseBatches, curBatches).overall).toBeLessThan(
    -0.5,
  );
  expect(pairing.ratio).toBeGreaterThan(1.1);
});

test("constant samples give zero widths and non-finite ratios", () => {
  const rand = seededRng(7);
  const samples = new Array<number>(200).fill(100);
  const offsets = batchOffsets(4, 50);
  const vif = varianceInflation(samples, offsets, "mean", {
    resamples: 200,
    random: rand,
  });
  const pairing = pairingBenefit(samples, offsets, samples, offsets, "mean", {
    resamples: 200,
    random: rand,
  });

  expect(vif.blockWidth).toBe(0);
  expect(vif.iidWidth).toBe(0);
  expect(Number.isFinite(vif.vif)).toBe(false);
  expect(pairing.pairedWidth).toBe(0);
  expect(pairing.unpairedWidth).toBe(0);
  expect(Number.isFinite(pairing.ratio)).toBe(false);
});

test("multi-round drift shows up as batch-mean autocorrelation", () => {
  const rand = seededRng(5);
  const levels: number[] = [];
  let prev = 0;
  for (let r = 0; r < 30; r++) {
    prev = 0.9 * prev + (rand() - 0.5) * 30;
    levels.push(100 + prev);
  }
  const batches = leveledBatches(levels, 40, rand);

  expect(batchMeanAutocorrelation(batches)[0]).toBeGreaterThan(0.4);
});
