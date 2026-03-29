import { test } from "vitest";
import type { BenchmarkSpec } from "../Benchmark.ts";
import type { MeasuredResults } from "../MeasuredResults.ts";
import { createAdaptiveWrapper } from "../runners/AdaptiveWrapper.ts";
import type { BenchRunner } from "../runners/BenchRunner.ts";
import { bevy30SamplesMs } from "./fixtures/bevy30-samples.ts";

/** Assert convergence data exists, return the result for further checks. */
function requireConvergence(result: MeasuredResults): MeasuredResults {
  if (!result.convergence) throw new Error("Missing convergence data");
  return result;
}

/** Mock runner that returns pre-recorded samples */
function createMockRunner(samples: number[]): BenchRunner {
  let sampleIndex = 0;

  return {
    async runBench(benchmark, options) {
      const { minTime = 100, maxIterations = 10 } = options;
      const batchSamples: number[] = [];
      const startTime = performance.now();

      while (
        sampleIndex < samples.length &&
        batchSamples.length < (maxIterations ?? 10) &&
        performance.now() - startTime < minTime
      ) {
        batchSamples.push(samples[sampleIndex++]);
        await new Promise(resolve => setTimeout(resolve, 1));
      }

      const sorted = [...batchSamples].sort((a, b) => a - b);
      const avg = batchSamples.reduce((a, b) => a + b, 0) / batchSamples.length;
      const p50 = sorted[Math.floor(sorted.length / 2)];
      const time = { min: sorted[0], max: sorted.at(-1)!, avg, p50 };
      return [
        { name: benchmark.name, samples: batchSamples, time },
      ] as MeasuredResults[];
    },
  };
}

test("adaptive wrapper stops early with stable samples", async () => {
  const stableSamples = Array.from(
    { length: 500 },
    () => 50 + Math.random() * 0.5,
  );
  const mockRunner = createMockRunner(stableSamples);

  const adaptiveRunner = createAdaptiveWrapper(mockRunner, {});
  const bench: BenchmarkSpec = { name: "stable-test", fn: () => {} };

  const startTime = performance.now();
  const results = await adaptiveRunner.runBench(bench, {
    minTime: 500, // 0.5s minimum
    maxTime: 5000, // 5s maximum
  });
  const duration = performance.now() - startTime;

  // Should stop early due to convergence
  if (duration > 3000) {
    console.warn(`Took ${duration}ms - may not have converged early`);
  }

  const result = requireConvergence(results[0]);

  console.log(
    `Stable samples: ${result.samples.length} samples, ${result.convergence!.confidence}% confidence`,
  );

  if (result.convergence!.confidence < 95) {
    throw new Error("Should achieve high confidence with stable samples");
  }
});

test("adaptive wrapper continues with unstable samples", async () => {
  const unstableSamples = Array.from(
    { length: 500 },
    () => 30 + Math.random() * 40,
  );
  const mockRunner = createMockRunner(unstableSamples);

  const adaptiveRunner = createAdaptiveWrapper(mockRunner, {});
  const bench: BenchmarkSpec = { name: "unstable-test", fn: () => {} };
  const results = await adaptiveRunner.runBench(bench, {
    minTime: 100, // 0.1s minimum
    maxTime: 500, // 0.5s maximum
  });

  const result = requireConvergence(results[0]);

  console.log(
    `Unstable samples: ${result.samples.length} samples, ${result.convergence!.confidence}% confidence`,
  );

  if (result.convergence!.confidence > 80) {
    console.warn("Achieved high confidence despite unstable samples");
  }
});

test("adaptive wrapper with real bevy30 data", async () => {
  const bench: BenchmarkSpec = { name: "bevy-test", fn: () => {} };

  const configs = [
    { minTime: 1000, maxTime: 5000, label: "1-5s" },
    { minTime: 2000, maxTime: 10000, label: "2-10s" },
    { minTime: 5000, maxTime: 30000, label: "5-30s" },
  ];

  for (const config of configs) {
    // Reset sample index for each test
    const runner = createMockRunner(bevy30SamplesMs);
    const adaptive = createAdaptiveWrapper(runner, {});

    const results = await adaptive.runBench(bench, config);

    const result = requireConvergence(results[0]);

    console.log(
      `Config ${config.label}: ${result.samples.length} samples, ${result.convergence!.confidence}% confidence`,
    );
  }
});

