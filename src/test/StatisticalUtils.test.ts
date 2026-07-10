import { expect, test } from "vitest";
import {
  blockBootstrap,
  blockPoolBootstrap,
  findOutliers,
} from "../stats/BlockBootstrap.ts";
import {
  blockDifferenceCI,
  diffCIs,
  pairedBlockBootstrap,
  pairedBlockDifference,
  preparePairedBlocks,
} from "../stats/BlockDifference.ts";
import { seededRng } from "../stats/Bootstrap.ts";
import {
  coefficientOfVariation,
  integerCounts,
  mean,
  median,
  medianAbsoluteDeviation,
  percentile,
  standardDeviation,
} from "../stats/CoreStats.ts";
import { classifyDirection } from "../stats/SingleSampleDifference.ts";
import {
  assertValid,
  batchOffsets,
  getSampleData,
  repeatedBatches,
  sharedDriftData,
} from "./TestUtils.ts";

/** Build samples where per-batch p50s skew low but the pooled p50 sits high:
 *  4 batches of 20 samples ~100, 1 batch of 20 samples ~50. Pool p50 ~= 100,
 *  mean(per-batch p50) ~= 90. */
function skewedBatchData(): { samples: number[]; blocks: number[] } {
  const samples: number[] = [];
  for (let i = 0; i < 4; i++) {
    for (let k = 0; k < 20; k++) samples.push(100 + (k - 10) * 0.1);
  }
  for (let k = 0; k < 20; k++) samples.push(50 + (k - 10) * 0.1);
  const blocks = [0, 20, 40, 60, 80];
  return { samples, blocks };
}

