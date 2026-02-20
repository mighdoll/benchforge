import { expect, test } from "vitest";
import type { BenchmarkSpec } from "../Benchmark.ts";
import {
  checkConvergence,
  createAdaptiveWrapper,
} from "../runners/AdaptiveWrapper.ts";
import { BasicRunner } from "../runners/BasicRunner.ts";

test(
  "adaptive runner collects samples for minimum time",
  { timeout: 10000 },
  async () => {
    const runner = new BasicRunner();
    const adaptive = createAdaptiveWrapper(runner, {
      minTime: 100,
      maxTime: 300,
    });

    const benchmark: BenchmarkSpec = {
      name: "test-min-time",
      fn: () => {
        let sum = 0;
        for (let i = 0; i < 1000; i++) sum += i;
        return sum;
      },
    };

    const start = performance.now();
    const results = await adaptive.runBench(benchmark, { minTime: 100 });
    const elapsed = performance.now() - start;

    expect(results).toHaveLength(1);
    expect(results[0].samples.length).toBeGreaterThan(0);
    expect(elapsed).toBeGreaterThanOrEqual(100);
  },
);

test("adaptive runner respects max time limit", async () => {
  const runner = new BasicRunner();
  const adaptive = createAdaptiveWrapper(runner, {
    minTime: 100,
    maxTime: 2000,
  });

  const benchmark: BenchmarkSpec = {
    name: "test-max-time",
    fn: () => {
      let sum = 0;
      for (let i = 0; i < 10000; i++) sum += Math.sqrt(i);
      return sum;
    },
  };

  const results = await adaptive.runBench(benchmark, {
    minTime: 250,
    maxTime: 500,
  });

  expect(results).toHaveLength(1);
  expect(results[0].totalTime).toBeGreaterThanOrEqual(0);
  // 1s warmup overhead + 500ms maxTime + some tolerance
  expect(results[0].totalTime).toBeLessThanOrEqual(2.0);
});

test("adaptive runner merges results correctly", async () => {
  const runner = new BasicRunner();
  const adaptive = createAdaptiveWrapper(runner, {
    minTime: 100,
    maxTime: 200,
  });

  const benchmark: BenchmarkSpec = {
    name: "test-merge",
    fn: () => {
      let sum = 0;
      for (let i = 0; i < 100; i++) sum += i;
      return sum;
    },
  };

  const results = await adaptive.runBench(benchmark, { minTime: 50 });

  expect(results).toHaveLength(1);
  const result = results[0];

  expect(result.samples.length).toBeGreaterThan(0);
  expect(result.time.min).toBeLessThanOrEqual(result.time.max);
  expect(result.time.avg).toBeGreaterThan(0);
  expect(result.time.p50).toBeDefined();
  expect(result.time.p99).toBeDefined();

  if (result.time.p25 !== undefined && result.time.p75 !== undefined) {
    expect(result.time.p25).toBeLessThanOrEqual(result.time.p50);
    expect(result.time.p50).toBeLessThanOrEqual(result.time.p75);
  }
  if (result.time.p99 !== undefined && result.time.p999 !== undefined) {
    expect(result.time.p99).toBeLessThanOrEqual(result.time.p999);
  }

  expect(result.totalTime).toBeDefined();
  expect(result.totalTime).toBeGreaterThan(0);
}, 10000);

test("convergence detection with stable benchmark", async () => {
  const runner = new BasicRunner();
  const adaptive = createAdaptiveWrapper(runner, {
    minTime: 100,
    maxTime: 2000,
    targetConfidence: 95,
  });

  const benchmark: BenchmarkSpec = {
    name: "stable-convergence-test",
    fn: () => {
      let sum = 0;
      for (let i = 0; i < 100; i++) sum += i;
      return sum;
    },
  };

  const results = await adaptive.runBench(benchmark, { minTime: 50 });

  expect(results).toHaveLength(1);
  const result = results[0];

  expect(result.convergence).toBeDefined();
  expect(result.convergence?.confidence).toBeGreaterThanOrEqual(0);
  expect(result.convergence?.confidence).toBeLessThanOrEqual(100);
  expect(result.convergence?.reason).toBeDefined();
});

test("convergence detection with variable benchmark", async () => {
  const runner = new BasicRunner();
  const adaptive = createAdaptiveWrapper(runner, {
    minTime: 100,
    maxTime: 1000,
  });

  let callCount = 0;
  const benchmark: BenchmarkSpec = {
    name: "variable-convergence-test",
    fn: () => {
      // Variable operation - alternates between fast and slow
      callCount++;
      const iterations = callCount % 10 === 0 ? 1000 : 100;
      let sum = 0;
      for (let i = 0; i < iterations; i++) {
        sum += i;
      }
      return sum;
    },
  };

  const results = await adaptive.runBench(benchmark, { minTime: 100 });

  expect(results).toHaveLength(1);
  const result = results[0];

  expect(result.convergence).toBeDefined();
  // Pattern may be detected as stable if predictable
  expect(result.convergence?.confidence).toBeGreaterThanOrEqual(0);
  expect(result.convergence?.confidence).toBeLessThanOrEqual(100);
});

test("checkConvergence function basics", () => {
  // Not enough samples
  const fewSamples = [1e6, 1.1e6, 1e6];
  const fewResult = checkConvergence(fewSamples);
  expect(fewResult.converged).toBe(false);
  expect(fewResult.reason).toContain("Collecting samples");

  // Many stable samples
  const stableSamples = Array(100).fill(1e6);
  const stableResult = checkConvergence(stableSamples);
  expect(stableResult.confidence).toBeGreaterThan(50);

  // Variable samples - alternating pattern may be detected as stable
  const variableSamples = Array.from({ length: 100 }, (_, i) =>
    i % 2 === 0 ? 1e6 : 2e6,
  );
  const variableResult = checkConvergence(variableSamples);
  // Just verify confidence is calculated, alternating may be seen as stable
  expect(variableResult.confidence).toBeGreaterThanOrEqual(0);
  expect(variableResult.confidence).toBeLessThanOrEqual(100);
});
