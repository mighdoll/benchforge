import { expect, test } from "vitest";
import type { ReportColumn } from "../report/BenchmarkReport.ts";
import { buildShiftFunction } from "../report/ShiftFunction.ts";
import type { MeasuredResults } from "../runners/MeasuredResults.ts";

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
    batched(30, 50),
    undefined,
    {},
    {},
    {},
  );
  expect(sf).toBeUndefined();
});

test("produces one point per sampled percentile", () => {
  const sf = buildShiftFunction(
    timeCol,
    batched(30, 50, 0.1),
    batched(30, 50),
    {},
    {},
    {},
  );
  expect(sf).toBeDefined();
  expect(sf!.points.length).toBe(9);
  expect(sf!.metric).toBe("p50");
});

test("points are sorted ascending by displayed percentile", () => {
  const sf = buildShiftFunction(
    timeCol,
    batched(30, 50, 0.1),
    batched(30, 50),
    {},
    {},
    {},
  )!;
  const ps = sf.points.map(p => p.percentile);
  expect(ps).toEqual([...ps].sort((a, b) => a - b));
});

test("higherIsBetter keeps absolute estimates monotonic across percentiles", () => {
  // loc/sec displayed-low percentile is the slow-time tail; mapping inverts so
  // absolute throughput should still increase with displayed percentile.
  const sf = buildShiftFunction(
    locCol,
    batched(30, 50, 0.1),
    batched(30, 50),
    {},
    {},
    {},
  )!;
  const ests = sf.points.map(p => p.runs[0].bootstrapCI.estimate);
  const monotonic = ests.every((v, i) => i === 0 || v >= ests[i - 1]);
  expect(monotonic).toBe(true);
});

test("each point carries current and baseline absolute distributions", () => {
  const sf = buildShiftFunction(
    timeCol,
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
    batched(30, 50, 0.1),
    batched(30, 50),
    {},
    {},
    { equivMargin: 2 },
  )!;
  expect(sf.equivMargin).toBe(2);
});
