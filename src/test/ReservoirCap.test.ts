import { expect, test } from "vitest";
import { BenchRunner, createReservoir } from "../runners/BenchRunner.ts";
import { mean } from "../stats/CoreStats.ts";

test("reservoir keeps everything under the cap, in order", () => {
  const r = createReservoir(100);
  for (let i = 0; i < 40; i++) r.offer(i, i * 10);
  const { samples, heapSamples, count, capped } = r.finish();
  expect(capped).toBe(false);
  expect(count).toBe(40);
  expect(samples).toHaveLength(40);
  expect(samples).toEqual(Array.from({ length: 40 }, (_, i) => i));
  expect(heapSamples).toEqual(samples.map(s => s * 10));
});

test("reservoir trims pre-allocated holes when under cap", () => {
  const r = createReservoir(100, 100); // pre-sized to 100, only 30 offered
  for (let i = 0; i < 30; i++) r.offer(i, i);
  const { samples } = r.finish();
  expect(samples).toHaveLength(30);
  expect(samples.every(v => v !== undefined)).toBe(true);
});

test("reservoir caps retained samples but reports the true count", () => {
  const r = createReservoir(1000);
  for (let i = 0; i < 50_000; i++) r.offer(i, i * 10);
  const { samples, heapSamples, count, capped } = r.finish();
  expect(capped).toBe(true);
  expect(count).toBe(50_000);
  expect(samples).toHaveLength(1000);
  expect(heapSamples).toHaveLength(1000);
});

test("capped reservoir preserves time order and (sample, heap) pairing", () => {
  const r = createReservoir(1000);
  for (let i = 0; i < 50_000; i++) r.offer(i, i * 10);
  const { samples, heapSamples } = r.finish();
  // values equal their arrival index, so a time-ordered subset is increasing
  for (let i = 1; i < samples.length; i++)
    expect(samples[i]).toBeGreaterThan(samples[i - 1]);
  expect(samples.every(v => v >= 0 && v < 50_000)).toBe(true);
  expect(heapSamples).toEqual(samples.map(s => s * 10));
});

test("capped reservoir is an unbiased subsample of the stream", () => {
  const n = 100_000;
  const r = createReservoir(10_000);
  for (let i = 0; i < n; i++) r.offer(i, 0);
  const { samples } = r.finish();
  const streamMean = (n - 1) / 2;
  expect(Math.abs(mean(samples) - streamMean)).toBeLessThan(streamMean * 0.05);
});

test("runBench caps samples yet keeps iterations as the true count", async () => {
  const noop = { name: "noop", fn: () => {} };
  const results = await new BenchRunner().runBench(noop, {
    maxIterations: 900,
    maxSamples: 100,
    warmup: 0,
  });
  const [r] = results;
  expect(r.iterations).toBe(900);
  expect(r.samples).toHaveLength(100);
  expect(r.heapSamples).toHaveLength(100);
});

test("maxSamples: 0 disables the cap", async () => {
  const noop = { name: "noop", fn: () => {} };
  const results = await new BenchRunner().runBench(noop, {
    maxIterations: 500,
    maxSamples: 0,
    warmup: 0,
  });
  const [r] = results;
  expect(r.iterations).toBe(500);
  expect(r.samples).toHaveLength(500);
});
