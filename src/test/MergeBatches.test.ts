import { expect, test } from "vitest";
import type { GcEvent } from "../runners/GcStats.ts";
import type { MeasuredResults } from "../runners/MeasuredResults.ts";
import { mergeBatchResults } from "../runners/MergeBatches.ts";

/** Build a batch of uniform 1ms samples so cumulative time == sample count. */
function batch(sampleCount: number, gcEvents?: GcEvent[]): MeasuredResults {
  return {
    name: "t",
    samples: new Array<number>(sampleCount).fill(1),
    gcEvents,
    time: { min: 1, max: 1, avg: 1, p50: 1, p75: 1, p99: 1, p999: 1 },
  };
}

/** A full (mark-compact) GC event `offset` ms into its own batch. */
function full(offset: number): GcEvent {
  return { type: "mark-compact", offset, pauseMs: 1, collected: 100 };
}

test("merged GC event offsets accumulate prior batches' sample time", () => {
  const merged = mergeBatchResults([
    batch(10, [full(4)]),
    batch(10, [full(5)]),
  ]);
  expect(merged.gcEvents?.map(e => e.offset)).toEqual([4, 15]);
});

test("late in-loop GC events clamp to their batch's sample time", () => {
  // offset 13 exceeds batch 0's 10ms of samples (loop bookkeeping overhead);
  // unclamped it would map into batch 1's samples on the merged timeline.
  const merged = mergeBatchResults([
    batch(10, [full(13)]),
    batch(10, [full(5)]),
  ]);
  expect(merged.gcEvents?.map(e => e.offset)).toEqual([10, 15]);
});
