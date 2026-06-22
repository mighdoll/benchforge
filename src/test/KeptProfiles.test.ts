import { expect, test } from "vitest";
import type { TimeProfile } from "../profiling/node/TimeSampler.ts";
import { keptProfilesOf } from "../report/HtmlReport.ts";
import type { MeasuredResults } from "../runners/MeasuredResults.ts";

/** Minimal MeasuredResults; keptProfilesOf only reads samples/batch fields. */
function results(over: Partial<MeasuredResults>): MeasuredResults {
  return {
    name: "b",
    samples: [],
    time: { min: 0, max: 0, avg: 0, p50: 0, p75: 0, p99: 0, p999: 0 },
    ...over,
  };
}

/** A distinct profile tagged via startTime, so we can assert which survived. */
function prof(tag: number): TimeProfile {
  return { nodes: [], startTime: tag, endTime: 0, samples: [], timeDeltas: [] };
}

/** 5 batches of 2 samples each; batch 4 is a slow Tukey outlier (mean 100 vs 10). */
function fiveBatches(over: Partial<MeasuredResults> = {}): MeasuredResults {
  return results({
    samples: [10, 10, 10, 10, 10, 10, 10, 10, 100, 100],
    batchOffsets: [0, 2, 4, 6, 8],
    timeProfiles: [prof(0), prof(1), prof(2), prof(3), prof(4)],
    batchIterations: [100, 100, 100, 100, 50],
    iterations: 450,
    ...over,
  });
}

const tags = (ps: TimeProfile[]) => ps.map(p => p.startTime);

test("drops the slow-outlier batch's profile and its iterations", () => {
  const kept = keptProfilesOf(fiveBatches());
  expect(tags(kept.profiles)).toEqual([0, 1, 2, 3]);
  expect(kept.iterations).toBe(400); // 450 total minus the trimmed batch's 50
});

test("noTrim keeps every batch profile and the full iteration count", () => {
  const kept = keptProfilesOf(fiveBatches(), true);
  expect(tags(kept.profiles)).toEqual([0, 1, 2, 3, 4]);
  expect(kept.iterations).toBe(450);
});

test("no outlier keeps all profiles and the untrimmed iteration count", () => {
  const even = fiveBatches({
    samples: [10, 10, 10, 10, 10, 10, 10, 10, 10, 10],
  });
  const kept = keptProfilesOf(even);
  expect(tags(kept.profiles)).toEqual([0, 1, 2, 3, 4]);
  expect(kept.iterations).toBe(450);
});

test("single-batch result is never trimmed", () => {
  const single = results({
    samples: [10, 10],
    batchOffsets: [0],
    timeProfiles: [prof(0)],
    batchIterations: [100],
    iterations: 100,
  });
  const kept = keptProfilesOf(single);
  expect(tags(kept.profiles)).toEqual([0]);
  expect(kept.iterations).toBe(100);
});

test("falls back to all profiles when profiles and batches misalign", () => {
  // One batch lacks a profile, so the parallel arrays don't line up to trim.
  const misaligned = fiveBatches({
    timeProfiles: [prof(0), prof(1), prof(2), prof(3)],
  });
  const kept = keptProfilesOf(misaligned);
  expect(tags(kept.profiles)).toEqual([0, 1, 2, 3]);
  expect(kept.iterations).toBe(450);
});
