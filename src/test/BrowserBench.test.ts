import { expect, test } from "vitest";
import {
  browserGcEvents,
  browserGcStats,
  loopStartMark,
  parseGcTraceEvents,
} from "../profiling/browser/BrowserGcStats.ts";
import type { TraceEvent } from "../profiling/browser/ChromeTraceEvent.ts";

/** A MinorGC complete event (ts/dur in microseconds). */
function minorGc(ts: number): TraceEvent {
  return {
    cat: "v8.gc",
    name: "MinorGC",
    ph: "X",
    ts,
    dur: 500,
    args: { usedHeapSizeBefore: 10000, usedHeapSizeAfter: 8000 },
  };
}

/** A MajorGC complete event (ts/dur in microseconds). */
function majorGc(ts: number): TraceEvent {
  return {
    cat: "v8.gc",
    name: "MajorGC",
    ph: "X",
    ts,
    dur: 12000,
    args: { usedHeapSizeBefore: 50000, usedHeapSizeAfter: 30000 },
  };
}

/** The loop-start user-timing mark at trace timestamp `ts` (microseconds). */
function loopMark(ts: number): TraceEvent {
  return { cat: "blink.user_timing", name: loopStartMark, ph: "R", ts };
}

test("parseGcTraceEvents parses MinorGC and MajorGC events", () => {
  const events: TraceEvent[] = [
    {
      cat: "v8.gc",
      name: "MinorGC",
      ph: "X",
      ts: 0,
      dur: 500,
      args: { usedHeapSizeBefore: 10000, usedHeapSizeAfter: 8000 },
    },
    {
      cat: "v8.gc",
      name: "MajorGC",
      ph: "X",
      ts: 0,
      dur: 12000,
      args: { usedHeapSizeBefore: 50000, usedHeapSizeAfter: 30000 },
    },
  ];
  const parsed = parseGcTraceEvents(events);
  expect(parsed).toHaveLength(2);
  expect(parsed[0]).toEqual({
    type: "scavenge",
    pauseMs: 0.5,
    collected: 2000,
  });
  expect(parsed[1]).toEqual({
    type: "mark-compact",
    pauseMs: 12,
    collected: 20000,
  });
});

test("parseGcTraceEvents ignores non-complete and non-GC events", () => {
  const events: TraceEvent[] = [
    { cat: "v8.gc", name: "MinorGC", ph: "B", ts: 0, dur: 500 }, // not complete
    { cat: "v8", name: "V8.Execute", ph: "X", ts: 0, dur: 100 }, // not GC
    { cat: "v8.gc", name: "MinorGC", ph: "X", ts: 0 }, // valid, missing dur/args
  ];
  const parsed = parseGcTraceEvents(events);
  expect(parsed).toHaveLength(1);
  expect(parsed[0]).toEqual({ type: "scavenge", pauseMs: 0, collected: 0 });
});

test("browserGcStats aggregates trace events into GcStats", () => {
  const events: TraceEvent[] = [
    {
      cat: "v8.gc",
      name: "MinorGC",
      ph: "X",
      ts: 0,
      dur: 300,
      args: { usedHeapSizeBefore: 5000, usedHeapSizeAfter: 3000 },
    },
    {
      cat: "v8.gc",
      name: "MinorGC",
      ph: "X",
      ts: 0,
      dur: 200,
      args: { usedHeapSizeBefore: 6000, usedHeapSizeAfter: 4000 },
    },
    {
      cat: "v8.gc",
      name: "MajorGC",
      ph: "X",
      ts: 0,
      dur: 8000,
      args: { usedHeapSizeBefore: 40000, usedHeapSizeAfter: 20000 },
    },
  ];
  const stats = browserGcStats(events);
  expect(stats.scavenges).toBe(2);
  expect(stats.markCompacts).toBe(1);
  expect(stats.totalCollected).toBe(24000);
  expect(stats.gcPauseTime).toBeCloseTo(8.5, 2);
});

test("browserGcEvents is empty without a loop-start mark", () => {
  expect(browserGcEvents([minorGc(0), majorGc(1000)])).toEqual([]);
});

test("browserGcEvents rebases offsets to loop time and drops pre-loop GCs", () => {
  // mark at 1ms; MinorGC at 0.5ms (pre-loop, dropped), MajorGC at 3ms (offset 2ms)
  const events = [minorGc(500), loopMark(1000), majorGc(3000)];
  const parsed = browserGcEvents(events);
  expect(parsed).toHaveLength(1);
  expect(parsed[0]).toMatchObject({ type: "mark-compact", offset: 2 });
});

test("browserGcStats counts only in-loop GCs when a loop mark is present", () => {
  const events = [minorGc(500), loopMark(1000), majorGc(3000)];
  const stats = browserGcStats(events);
  expect(stats.scavenges).toBe(0);
  expect(stats.markCompacts).toBe(1);
});
