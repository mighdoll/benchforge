import type { BenchSuite } from "../Benchmark.ts";
import type { BenchmarkReport } from "../BenchmarkReport.ts";
import type { Configure, DefaultCliArgs } from "../cli/CliArgs.ts";
import { parseCliArgs } from "../cli/CliArgs.ts";
import { defaultReport, runBenchmarks } from "../cli/RunBenchCLI.ts";
import type { MeasuredResults } from "../MeasuredResults.ts";
import { average, percentile } from "../StatisticalUtils.ts";
import { bevy30SamplesMs } from "../tests/fixtures/bevy30-samples.ts";

/** @return formatted benchmark output for CLI testing */
export async function runBenchCLITest<T = DefaultCliArgs>(
  suite: BenchSuite,
  args: string,
  configureArgs?: Configure<T>,
): Promise<string> {
  const argv = args.split(/\s+/).filter(arg => arg.length > 0);
  const parsedArgs = parseCliArgs(argv, configureArgs) as T & DefaultCliArgs;
  const results = await runBenchmarks(suite, parsedArgs);
  return defaultReport(results, parsedArgs);
}

/** @return slice of bevy30 samples for consistent test data */
export function getSampleData(start: number, end: number): number[] {
  return bevy30SamplesMs.slice(start, end);
}

/** @return test MeasuredResults from bevy30 samples */
export function createMeasuredResults(
  sampleRange: [number, number],
  overrides?: Partial<MeasuredResults>,
): MeasuredResults {
  const samples = getSampleData(sampleRange[0], sampleRange[1]);
  const sorted = [...samples].sort((a, b) => a - b);

  return {
    name: "test",
    samples,
    time: {
      min: sorted[0],
      max: sorted[sorted.length - 1],
      avg: average(samples),
      p50: percentile(samples, 0.5),
      p75: percentile(samples, 0.75),
      p99: percentile(samples, 0.99),
      p999: percentile(samples, 0.999),
    },
    nodeGcTime: {
      inRun: 0.09,
      before: 0.01,
      after: 0.02,
      total: 0.12,
      collects: 3,
      events: [],
    },
    ...overrides,
  };
}

/** @return test BenchmarkReport from bevy30 samples */
export function createBenchmarkReport(
  name: string,
  sampleRange: [number, number],
  overrides?: Partial<MeasuredResults>,
): BenchmarkReport {
  return {
    name,
    measuredResults: createMeasuredResults(sampleRange, overrides),
  };
}

/** Validation helpers for statistical tests */
export const assertValid = {
  pValue: (value: number) => {
    if (value < 0 || value > 1) {
      throw new Error(`Expected p-value between 0 and 1, got ${value}`);
    }
  },

  percentileOrder: (p25: number, p50: number, p75: number, p99: number) => {
    if (!(p25 <= p50 && p50 <= p75 && p75 <= p99)) {
      throw new Error(
        `Percentiles not ordered: p25=${p25}, p50=${p50}, p75=${p75}, p99=${p99}`,
      );
    }
  },

  significance: (level: string) => {
    const valid = ["none", "weak", "good", "strong"];
    if (!valid.includes(level)) {
      throw new Error(`Invalid significance level: ${level}`);
    }
  },
};
