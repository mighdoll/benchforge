import { expect, test } from "vitest";
import {
  type MetricSection,
  metricSection,
} from "../report/BenchmarkReport.ts";
import { timeMs } from "../report/Formatters.ts";
import { buildShiftFunction } from "../report/ShiftFunction.ts";
import type { MeasuredResults } from "../runners/MeasuredResults.ts";

// Structure tests don't need CI precision; a small bootstrap keeps them fast.
const fast = { resamples: 200 };

const timeMetric: MetricSection = metricSection({
  title: "lines / sec",
  statKind: { percentile: 0.5 },
  formatter: timeMs,
});

const locMetric: MetricSection = metricSection({
  title: "lines / sec",
  higherIsBetter: true,
  statKind: { percentile: 0.5 },
  toDisplay: (ms: number) => 1000 / ms,
  formatter: timeMs,
});

/** Build batched samples as a single global ramp across all batches, so each
 *  percentile's tail is genuinely sparse (good for reliability-gate tests).
 *  `shift` offsets every value, simulating a small uniform change. */
function batched(
  batches: number,
  perBatch: number,
  shift = 0,
): MeasuredResults {
  const samples: number[] = [];
  const batchOffsets: number[] = [];
  const n = batches * perBatch;
  let k = 0;
  for (let b = 0; b < batches; b++) {
    batchOffsets.push(samples.length);
    for (let i = 0; i < perBatch; i++) samples.push(1 + (k++ / n) * 2 + shift);
  }
  return { name: "x", samples, batchOffsets } as MeasuredResults;
}

test("returns undefined without a baseline", () => {
  const sf = buildShiftFunction(
    timeMetric,
    batched(30, 50),
    undefined,
    {},
    {},
    fast,
  );
  expect(sf).toBeUndefined();
});

test("leads with mean, then one point per sampled percentile", () => {
  const sf = buildShiftFunction(
    timeMetric,
    batched(30, 50, 0.1),
    batched(30, 50),
    {},
    {},
    fast,
  );
  expect(sf).toBeDefined();
  expect(sf!.points.length).toBe(10);
  expect(sf!.metric).toBe("lines / sec");
  expect(sf!.points[0].isMean).toBe(true);
  expect(sf!.points[0].label).toBe("mean");
  expect(sf!.points.slice(1).every(p => !p.isMean)).toBe(true);
});

test("isPrimary marks the configured verdict percentile, not the mean", () => {
  const sf = buildShiftFunction(
    timeMetric, // statKind: { percentile: 0.5 }
    batched(30, 50, 0.1),
    batched(30, 50),
    {},
    {},
    fast,
  )!;
  expect(sf.points[0].isPrimary).toBe(false); // leading mean is not the verdict
  const primary = sf.points.filter(p => p.isPrimary);
  expect(primary.length).toBe(1);
  expect(primary[0].percentile).toBe(0.5);
});

test("isPrimary marks the mean when the verdict stat is mean", () => {
  const meanMetric = metricSection({ title: "lines / sec", formatter: timeMs });
  const sf = buildShiftFunction(
    meanMetric,
    batched(30, 50, 0.1),
    batched(30, 50),
    {},
    {},
    fast,
  )!;
  expect(sf.points[0].isMean).toBe(true);
  expect(sf.points[0].isPrimary).toBe(true);
  expect(sf.points.slice(1).every(p => !p.isPrimary)).toBe(true);
});

test("percentile points are sorted ascending (mean stays first)", () => {
  const sf = buildShiftFunction(
    timeMetric,
    batched(30, 50, 0.1),
    batched(30, 50),
    {},
    {},
    fast,
  )!;
  expect(sf.points[0].isMean).toBe(true);
  const ps = sf.points.slice(1).map(p => p.percentile);
  expect(ps).toEqual([...ps].sort((a, b) => a - b));
});

test("higherIsBetter keeps absolute estimates monotonic across percentiles", () => {
  // loc/sec displayed-low percentile is the slow-time tail; mapping inverts so
  // absolute throughput should still increase with displayed percentile.
  const sf = buildShiftFunction(
    locMetric,
    batched(30, 50, 0.1),
    batched(30, 50),
    {},
    {},
    fast,
  )!;
  expect(sf.points[0].isMean).toBe(true);
  // skip the leading mean point; the percentile estimates should ramp upward.
  const ests = sf.points.slice(1).map(p => p.runs[0].bootstrapCI.estimate);
  const monotonic = ests.every((v, i) => i === 0 || v >= ests[i - 1]);
  expect(monotonic).toBe(true);
});

test("each point carries current and baseline absolute distributions", () => {
  const sf = buildShiftFunction(
    timeMetric,
    batched(30, 50, 0.1),
    batched(30, 50),
    {},
    {},
    fast,
  )!;
  for (const point of sf.points) {
    expect(point.runs.map(r => r.runName)).toEqual(["x", "baseline"]);
    for (const run of point.runs)
      expect(run.bootstrapCI.histogram.length).toBeGreaterThan(0);
  }
});

test("extreme tail percentiles are unreliable with too few samples", () => {
  // 30 x 5 = 150 samples: p1 has ~2 sparse-side samples => unreliable; p50 ok.
  const sf = buildShiftFunction(
    timeMetric,
    batched(30, 5, 0.1),
    batched(30, 5),
    {},
    {},
    fast,
  )!;
  expect(sf.points.find(p => p.label === "p1")!.reliable).toBe(false);
  expect(sf.points.find(p => p.label === "p50")!.reliable).toBe(true);
});

test("equivMargin is recorded for the plot band", () => {
  const sf = buildShiftFunction(
    timeMetric,
    batched(30, 50, 0.1),
    batched(30, 50),
    {},
    {},
    { ...fast, equivMargin: 2 },
  )!;
  expect(sf.equivMargin).toBe(2);
});

/** Build batched samples where the last batch is a slow outlier (so trimming
 *  by per-batch mean drops it). */
function withSlowBatch(batches: number, perBatch: number): MeasuredResults {
  const m = batched(batches, perBatch);
  const lastStart = (batches - 1) * perBatch;
  for (let i = lastStart; i < m.samples.length; i++) m.samples[i] += 100;
  return m;
}

test("tail coverage counts only the batches the bootstrap kept", () => {
  // The upper tail's support lives in the slow outlier batch. With trimming on
  // (default) that batch is dropped, so the kept upper tail has fewer samples
  // than the untrimmed view sees.
  const cur = withSlowBatch(8, 50);
  const base = withSlowBatch(8, 50);
  const trimmed = buildShiftFunction(timeMetric, cur, base, {}, {}, fast)!;
  const raw = buildShiftFunction(
    timeMetric,
    cur,
    base,
    {},
    {},
    {
      ...fast,
      noBatchTrim: true,
    },
  )!;
  const p95Trim = trimmed.points.find(p => p.label === "p95")!;
  const p95Raw = raw.points.find(p => p.label === "p95")!;
  expect(p95Trim.tailCount).toBeLessThan(p95Raw.tailCount);
});
