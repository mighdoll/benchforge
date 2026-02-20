import { expect, test } from "vitest";
import { aggregateGcStats, parseGcLine } from "../runners/GcStats.ts";

test("parseGcLine parses scavenge event from real V8 output", () => {
  // Real V8 --trace-gc-nvp format
  const line =
    "[71753:0x83280c000:0] 9 ms: pause=0.5 mutator=0.1 gc=s allocated=293224 promoted=653480 new_space_survived=290176 start_object_size=4392688 end_object_size=4287840";
  const event = parseGcLine(line);
  expect(event).toMatchObject({
    type: "scavenge",
    pauseMs: 0.5,
    allocated: 293224,
    promoted: 653480,
    survived: 290176,
    collected: 4392688 - 4287840,
  });
});

test("parseGcLine parses mark-sweep event", () => {
  const line =
    "[1234:0x12345:0] 100 ms: pause=12.3 gc=ms allocated=2097152 promoted=0 new_space_survived=0 start_object_size=5000000 end_object_size=3000000";
  const event = parseGcLine(line);
  expect(event).toMatchObject({
    type: "mark-compact",
    pauseMs: 12.3,
    allocated: 2097152,
    collected: 2000000,
  });
});

test("parseGcLine returns undefined for non-GC lines", () => {
  expect(parseGcLine("some random stderr output")).toBeUndefined();
  expect(parseGcLine("")).toBeUndefined();
  expect(parseGcLine("   ")).toBeUndefined();
});

test("parseGcLine handles missing fields", () => {
  const line = "gc=s pause=1.0";
  const event = parseGcLine(line);
  expect(event).toMatchObject({
    type: "scavenge",
    pauseMs: 1.0,
    allocated: 0,
    collected: 0,
    promoted: 0,
    survived: 0,
  });
});

test("aggregateGcStats aggregates multiple events", () => {
  const scav = "scavenge" as const;
  const mc = "mark-compact" as const;
  const events = [
    {
      type: scav,
      pauseMs: 0.5,
      allocated: 1000,
      collected: 500,
      promoted: 100,
      survived: 400,
    },
    {
      type: scav,
      pauseMs: 0.3,
      allocated: 2000,
      collected: 800,
      promoted: 200,
      survived: 1000,
    },
    {
      type: mc,
      pauseMs: 10.0,
      allocated: 0,
      collected: 5000,
      promoted: 0,
      survived: 0,
    },
  ];
  const stats = aggregateGcStats(events);
  expect(stats.scavenges).toBe(2);
  expect(stats.markCompacts).toBe(1);
  expect(stats.totalAllocated).toBe(3000);
  expect(stats.totalCollected).toBe(6300);
  expect(stats.totalPromoted).toBe(300);
  expect(stats.totalSurvived).toBe(1400);
  expect(stats.gcPauseTime).toBeCloseTo(10.8, 2);
});

test("aggregateGcStats handles empty events", () => {
  const stats = aggregateGcStats([]);
  expect(stats.scavenges).toBe(0);
  expect(stats.markCompacts).toBe(0);
  expect(stats.gcPauseTime).toBe(0);
});
