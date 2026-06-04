import { expect, test } from "vitest";
import { gcByBatch } from "../report/GcByBatch.ts";
import type { GcEvent } from "../runners/GcStats.ts";
import type { MeasuredResults } from "../runners/MeasuredResults.ts";

/** Build a MeasuredResults with uniform 1ms samples so offset==sampleIndex+1. */
function results(
  sampleCount: number,
  batchOffsets: number[],
  gcEvents: GcEvent[],
): MeasuredResults {
  const samples = new Array<number>(sampleCount).fill(1);
  return {
    name: "t",
    samples,
    batchOffsets,
    gcEvents,
    time: { min: 1, max: 1, avg: 1, p50: 1, p75: 1, p99: 1, p999: 1 },
  };
}

function full(offset: number, pauseMs: number, collected: number): GcEvent {
  return { type: "mark-compact", offset, pauseMs, collected };
}

test("gcByBatch returns undefined without per-event GC data", () => {
  expect(gcByBatch(results(10, [0], []))).toBeUndefined();
});

test("gcByBatch returns undefined without batch offsets", () => {
  const r = results(10, [], [full(2, 1, 100)]);
  r.batchOffsets = undefined;
  expect(gcByBatch(r)).toBeUndefined();
});

test("gcByBatch buckets full GCs into the batches their offsets fall in", () => {
  // 100 samples, 2 batches at [0,50). offsets 10 and 20 -> batch 0; 60 -> batch 1
  const r = results(
    100,
    [0, 50],
    [full(10, 1, 100), full(20, 1, 100), full(60, 2, 200)],
  );
  const s = gcByBatch(r)!;
  expect(s.batches).toBe(2);
  expect(s.fullGCs).toBe(3);
  expect(s.fullPerBatch.min).toBe(1); // batch 1 has 1
  expect(s.fullPerBatch.max).toBe(2); // batch 0 has 2
  expect(s.fullPerBatch.mean).toBeCloseTo(1.5, 5);
});

test("gcByBatch pools pause and bytes spread across full GCs", () => {
  const r = results(100, [0, 50], [full(10, 1, 100), full(60, 3, 300)]);
  const s = gcByBatch(r)!;
  expect(s.fullPause.min).toBe(1);
  expect(s.fullPause.max).toBe(3);
  expect(s.fullPause.mean).toBe(2);
  expect(s.fullCollected.min).toBe(100);
  expect(s.fullCollected.max).toBe(300);
});

test("gcByBatch separates scavenges from full GCs", () => {
  const events: GcEvent[] = [
    full(10, 1, 100),
    { type: "scavenge", offset: 12, pauseMs: 0.1, collected: 5 },
    { type: "scavenge", offset: 14, pauseMs: 0.1, collected: 5 },
  ];
  const s = gcByBatch(results(100, [0, 50], events))!;
  expect(s.fullGCs).toBe(1);
  expect(s.scavenges).toBe(2);
});

test("gcByBatch ignores pre-loop (negative offset) events", () => {
  const r = results(100, [0, 50], [full(-3, 1, 100), full(60, 2, 200)]);
  const s = gcByBatch(r)!;
  expect(s.fullGCs).toBe(1); // only the in-loop one
});

test("cacheProbe measures post-GC iterations against the loop mean", () => {
  // 100 samples all 1ms except 5 slow (10ms) iterations right after a full GC.
  const samples = new Array<number>(100).fill(1);
  const gcSampleIndex = 30; // offset 31 maps to sample 31 (>= cumulative)
  for (let i = gcSampleIndex + 1; i <= gcSampleIndex + 5; i++) samples[i] = 10;
  const r: MeasuredResults = {
    name: "t",
    samples,
    batchOffsets: [0],
    gcEvents: [full(31, 1, 100)],
    time: { min: 1, max: 10, avg: 1, p50: 1, p75: 1, p99: 1, p999: 1 },
  };
  const probe = gcByBatch(r)!.cacheProbe!;
  expect(probe.events).toBe(1);
  // post-GC window includes the 5 slow iters, so its mean exceeds the loop mean
  expect(probe.penaltyRatio).toBeGreaterThan(0);
  expect(probe.postGcMean).toBeGreaterThan(probe.overallMean);
});
