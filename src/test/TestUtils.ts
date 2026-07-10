import type { Configure, DefaultCliArgs } from "../cli/CliArgs.ts";
import { parseCliArgs } from "../cli/CliArgs.ts";
import { defaultReportData, matrixToReportGroups } from "../cli/CliReport.ts";
import { runFilteredMatrices } from "../cli/RunBenchCLI.ts";
import type { MatrixSuite } from "../matrix/BenchMatrix.ts";
import type { BenchmarkReport } from "../report/BenchmarkReport.ts";
import { consoleSummary } from "../report/ConsoleSummary.ts";
import type { MeasuredResults } from "../runners/MeasuredResults.ts";
import { mean, percentile } from "../stats/CoreStats.ts";
import { bevy30SamplesMs } from "./fixtures/bevy30-samples.ts";

/** Validation helpers for statistical tests */
export const assertValid: {
  pValue: (value: number) => void;
  percentileOrder: (p25: number, p50: number, p75: number, p99: number) => void;
  significance: (level: string) => void;
} = {
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

/** @return formatted benchmark output for CLI testing */
export async function runBenchCLITest<T = DefaultCliArgs>(
  suite: MatrixSuite,
  args: string,
  configureArgs?: Configure<T>,
): Promise<string> {
  const argv = args.split(/\s+/).filter(arg => arg.length > 0);
  const parsedArgs = parseCliArgs(configureArgs, argv) as T & DefaultCliArgs;
  const matrixResults = await runFilteredMatrices(suite, parsedArgs);
  const groups = matrixToReportGroups(matrixResults);
  return consoleSummary(defaultReportData(groups, parsedArgs));
}

/** All-zero summary stats for report-data fixtures that never read them. */
export const zeroStats = {
  min: 0,
  max: 0,
  avg: 0,
  p50: 0,
  p75: 0,
  p99: 0,
  p999: 0,
};

/** Near-constant batches centered on `value` (tiny symmetric jitter keeps the
 *  median well-defined), for exact reciprocal-delta assertions. */
export function constBatches(
  batches: number,
  perBatch: number,
  value: number,
  name = "x",
): MeasuredResults {
  const samples: number[] = [];
  const batchOffsets: number[] = [];
  for (let b = 0; b < batches; b++) {
    batchOffsets.push(samples.length);
    for (let i = 0; i < perBatch; i++)
      samples.push(value + (i - (perBatch - 1) / 2) * 1e-6);
  }
  return { name, samples, batchOffsets, time: zeroStats };
}

/** @return slice of bevy30 samples for consistent test data */
export function getSampleData(start: number, end: number): number[] {
  return bevy30SamplesMs.slice(start, end);
}

/** Batch offsets for `batches` equal batches of `perBatch` samples each
 *  (cumulative sample counts starting at 0, the shape validateOffsets expects). */
export function batchOffsets(batches: number, perBatch: number): number[] {
  return Array.from({ length: batches }, (_, i) => i * perBatch);
}

/** Flatten `values` into samples, repeating each `perBatch` times so each entry
 *  becomes one constant-valued batch. */
export function repeatedBatches(values: number[], perBatch: number): number[] {
  return values.flatMap(v => Array.from({ length: perBatch }, () => v));
}

/** Per-round drift shared by baseline and current (current scaled by `scale`),
 *  with a within-batch ramp -- a clean positive-correlation pairing case. */
export function sharedDriftData(
  batches: number,
  perBatch: number,
  scale: number,
): { baseline: number[]; current: number[]; blocks: number[] } {
  const baseline: number[] = [];
  const current: number[] = [];
  for (let b = 0; b < batches; b++) {
    const drift = 100 + b * 50;
    for (let i = 0; i < perBatch; i++) {
      const value = drift + i;
      baseline.push(value);
      current.push(value * scale);
    }
  }
  return { baseline, current, blocks: batchOffsets(batches, perBatch) };
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
      avg: mean(samples),
      p50: percentile(samples, 0.5),
      p75: percentile(samples, 0.75),
      p99: percentile(samples, 0.99),
      p999: percentile(samples, 0.999),
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