test("calculates mean correctly", () => {
  const subset = getSampleData(0, 10);
  const expected = subset.reduce((a, b) => a + b, 0) / subset.length;
  expect(mean(subset)).toBeCloseTo(expected, 5);
  expect(mean([10])).toBe(10);
  expect(mean([-5, 5])).toBe(0);
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

test("blockBootstrap estimates median with confidence intervals", () => {
  const stable = getSampleData(400, 450);
  const actual = percentile(stable, 0.5);
  const blocks = batchOffsets(5, 10);
  const result = blockBootstrap(stable, blocks, median, { resamples: 1000 });

  expect(result.ciLevel).toBe("block");
  expect(result.estimate).toBeCloseTo(actual, 1);
  expect(result.ci[0]).toBeLessThanOrEqual(result.estimate);
  expect(result.ci[1]).toBeGreaterThanOrEqual(result.estimate);
  expect(result.ci[1] - result.ci[0]).toBeLessThan(5);
  expect(result.samples).toHaveLength(1000);
});

test("blockDifferenceCI detects improvement", () => {
  const baseline = getSampleData(0, 100);
  const improved = baseline.map(v => v * 0.8);
  const blocks = batchOffsets(10, 10);
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
  const blocks = batchOffsets(10, 10);
  const result = blockDifferenceCI(baseline, blocks, slower, median, {
    resamples: 1000,
  });

  expect(result.ciLevel).toBe("block");
  expect(result.percent).toBeCloseTo(20, 0);
  expect(result.ci[0]).toBeGreaterThan(0);
  expect(result.direction).toBe("slower");
});

test("blockDifferenceCI shows uncertainty for noise", () => {
  // Ten batches that swing +/-5% with no consistent direction: the paired delta
  // has no trend to lock onto, so the CI straddles zero. Deterministic, unlike
  // random noise, whose verdict flips ~5% of the time on resampling luck.
  const baseline: number[] = [];
  const noisy: number[] = [];
  const blocks = batchOffsets(10, 10);
  for (let b = 0; b < 10; b++) {
    const swing = b % 2 === 0 ? 1.05 : 0.95;
    for (let i = 0; i < 10; i++) {
      baseline.push(100 + i);
      noisy.push((100 + i) * swing);
    }
  }
  const result = blockDifferenceCI(baseline, blocks, noisy, median, {
    resamples: 1000,
  });

  expect(result.ciLevel).toBe("block");
  expect(result.ci[0]).toBeLessThan(0);
  expect(result.ci[1]).toBeGreaterThan(0);
  expect(result.direction).toBe("uncertain");
});

test("paired block comparison cancels shared drift for mean and p99", () => {
  const { baseline, current, blocks } = sharedDriftData(30, 5, 1.05);
  const [meanCI, p99CI] = diffCIs(
    baseline,
    blocks,
    current,
    blocks,
    ["mean", { percentile: 0.99 }],
    { resamples: 500 },
  );

  for (const ci of [meanCI, p99CI]) {
    expect(ci?.ciLevel).toBe("block");
    expect(ci?.percent).toBeCloseTo(5, 6);
    expect(ci?.ci[0]).toBeGreaterThan(4.99);
    expect(ci?.ci[1]).toBeLessThan(5.01);
    expect(ci?.direction).toBe("slower");
  }
});

test("paired delta is sharp while standalone CIs overlap", () => {
  const { baseline, current, blocks } = sharedDriftData(30, 5, 1.05);
  const pair = preparePairedBlocks(baseline, blocks, current, blocks, {
    noTrim: false,
    rand: seededRng(1),
  });
  const baseAbs = pairedBlockBootstrap(pair.baseline, mean, { resamples: 500 });
  const curAbs = pairedBlockBootstrap(pair.current, mean, { resamples: 500 });
  const delta = pairedBlockDifference(pair, mean, { resamples: 500 });

  // Strong run-to-run drift makes each standalone mean CI wide and overlapping,
  const overlap =
    baseAbs.ci[1] >= curAbs.ci[0] && curAbs.ci[1] >= baseAbs.ci[0];
  expect(overlap).toBe(true);
  expect(baseAbs.ci[1] - baseAbs.ci[0]).toBeGreaterThan(100);

  // yet pairing the same rounds cancels the shared drift: the delta is sharp
  // and excludes zero. Overlapping absolutes don't contradict the verdict.
  expect(delta.percent).toBeCloseTo(5, 6);
  expect(delta.ci[1] - delta.ci[0]).toBeLessThan(0.1);
  expect(delta.direction).toBe("slower");
});

test("pairwise trimming drops the matching current batch", () => {
  const blocks = batchOffsets(8, 5);
  const baseline = repeatedBatches(
    [100, 100, 100, 1000, 100, 100, 100, 100],
    5,
  );
  const current = repeatedBatches([110, 110, 110, 10, 110, 110, 110, 110], 5);
  const result = blockDifferenceCI(baseline, blocks, current, mean, {
    resamples: 200,
  });

  expect(result.trimmed).toEqual([1, 0]);
  expect(result.percent).toBeCloseTo(10, 6);
  expect(result.ci[0]).toBeCloseTo(10, 6);
  expect(result.ci[1]).toBeCloseTo(10, 6);
});

test("batched comparisons require aligned offsets", () => {
  expect(() =>
    diffCIs([1, 2, 3, 4], [0, 2], [1, 2, 3, 4], [0], ["mean"]),
  ).toThrow(/aligned batch counts/);

  expect(() =>
    diffCIs([1, 2, 3, 4], [0, 2], [1, 2, 3, 4], undefined, ["mean"]),
  ).toThrow(/batch offsets on both/);

  expect(() =>
    diffCIs([1, 2, 3, 4], [1, 2], [1, 2, 3, 4], [0, 2], ["mean"]),
  ).toThrow(/first offset/);
});

test("unbatched comparisons keep the sample-level fallback", () => {
  const [ci] = diffCIs([1, 2, 3, 4], undefined, [1, 2, 3, 5], undefined, [
    "mean",
  ]);
  expect(ci?.ciLevel).toBe("sample");
});

test("CIs are deterministic without an explicit random source", () => {
  const { baseline, current, blocks } = sharedDriftData(10, 5, 1.05);
  const run = () =>
    diffCIs(baseline, blocks, current, blocks, ["mean"], { resamples: 200 });
  expect(run()).toEqual(run());
});

test("classifyDirection without a margin colors any CI excluding zero", () => {
  expect(classifyDirection([-3, -1])).toBe("faster");
  expect(classifyDirection([1, 3])).toBe("slower");
  expect(classifyDirection([-1, 2])).toBe("uncertain");
});

test("classifyDirection: CI fully inside the margin is equivalent", () => {
  expect(classifyDirection([-0.5, 0.4], 2)).toBe("equivalent");
});

test("classifyDirection: CI straddling a margin edge is uncertain", () => {
  // One bound sits inside the noise band, so the effect is not provably beyond
  // noise: inconclusive, not faster/slower. Whether the CI also crosses zero is
  // irrelevant -- only the margin band matters.
  expect(classifyDirection([-2.5, -0.2], 2)).toBe("uncertain");
  expect(classifyDirection([0.2, 2.5], 2)).toBe("uncertain");
  expect(classifyDirection([-3, 2.5], 2)).toBe("uncertain"); // crosses zero too
  // The viewer p10 case: CI [+0.5, +5.0] straddles the +2 edge.
  expect(classifyDirection([0.5, 5], 2)).toBe("uncertain");
  expect(classifyDirection([-5, -0.5], 2)).toBe("uncertain");
});

test("classifyDirection: whole CI clearing the margin is faster/slower", () => {
  expect(classifyDirection([-4, -2.5], 2)).toBe("faster");
  expect(classifyDirection([2.5, 4], 2)).toBe("slower");
});

test("classifyDirection: margin 0 falls out as the CI-excludes-zero test", () => {
  // No special case for margin 0: a CI excluding zero is faster/slower, a CI
  // straddling zero is uncertain. A small margin can't suddenly flip this.
  expect(classifyDirection([0.05, 3.5], 0)).toBe("slower");
  expect(classifyDirection([-3.5, -0.05], 0)).toBe("faster");
  expect(classifyDirection([-0.05, 3.5], 0)).toBe("uncertain");
});

test("blockPoolBootstrap CI brackets the pooled estimate", () => {
  const { samples, blocks } = skewedBatchData();
  const result = blockPoolBootstrap(samples, blocks, s => percentile(s, 0.5), {
    resamples: 1000,
  });
  expect(result.ciLevel).toBe("block");
  // Estimate is p50 of pool: 80 samples near 100, 20 near 50 -> p50 ~= 100
  expect(result.estimate).toBeCloseTo(100, 0);
  // CI brackets the estimate (the property blockBootstrap can violate for
  // non-linear stats on skewed batch distributions).
  expect(result.ci[0]).toBeLessThanOrEqual(result.estimate);
  expect(result.ci[1]).toBeGreaterThanOrEqual(result.estimate);
});

test("blockDifferenceCI detects scaled improvement (percentile stat)", () => {
  const baseline = getSampleData(0, 100);
  const improved = baseline.map(v => v * 0.8);
  const blocks = batchOffsets(10, 10);
  const result = blockDifferenceCI(baseline, blocks, improved, median, {
    resamples: 1000,
  });
  expect(result.ciLevel).toBe("block");
  expect(result.percent).toBeCloseTo(-20, 0);
  expect(result.ci[1]).toBeLessThan(0);
  expect(result.direction).toBe("faster");
});

test("diffCIs routes percentile through the pool variant", () => {
  // Uniform data so both stats have a stable direction; the test's purpose is
  // to verify the dispatch wiring and the bracket invariant on the p50 CI.
  const base = getSampleData(0, 100);
  const cur = base.map(v => v * 0.9);
  const blocks = batchOffsets(10, 10);
  const [meanCI, p50CI] = diffCIs(
    base,
    blocks,
    cur,
    blocks,
    ["mean", { percentile: 0.5 }],
    { resamples: 1000 },
  );
  expect(meanCI?.direction).toBe("faster");
  expect(p50CI?.direction).toBe("faster");
  // The p50 path uses pooled draws: its CI brackets the observed
  // pooled-percentile diff (the property that fixes non-linear stats).
  if (p50CI) {
    expect(p50CI.ci[0]).toBeLessThanOrEqual(p50CI.percent);
    expect(p50CI.ci[1]).toBeGreaterThanOrEqual(p50CI.percent);
  }
});

test("integerCounts tallies and sorts by value ascending", () => {
  expect(integerCounts([2, 2, 3, 2, 3])).toEqual([
    { value: 2, count: 3 },
    { value: 3, count: 2 },
  ]);
});

test("integerCounts sorts numerically, not lexically", () => {
  const hist = integerCounts([10, 2, 10, 2, 2]);
  expect(hist.map(b => b.value)).toEqual([2, 10]);
});

test("integerCounts on a single plateau yields one bucket", () => {
  expect(integerCounts([2, 2, 2, 2])).toEqual([{ value: 2, count: 4 }]);
});

test("integerCounts on empty input yields empty", () => {
  expect(integerCounts([])).toEqual([]);
});
