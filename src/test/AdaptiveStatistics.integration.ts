import { expect } from "vitest";
import { parseBenchArgs } from "../cli/RunBenchCLI.ts";
import type { BenchSuite } from "../core/Benchmark.ts";
import type { BenchmarkReport } from "../report/BenchmarkReport.ts";

const _statisticalSuite: BenchSuite = {
  name: "Statistical Test Suite",
  groups: [
    {
      name: "Test Group",
      benchmarks: [
        {
          name: "stable-benchmark",
          fn: () => {
            let sum = 0;
            for (let i = 0; i < 100; i++) sum += i;
            return sum;
          },
        },
        {
          name: "variable-benchmark",
          fn: () => {
            const iterations = Math.random() > 0.9 ? 1000 : 100;
            let sum = 0;
            for (let i = 0; i < iterations; i++) sum += i;
            return sum;
          },
        },
      ],
    },
  ],
};

const _gcSuite: BenchSuite = {
  name: "GC Test Suite",
  groups: [
    {
      name: "Memory Group",
      benchmarks: [
        {
          name: "gc-heavy",
          fn: () => {
            const arrays = [];
            for (let i = 0; i < 50; i++) {
              arrays.push(Array.from({ length: 1000 }, () => Math.random()));
            }
            return arrays.length;
          },
        },
      ],
    },
  ],
};

function _parseAdaptiveArgs() {
  return parseBenchArgs((yargs: any) =>
    yargs
      .option("adaptive", { type: "boolean", default: true })
      .option("time", { type: "number", default: 0.1 })
      .option("min-time", { type: "number", default: 0.1 }),
  );
}

function _verifyStatisticalMetrics(report: BenchmarkReport): void {
  const { time, convergence } = report.measuredResults;
  expect(time).toBeDefined();
  expect(time?.p25).toBeDefined();
  expect(time?.p50).toBeDefined();
  expect(time?.p75).toBeDefined();
  expect(time?.p95).toBeDefined();
  expect(time?.cv).toBeGreaterThanOrEqual(0);
  expect(time?.mad).toBeGreaterThanOrEqual(0);
  expect(time?.outlierRate).toBeGreaterThanOrEqual(0);
  expect(time?.outlierRate).toBeLessThanOrEqual(1);
  expect(convergence?.confidence).toBeGreaterThanOrEqual(0);
  expect(convergence?.confidence).toBeLessThanOrEqual(100);
  expect(convergence?.reason).toBeDefined();
}

function _verifyPercentileOrdering(report: BenchmarkReport): void {
  const t = report.measuredResults.time;
  if (t?.p25 && t?.p50 && t?.p75 && t?.p95) {
    expect(t.p25).toBeLessThanOrEqual(t.p50);
    expect(t.p50).toBeLessThanOrEqual(t.p75);
    expect(t.p75).toBeLessThanOrEqual(t.p95);
  }
}