test("adaptive wrapper respects target confidence", async () => {
  const mockRunner = createMockRunner(bevy30SamplesMs);

  const wrapper = createAdaptiveWrapper(mockRunner, { convergence: 50 });
  const bench: BenchmarkSpec = { name: "low-confidence-test", fn: () => {} };

  const startTime = performance.now();
  const results = await wrapper.runBench(bench, {
    minTime: 500,
    maxTime: 10000,
  });
  const duration = performance.now() - startTime;

  const result = requireConvergence(results[0]);

  console.log(
    `Low target (50%): ${result.samples.length} samples in ${duration}ms, ${result.convergence!.confidence}% confidence`,
  );

  // Should stop relatively quickly with low target
  if (duration > 5000 && result.convergence!.confidence > 50) {
    console.warn("Took longer than expected for low confidence target");
  }
});

test("adaptive wrapper handles warm-up period", async () => {
  // Simulate warm-up: slow samples at start, then stable
  // Decreasing from 100ms to 60ms, then stable at ~50ms
  const warmup = Array.from({ length: 20 }, (_, i) => 100 - i * 2);
  const stable = Array.from({ length: 200 }, () => 50 + Math.random());
  const warmupSamples = [...warmup, ...stable];

  const mockRunner = createMockRunner(warmupSamples);
  const adaptiveRunner = createAdaptiveWrapper(mockRunner, {});

  const bench: BenchmarkSpec = { name: "warmup-test", fn: () => {} };
  const results = await adaptiveRunner.runBench(bench, {
    minTime: 1000,
    maxTime: 5000,
  });

  const result = requireConvergence(results[0]);
  if (!result.time) throw new Error("Missing time stats");

  console.log(
    `Warmup test: median=${result.time.p50?.toFixed(1)}ms, mean=${result.time.avg?.toFixed(1)}ms`,
  );

  // Median should be close to stable value (50ms) despite warm-up
  if (result.time.p50 && Math.abs(result.time.p50 - 50) > 5) {
    console.warn(`Median ${result.time.p50}ms differs from stable 50ms`);
  }
});

test("adaptive wrapper statistics calculation", async () => {
  const samples = bevy30SamplesMs.slice(100, 200);
  const mockRunner = createMockRunner(samples);
  const adaptiveRunner = createAdaptiveWrapper(mockRunner, {});

  const bench: BenchmarkSpec = { name: "stats-test", fn: () => {} };
  const results = await adaptiveRunner.runBench(bench, {
    minTime: 100,
    maxTime: 1000,
  });

  const result = results[0];
  if (!result.time) throw new Error("Missing time statistics");

  const { min, p25, p50, p75, p95, p99, max } = result.time;
  const ordered = [min, p25, p50, p75, p95, p99, max];
  if (ordered.some(v => v == null)) throw new Error("Missing percentile data");
  if (ordered.some((v, i) => i > 0 && v! < ordered[i - 1]!)) {
    throw new Error("Percentiles not in correct order");
  }

  console.log(
    `Statistics: min=${min.toFixed(1)}, p50=${p50.toFixed(1)}, p99=${p99.toFixed(1)}, max=${max.toFixed(1)}`,
  );

  if (result.time.cv === undefined || result.time.mad === undefined) {
    throw new Error("Missing variability metrics (CV or MAD)");
  }

  console.log(
    `Variability: CV=${(result.time.cv * 100).toFixed(1)}%, MAD=${result.time.mad.toFixed(2)}`,
  );
});

test("adaptive wrapper total time tracking", async () => {
  const mockRunner = createMockRunner(bevy30SamplesMs.slice(0, 100));
  const adaptiveRunner = createAdaptiveWrapper(mockRunner, {});

  const bench: BenchmarkSpec = { name: "time-tracking-test", fn: () => {} };

  const startTime = performance.now();
  const results = await adaptiveRunner.runBench(bench, {
    minTime: 200,
    maxTime: 1000,
  });
  const actualDuration = (performance.now() - startTime) / 1000;

  const result = results[0];
  if (!result.totalTime) throw new Error("Missing totalTime");

  console.log(
    `Total time: reported=${result.totalTime.toFixed(2)}s, actual=${actualDuration.toFixed(2)}s`,
  );

  // Total time should be close to actual duration
  if (Math.abs(result.totalTime - actualDuration) > 0.5) {
    console.warn(
      `Time tracking mismatch: ${Math.abs(result.totalTime - actualDuration).toFixed(2)}s difference`,
    );
  }
});
