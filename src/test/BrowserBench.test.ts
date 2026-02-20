import { expect, test } from "vitest";
import {
  browserGcStats,
  parseGcTraceEvents,
  type TraceEvent,
} from "../browser/BrowserGcStats.ts";

test("parseGcTraceEvents parses MinorGC and MajorGC events", () => {
  const events: TraceEvent[] = [
    {
      cat: "v8.gc",
      name: "MinorGC",
      ph: "X",
      dur: 500,
      args: { usedHeapSizeBefore: 10000, usedHeapSizeAfter: 8000 },
    },
    {
      cat: "v8.gc",
      name: "MajorGC",
      ph: "X",
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
    { cat: "v8.gc", name: "MinorGC", ph: "B", dur: 500 }, // not complete
    { cat: "v8", name: "V8.Execute", ph: "X", dur: 100 }, // not GC
    { cat: "v8.gc", name: "MinorGC", ph: "X" }, // valid, missing dur/args
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
      dur: 300,
      args: { usedHeapSizeBefore: 5000, usedHeapSizeAfter: 3000 },
    },
    {
      cat: "v8.gc",
      name: "MinorGC",
      ph: "X",
      dur: 200,
      args: { usedHeapSizeBefore: 6000, usedHeapSizeAfter: 4000 },
    },
    {
      cat: "v8.gc",
      name: "MajorGC",
      ph: "X",
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
