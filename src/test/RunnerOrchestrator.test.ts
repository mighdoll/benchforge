import { expect, test } from "vitest";
import type { BenchmarkSpec } from "../runners/BenchmarkSpec.ts";
import { runBenchmark } from "../runners/RunnerOrchestrator.ts";

/** lightweight function for testing worker communication */
function simpleTestFunction(): number {
  let sum = 0;
  for (let i = 0; i < 1000; i++) sum += Math.sqrt(i);
  return sum;
}

test("BenchRunner runs benchmark in worker mode", async () => {
  const spec: BenchmarkSpec = {
    name: "timing-worker-test",
    fn: simpleTestFunction,
  };

  const results = await runBenchmark({
    spec,
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

test("BenchRunner runs benchmark in non-worker mode", async () => {
  const spec: BenchmarkSpec = {
    name: "timing-test",
    fn: simpleTestFunction,
  };

  const results = await runBenchmark({
    spec,
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

test("BenchRunner with parameterized benchmark", async () => {
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
    options: { maxTime: 5, maxIterations: 20 },
    useWorker: false,
    params: 100,
  });

  expect(results).toHaveLength(1);
  expect(results[0].name).toBe("parameterized-test");
});

test("gcForce calls gc() once per measured iteration", async () => {
  // gcFunction() resolves globalThis.gc ?? __gc; install a counting stub there.
  const g = globalThis as { gc?: () => void };
  const saved = g.gc;
  let gcCalls = 0;
  g.gc = () => {
    gcCalls++;
  };
  const run = (gcForce: boolean) =>
    runBenchmark({
      spec: { name: "gc-force-test", fn: simpleTestFunction },
      options: { maxIterations: 20, gcForce },
      useWorker: false,
    });
  try {
    const off = (await run(false))[0].samples.length;
    const baseline = gcCalls; // warmup-settle gc only, no per-sample gc
    gcCalls = 0;
    const on = (await run(true))[0].samples.length;
    // gcForce adds exactly one gc() per measured sample on top of warmup
    expect(gcCalls).toBe(on + baseline);
    expect(off).toBe(20);
    expect(on).toBe(20);
  } finally {
    g.gc = saved;
  }
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
    options: { maxTime: 1, maxIterations: 1 },
    useWorker: true,
  });
  await expect(promise).rejects.toThrow("Test error from benchmark");
});
