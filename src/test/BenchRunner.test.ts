import { expect, test } from "vitest";
import { BenchRunner } from "../runners/BenchRunner.ts";

test("profiler boundary brackets the measured loop, excluding warmup", async () => {
  let calls = 0;
  const spec = {
    name: "b",
    fn: () => {
      calls++;
    },
  };
  let atStart = -1;
  let atStop = -1;
  const boundary = {
    start: async () => {
      atStart = calls;
    },
    stop: async () => {
      atStop = calls;
    },
  };

  const options = { warmup: 5, maxIterations: 20, maxTime: 0 };
  const [result] = await new BenchRunner().runBench(
    spec,
    options,
    undefined,
    boundary,
  );

  // start fires after the 5 warmup calls, before any measured iteration
  expect(atStart).toBe(5);
  // stop fires after the 20 measured iterations (25 total)
  expect(atStop).toBe(25);
  expect(result.warmupSamples?.length).toBe(5);
  expect(result.samples.length).toBe(20);
});

test("runBench without a boundary still runs (no profiling)", async () => {
  let calls = 0;
  const spec = {
    name: "b",
    fn: () => {
      calls++;
    },
  };
  const [result] = await new BenchRunner().runBench(spec, {
    warmup: 2,
    maxIterations: 10,
    maxTime: 0,
  });
  expect(calls).toBe(12);
  expect(result.samples.length).toBe(10);
});
