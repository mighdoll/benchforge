import { expect, test } from "vitest";
import { withHeapSampling } from "../heap-sample/HeapSampler.ts";
import {
  aggregateSites,
  filterSites,
  flattenProfile,
  isNodeUserCode,
  type HeapSite,
} from "../heap-sample/HeapSampleReport.ts";

// --- Allocation-heavy functions using regex on dynamic strings ---

function allocateViaRegex(): string[] {
  const results: string[] = [];
  for (let i = 0; i < 100; i++) {
    const big = "x".repeat(10_000) + String(i);
    results.push(big.replace(/x{100}/g, "y".repeat(100)));
  }
  return results;
}

function allocateViaConcat(): string[] {
  const results: string[] = [];
  for (let i = 0; i < 100; i++) {
    let s = "";
    for (let j = 0; j < 100; j++) s += "abcdefghij";
    results.push(s);
  }
  return results;
}

test("heap attribution is stable across runs", async () => {
  const runs = 3;
  const regexBytes: number[] = [];
  const concatBytes: number[] = [];

  for (let r = 0; r < runs; r++) {
    const { profile } = await withHeapSampling({ samplingInterval: 1 }, () => {
      allocateViaRegex();
      allocateViaConcat();
    });

    const sites = flattenProfile(profile);
    const userSites = filterSites(sites, isNodeUserCode);
    const aggregated = aggregateSites(userSites);

    const regexSite = aggregated.find(s => s.fn === "allocateViaRegex");
    const concatSite = aggregated.find(s => s.fn === "allocateViaConcat");

    regexBytes.push(regexSite?.bytes ?? 0);
    concatBytes.push(concatSite?.bytes ?? 0);
  }

  // Both functions should be attributed bytes in every run
  for (const b of regexBytes) expect(b).toBeGreaterThan(0);
  for (const b of concatBytes) expect(b).toBeGreaterThan(0);

  // Attribution should be relatively stable (CV < 0.5)
  expect(cv(regexBytes)).toBeLessThan(0.5);
  expect(cv(concatBytes)).toBeLessThan(0.5);
}, 30_000);

test("raw samples have nodeId, size, and ordinal fields", async () => {
  const { profile } = await withHeapSampling({ samplingInterval: 1 }, () => {
    const arr: string[] = [];
    for (let i = 0; i < 1000; i++) arr.push("x".repeat(1000));
    return arr;
  });

  expect(profile.samples).toBeDefined();
  expect(profile.samples!.length).toBeGreaterThan(0);

  const sample = profile.samples![0];
  expect(typeof sample.nodeId).toBe("number");
  expect(typeof sample.size).toBe("number");
  expect(typeof sample.ordinal).toBe("number");
});

test("profile nodes have id field", async () => {
  const { profile } = await withHeapSampling({ samplingInterval: 256 }, () => {
    const arr: object[] = [];
    for (let i = 0; i < 100; i++) arr.push({ data: new Array(100) });
    return arr;
  });

  expect(typeof profile.head.id).toBe("number");
});

test("flattenProfile attaches raw samples to sites", async () => {
  const { profile } = await withHeapSampling({ samplingInterval: 1 }, () => {
    allocateViaRegex();
  });

  const sites = flattenProfile(profile);
  const sitesWithSamples = sites.filter(s => s.samples && s.samples.length > 0);
  expect(sitesWithSamples.length).toBeGreaterThan(0);

  // Each attached sample should have valid fields
  for (const site of sitesWithSamples) {
    for (const sample of site.samples!) {
      expect(sample.size).toBeGreaterThan(0);
      expect(typeof sample.ordinal).toBe("number");
    }
  }
});

test("unknown column does not merge distinct functions on same line", () => {
  const sites: HeapSite[] = [
    { fn: "Foo", url: "test.ts", line: 10, col: -1, bytes: 100 },
    { fn: "Bar", url: "test.ts", line: 10, col: -1, bytes: 200 },
  ];
  const aggregated = aggregateSites(sites);
  expect(aggregated).toHaveLength(2);
});

test("same column merges regardless of function name", () => {
  const sites: HeapSite[] = [
    { fn: "Foo", url: "test.ts", line: 10, col: 5, bytes: 100 },
    { fn: "Foo", url: "test.ts", line: 10, col: 5, bytes: 200 },
  ];
  const aggregated = aggregateSites(sites);
  expect(aggregated).toHaveLength(1);
  expect(aggregated[0].bytes).toBe(300);
});

test("aggregation preserves distinct caller stacks", () => {
  const stackA = [
    { fn: "root", url: "a.ts", line: 1, col: 0 },
    { fn: "foo", url: "a.ts", line: 10, col: 0 },
    { fn: "alloc", url: "a.ts", line: 20, col: 5 },
  ];
  const stackB = [
    { fn: "root", url: "a.ts", line: 1, col: 0 },
    { fn: "bar", url: "a.ts", line: 15, col: 0 },
    { fn: "alloc", url: "a.ts", line: 20, col: 5 },
  ];
  const sites: HeapSite[] = [
    { fn: "alloc", url: "a.ts", line: 20, col: 5, bytes: 800, stack: stackA },
    { fn: "alloc", url: "a.ts", line: 20, col: 5, bytes: 200, stack: stackB },
  ];
  const aggregated = aggregateSites(sites);

  expect(aggregated).toHaveLength(1);
  expect(aggregated[0].bytes).toBe(1000);
  expect(aggregated[0].callers).toHaveLength(2);
  // Primary stack should be the highest-bytes path (foo)
  expect(aggregated[0].stack![1].fn).toBe("foo");
  // Callers sorted by bytes descending
  expect(aggregated[0].callers![0].bytes).toBe(800);
  expect(aggregated[0].callers![1].bytes).toBe(200);
});

test("named function attribution is consistent across runs", async () => {
  // With interval=1 + includeCollected flags, V8's profiler is deterministic
  // under --jitless (verified in Node + browser, see heap-jitless-fixture.mjs).
  // With JIT, optimization can change site count between runs, but named
  // target functions should still get attributed bytes consistently.
  const regexByRun: number[] = [];
  const concatByRun: number[] = [];

  for (let run = 0; run < 3; run++) {
    const { profile } = await withHeapSampling({ samplingInterval: 1 }, () => {
      allocateViaRegex();
      allocateViaConcat();
    });
    const sites = flattenProfile(profile);
    const userSites = filterSites(sites, isNodeUserCode);
    const agg = aggregateSites(userSites);

    const regex = agg.find(s => s.fn === "allocateViaRegex");
    const concat = agg.find(s => s.fn === "allocateViaConcat");
    regexByRun.push(regex?.bytes ?? 0);
    concatByRun.push(concat?.bytes ?? 0);
  }

  // Both should be attributed in every run
  for (const b of regexByRun) expect(b).toBeGreaterThan(0);
  for (const b of concatByRun) expect(b).toBeGreaterThan(0);
  // And reasonably stable (CV < 1.0 — JIT adds variance vs --jitless)
  expect(cv(regexByRun)).toBeLessThan(1.0);
  expect(cv(concatByRun)).toBeLessThan(1.0);
}, 30_000);

// --- Helpers ---

function cv(arr: number[]): number {
  const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
  const variance =
    arr.reduce((sum, v) => sum + (v - mean) ** 2, 0) / arr.length;
  return Math.sqrt(variance) / mean;
}
