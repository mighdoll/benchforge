import { expect, test } from "vitest";
import type { ReportColumn } from "../report/BenchmarkReport.ts";
import { buildShiftFunction } from "../report/ShiftFunction.ts";
import type { MeasuredResults } from "../runners/MeasuredResults.ts";

const section = "lines / sec";

const timeCol: ReportColumn = {
  key: "p50",
  title: "p50",
  comparable: true,
  statKind: { percentile: 0.5 },
};

const locCol: ReportColumn = {
  key: "locSec",
  title: "lines / sec",
  comparable: true,
  higherIsBetter: true,
  statKind: { percentile: 0.5 },
  toDisplay: (ms: number) => 1000 / ms,
};

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
    timeCol,
    section,
    batched(30, 50),
    undefined,
    {},
    {},
    {},
  );
  expect(sf).toBeUndefined();
});

test("leads with mean, then one point per sampled percentile", () => {
  const sf = buildShiftFunction(
    timeCol,
    section,
    batched(30, 50, 0.1),
    batched(30, 50),
    {},
    {},
    {},
  );
  expect(sf).toBeDefined();
  expect(sf!.points.length).toBe(10);
  expect(sf!.metric).toBe(section);
  expect(sf!.points[0].isMean).toBe(true);
  expect(sf!.points[0].label).toBe("mean");
  expect(sf!.points.slice(1).every(p => !p.isMean)).toBe(true);
});

test("percentile points are sorted ascending (mean stays first)", () => {
  const sf = buildShiftFunction(
    timeCol,
    section,
    batched(30, 50, 0.1),
    batched(30, 50),
    {},
    {},
    {},
  )!;
  expect(sf.points[0].isMean).toBe(true);
  const ps = sf.points.slice(1).map(p => p.percentile);
  expect(ps).toEqual([...ps].sort((a, b) => a - b));
});

test("higherIsBetter keeps absolute estimates monotonic across percentiles", () => {
  // loc/sec displayed-low percentile is the slow-time tail; mapping inverts so
  // absolute throughput should still increase with displayed percentile.
  const sf = buildShiftFunction(
    locCol,
    section,
    batched(30, 50, 0.1),
    batched(30, 50),
    {},
    {},
    {},
  )!;
  expect(sf.points[0].isMean).toBe(true);
  // skip the leading mean point; the percentile estimates should ramp upward.
  const ests = sf.points.slice(1).map(p => p.runs[0].bootstrapCI.estimate);
  const monotonic = ests.every((v, i) => i === 0 || v >= ests[i - 1]);
  expect(monotonic).toBe(true);
});

test("each point carries current and baseline absolute distributions", () => {
  const sf = buildShiftFunction(
    timeCol,
    section,
    batched(30, 50, 0.1),
    batched(30, 50),
    {},
    {},
    {},
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
    timeCol,
    section,
    batched(30, 5, 0.1),
    batched(30, 5),
    {},
    {},
    {},
  )!;
  expect(sf.points.find(p => p.label === "p1")!.reliable).toBe(false);
  expect(sf.points.find(p => p.label === "p50")!.reliable).toBe(true);
});

test("equivMargin is recorded for the plot band", () => {
  const sf = buildShiftFunction(
    timeCol,
    section,
    batched(30, 50, 0.1),
    batched(30, 50),
    {},
    {},
    { equivMargin: 2 },
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
  const trimmed = buildShiftFunction(timeCol, section, cur, base, {}, {}, {})!;
  const raw = buildShiftFunction(
    timeCol,
    section,
    cur,
    base,
    {},
    {},
    {
      noBatchTrim: true,
    },
  )!;
  const p95Trim = trimmed.points.find(p => p.label === "p95")!;
  const p95Raw = raw.points.find(p => p.label === "p95")!;
  expect(p95Trim.tailCount).toBeLessThan(p95Raw.tailCount);
});
