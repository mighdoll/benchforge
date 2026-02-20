import path from "node:path";
import { expect, test } from "vitest";
import { profileBrowser } from "../browser/BrowserHeapSampler.ts";

const examplesDir = path.resolve(import.meta.dirname!, "../../examples");

test("bench function mode (window.__bench)", { timeout: 30000 }, async () => {
  const url = `file://${examplesDir}/browser-bench/index.html`;
  const result = await profileBrowser({ url, maxTime: 500, gcStats: true });

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

test("lap mode with N laps", { timeout: 30000 }, async () => {
  const url = `file://${examplesDir}/browser-lap/index.html`;
  const result = await profileBrowser({ url, gcStats: true });

  expect(result.samples).toBeDefined();
  expect(result.samples!).toHaveLength(100);
  expect(result.wallTimeMs).toBeGreaterThan(0);
  expect(result.gcStats).toBeDefined();
  for (const s of result.samples!) {
    expect(s).toBeGreaterThanOrEqual(0);
  }
});

test("lap mode 0 laps with heap profiling", { timeout: 30000 }, async () => {
  const url = `file://${examplesDir}/browser-heap/index.html`;
  const result = await profileBrowser({ url, heapSample: true });

  expect(result.samples).toBeDefined();
  expect(result.samples!).toHaveLength(0);
  expect(result.wallTimeMs).toBeGreaterThan(0);
  expect(result.heapProfile).toBeDefined();
  expect(result.heapProfile!.head).toBeDefined();
});
