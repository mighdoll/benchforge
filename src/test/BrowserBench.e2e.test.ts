import path from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { profileBrowser } from "../profiling/browser/BrowserProfiler.ts";
import type { ChromeInstance } from "../profiling/browser/ChromeLauncher.ts";
import { launchChrome } from "../profiling/browser/ChromeLauncher.ts";
import { runBatched } from "../runners/MergeBatches.ts";
import { computeStats } from "../runners/SampleStats.ts";

const examplesDir = path.resolve(import.meta.dirname!, "../../examples");

let chrome: ChromeInstance;

test("bench function mode (window.__bench)", { timeout: 30000 }, async () => {
  const url = `file://${examplesDir}/browser-bench/index.html`;
  const result = await profileBrowser({
    url,
    maxTime: 500,
    gcStats: true,
    headless: true,
    chrome,
  });

  expect(result.samples).toBeDefined();
  expect(result.samples!.length).toBeGreaterThan(5);
  expect(result.wallTimeMs).toBeGreaterThan(0);
  expect(result.gcStats).toBeDefined();
  expect(result.gcStats!.scavenges).toBeGreaterThanOrEqual(0);
  for (const s of result.samples!) {
    expect(s).toBeGreaterThan(0);
    expect(s).toBeLessThan(1000);
  }
});

test("bench function with heap profiling", { timeout: 30000 }, async () => {
  const url = `file://${examplesDir}/browser-heap/index.html`;
  const result = await profileBrowser({
    url,
    maxTime: 500,
    alloc: true,
    headless: true,
    chrome,
  });

  expect(result.samples).toBeDefined();
  expect(result.samples!.length).toBeGreaterThan(5);
  expect(result.wallTimeMs).toBeGreaterThan(0);
  expect(result.heapProfile).toBeDefined();
  expect(result.heapProfile!.head).toBeDefined();
});

test("bench function mode with call counts", { timeout: 30000 }, async () => {
  const url = `file://${examplesDir}/browser-bench/index.html`;
  const result = await profileBrowser({
    url,
    maxTime: 500,
    callCounts: true,
    headless: true,
    chrome,
  });

  expect(result.coverage).toBeDefined();
  expect(result.coverage!.scripts.length).toBeGreaterThan(0);

  // Find the benchmark page script
  const pageScript = result.coverage!.scripts.find(s =>
    s.url.includes("browser-bench"),
  );
  expect(pageScript).toBeDefined();

  // The example defines buildArray, sortArray, mapToObjects, filterAndReduce
  const fnNames = pageScript!.functions.map(f => f.functionName);
  expect(fnNames).toContain("buildArray");
  expect(fnNames).toContain("sortArray");

  // buildArray is called once per __bench iteration; count should match
  const buildArray = pageScript!.functions.find(
    f => f.functionName === "buildArray",
  );
  expect(buildArray!.ranges[0].count).toBe(result.samples!.length);
});

test("page-load mode with navTiming", { timeout: 30000 }, async () => {
  const url = `file://${examplesDir}/browser-page-load/index.html`;
  const result = await profileBrowser({
    url,
    pageLoad: true,
    alloc: true,
    headless: true,
    chrome,
  });

  expect(result.navTiming).toBeDefined();
  expect(result.navTiming!.domContentLoaded).toBeGreaterThan(0);
  expect(result.navTiming!.loadEvent).toBeGreaterThan(0);
  expect(result.wallTimeMs).toBe(result.navTiming!.loadEvent);
  expect(result.heapProfile).toBeDefined();
  expect(result.heapProfile!.head).toBeDefined();
  // page-load mode doesn't produce iteration samples
  expect(result.samples).toBeUndefined();
});

test("page-load mode with call counts", { timeout: 30000 }, async () => {
  const url = `file://${examplesDir}/browser-page-load/index.html`;
  const result = await profileBrowser({
    url,
    pageLoad: true,
    callCounts: true,
    headless: true,
    chrome,
  });

  expect(result.navTiming).toBeDefined();
  expect(result.coverage).toBeDefined();
  expect(result.coverage!.scripts.length).toBeGreaterThan(0);

  const pageScript = result.coverage!.scripts.find(s =>
    s.url.includes("browser-page-load"),
  );
  expect(pageScript).toBeDefined();
  const fnNames = pageScript!.functions.map(f => f.functionName);
  expect(fnNames).toContain("buildItems");
  expect(fnNames).toContain("renderItems");
});

test("page-load mode with gc stats", { timeout: 30000 }, async () => {
  const url = `file://${examplesDir}/browser-page-load/index.html`;
  const result = await profileBrowser({
    url,
    pageLoad: true,
    gcStats: true,
    headless: true,
    chrome,
  });

  expect(result.navTiming).toBeDefined();
  expect(result.gcStats).toBeDefined();
  expect(result.gcStats!.scavenges).toBeGreaterThanOrEqual(0);
});

test("multi-page-load batching with auto-detect", {
  timeout: 60000,
}, async () => {
  const url = `file://${examplesDir}/browser-page-load/index.html`;

  // Simulate the probing approach: first call detects page-load, rest use multi-load
  let detectedPageLoad = false;
  const pageLoadIters = 3;

  const runner = async () => {
    if (detectedPageLoad) {
      const raws = [];
      for (let i = 0; i < pageLoadIters; i++)
        raws.push(
          await profileBrowser({ url, headless: true, chrome, pageLoad: true }),
        );
      const samples = raws.map(r => r.wallTimeMs ?? 0);
      return { name: "page-load", samples, time: computeStats(samples) };
    }
    // Probe: first call without pageLoad flag, auto-detects
    const raw = await profileBrowser({ url, headless: true, chrome });
    if (!raw.samples?.length && raw.navTiming) detectedPageLoad = true;
    return {
      name: "page-load",
      samples: [raw.wallTimeMs ?? 0],
      time: computeStats([raw.wallTimeMs ?? 0]),
    };
  };

  const {
    results: [current],
  } = await runBatched([runner], undefined, 3, false);

  // 3 batches: batch 0 (probe, 1 sample, dropped), batch 1 (3 samples), batch 2 (3 samples)
  expect(current.samples.length).toBe(6);
  expect(current.batchOffsets).toEqual([0, 3]);
  for (const s of current.samples) expect(s).toBeGreaterThan(0);
});

test("batched fresh tabs with baseline-url", { timeout: 60000 }, async () => {
  const benchUrl = `file://${examplesDir}/browser-bench/index.html`;
  const baselineUrl = `file://${examplesDir}/browser-bench/index.html`;
  const params = { maxTime: 200, headless: true, chrome };

  const toMeasured = (name: string) => async () => {
    const raw = await profileBrowser({ ...params, url: name });
    const samples = raw.samples?.length ? raw.samples : [raw.wallTimeMs ?? 0];
    return { name, samples, time: computeStats(samples) };
  };

  const {
    results: [current],
    baseline,
  } = await runBatched(
    [toMeasured(benchUrl)],
    toMeasured(baselineUrl),
    2,
    false,
  );

  // warmup batch dropped: 2 batches - 1 warmup = 1 batch each
  expect(current.samples.length).toBeGreaterThan(0);
  expect(current.batchOffsets).toEqual([0]); // single batch after warmup drop
  expect(baseline).toBeDefined();
  expect(baseline!.samples.length).toBeGreaterThan(0);
});

beforeAll(async () => {
  chrome = await launchChrome({ headless: true });
}, 30_000);

afterAll(async () => {
  await chrome?.close();
});
