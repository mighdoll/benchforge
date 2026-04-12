import { expect, test } from "vitest";
import type { BenchmarkSpec } from "../runners/BenchmarkSpec.ts";
import { runBenchmark } from "../runners/RunnerOrchestrator.ts";

/** lightweight function for testing worker communication */
function simpleTestFunction(): number {
  let sum = 0;
  for (let i = 0; i < 1000; i++) sum += Math.sqrt(i);
  return sum;
}

test("TimingRunner runs benchmark in worker mode", async () => {
  const spec: BenchmarkSpec = {
    name: "timing-worker-test",
    fn: simpleTestFunction,
  };

  const results = await runBenchmark({
    spec,
    runner: "timing",
    options: {
      maxTime: 5,
      maxIterations: 50,
    },
    useWorker: true,
  });

  expect(results).toHaveLength(1);
  const result = results[0];

  expect(result.name).toBe("timing-worker-test");
  expect(result.samples.length).toBeGreaterThan(0);
  expect(result.samples.length).toBeLessThanOrEqual(500);
  expect(result.time.min).toBeGreaterThan(0);
  expect(result.time.max).toBeGreaterThanOrEqual(result.time.min);
  expect(result.time.avg).toBeGreaterThan(0);
  expect(result.time.p50).toBeGreaterThan(0);
  expect(result.time.p99).toBeGreaterThan(0);
});

test("TimingRunner runs benchmark in non-worker mode", async () => {
  const spec: BenchmarkSpec = {
    name: "timing-test",
    fn: simpleTestFunction,
  };

  const results = await runBenchmark({
    spec,
    runner: "timing",
    options: {
      maxTime: 5,
      maxIterations: 50,
    },
    useWorker: false,
  });

  expect(results).toHaveLength(1);
  const result = results[0];

  expect(result.name).toBe("timing-test");
  expect(result.samples.length).toBeGreaterThan(0);
  expect(result.time.p50).toBeGreaterThan(0);
});

test("TimingRunner with parameterized benchmark", async () => {
  const spec: BenchmarkSpec<number> = {
    name: "parameterized-test",
    fn: (n: number) => {
      let sum = 0;
      for (let i = 0; i < n; i++) sum += i;
      return sum;
    },
  };

  const results = await runBenchmark({
    spec,
    runner: "timing",
    options: { maxTime: 5, maxIterations: 20 },
    useWorker: false,
    params: 100,
  });

  expect(results).toHaveLength(1);
  expect(results[0].name).toBe("parameterized-test");
});

test("RunnerOrchestrator propagates errors from worker", async () => {
  const spec: BenchmarkSpec = {
    name: "error-test",
    fn: () => {
      throw new Error("Test error from benchmark");
    },
  };

  const promise = runBenchmark({
    spec,
    runner: "timing",
    options: { maxTime: 1, maxIterations: 1 },
    useWorker: true,
  });
  await expect(promise).rejects.toThrow("Test error from benchmark");
});
