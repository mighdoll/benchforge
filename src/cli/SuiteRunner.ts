import type {
  BenchmarkReport,
  ReportGroup,
} from "../report/BenchmarkReport.ts";
import { computeStats } from "../runners/BasicRunner.ts";
import type {
  BenchGroup,
  BenchmarkSpec,
  BenchSuite,
} from "../runners/BenchmarkSpec.ts";
import type { RunnerOptions } from "../runners/BenchRunner.ts";
import type { KnownRunner } from "../runners/CreateRunner.ts";
import type { MeasuredResults } from "../runners/MeasuredResults.ts";
import { runBenchmark } from "../runners/RunnerOrchestrator.ts";
import type { DefaultCliArgs } from "./CliArgs.ts";
import { cliToRunnerOptions, validateArgs } from "./CliOptions.ts";
import { filterBenchmarks } from "./FilterBenchmarks.ts";

type RunParams = {
  runner: KnownRunner;
  options: RunnerOptions;
  useWorker: boolean;
  params: unknown;
  metadata?: Record<string, any>;
};

type SuiteParams = {
  runner: KnownRunner;
  options: RunnerOptions;
  useWorker: boolean;
  suite: BenchSuite;
  batches: number;
};

/** Run suite with CLI arguments */
export async function runBenchmarks(
  suite: BenchSuite,
  args: DefaultCliArgs,
): Promise<ReportGroup[]> {
  validateArgs(args);
  const { filter, worker: useWorker, batches = 1 } = args;
  const options = cliToRunnerOptions(args);
  const filtered = filterBenchmarks(suite, filter);

  return runSuite({
    suite: filtered,
    runner: "basic",
    options,
    useWorker,
    batches,
  });
}

/** Execute all groups in suite */
async function runSuite(params: SuiteParams): Promise<ReportGroup[]> {
  const { suite, runner, options, useWorker, batches } = params;
  return serialMap(suite.groups, g =>
    runGroup(g, runner, options, useWorker, batches),
  );
}

/** Sequential map - like Promise.all(arr.map(fn)) but runs one at a time */
async function serialMap<T, R>(
  arr: T[],
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  for (const item of arr) {
    results.push(await fn(item));
  }
  return results;
}

/** Execute group with shared setup, optionally batching to reduce ordering bias */
async function runGroup(
  group: BenchGroup,
  runner: KnownRunner,
  options: RunnerOptions,
  useWorker: boolean,
  batches = 1,
): Promise<ReportGroup> {
  const { name, benchmarks, baseline, setup, metadata } = group;
  const setupParams = await setup?.();
  validateBenchmarkParameters(group);

  const runParams = {
    runner,
    options,
    useWorker,
    params: setupParams,
    metadata,
  };
  if (batches === 1) {
    return runSingleBatch(name, benchmarks, baseline, runParams);
  }
  return runMultipleBatches(name, benchmarks, baseline, runParams, batches);
}

/** Warn if parameterized benchmarks lack setup */
function validateBenchmarkParameters(group: BenchGroup): void {
  if (group.setup) return;
  const all = group.baseline
    ? [...group.benchmarks, group.baseline]
    : group.benchmarks;
  for (const bench of all) {
    if (bench.fn.length > 0) {
      console.warn(
        `Benchmark "${bench.name}" in group "${group.name}" expects parameters but no setup() provided.`,
      );
    }
  }
}

/** Run benchmarks in a single batch */
async function runSingleBatch(
  name: string,
  benchmarks: BenchmarkSpec[],
  baseline: BenchmarkSpec | undefined,
  runParams: RunParams,
): Promise<ReportGroup> {
  const baselineReport = baseline
    ? await runSingleBenchmark(baseline, runParams)
    : undefined;
  const reports = await serialMap(benchmarks, b =>
    runSingleBenchmark(b, runParams),
  );
  return { name, reports, baseline: baselineReport };
}

/** Run benchmarks in multiple batches, alternating order to reduce bias */
async function runMultipleBatches(
  name: string,
  benchmarks: BenchmarkSpec[],
  baseline: BenchmarkSpec | undefined,
  runParams: RunParams,
  batches: number,
): Promise<ReportGroup> {
  const maxTime = (runParams.options.maxTime || 5000) / batches;
  const opts = { ...runParams.options, maxTime };
  const batchParams = { ...runParams, options: opts };
  const baselineBatches: MeasuredResults[] = [];
  const benchmarkBatches = new Map<string, MeasuredResults[]>();

  for (let i = 0; i < batches; i++) {
    const reverseOrder = i % 2 === 1;
    await runBatchIteration(
      benchmarks,
      baseline,
      batchParams,
      reverseOrder,
      baselineBatches,
      benchmarkBatches,
    );
  }

  return mergeBatchResults(
    name,
    benchmarks,
    baseline,
    baselineBatches,
    benchmarkBatches,
    runParams.metadata,
  );
}

/** Run single benchmark and create report */
async function runSingleBenchmark(
  spec: BenchmarkSpec,
  { runner, options, useWorker, params, metadata }: RunParams,
): Promise<BenchmarkReport> {
  const [result] = await runBenchmark({
    spec,
    runner,
    options,
    useWorker,
    params,
  });
  return { name: spec.name, measuredResults: result, metadata };
}

/** Run one batch iteration in either order */
async function runBatchIteration(
  benchmarks: BenchmarkSpec[],
  baseline: BenchmarkSpec | undefined,
  runParams: RunParams,
  reverseOrder: boolean,
  baselineBatches: MeasuredResults[],
  benchmarkBatches: Map<string, MeasuredResults[]>,
): Promise<void> {
  const runBaseline = async () => {
    if (baseline) {
      const r = await runSingleBenchmark(baseline, runParams);
      baselineBatches.push(r.measuredResults);
    }
  };
  const runBenches = async () => {
    for (const b of benchmarks) {
      const r = await runSingleBenchmark(b, runParams);
      appendToMap(benchmarkBatches, b.name, r.measuredResults);
    }
  };

  if (reverseOrder) {
    await runBenches();
    await runBaseline();
  } else {
    await runBaseline();
    await runBenches();
  }
}

/** Merge batch results into final ReportGroup */
function mergeBatchResults(
  name: string,
  benchmarks: BenchmarkSpec[],
  baseline: BenchmarkSpec | undefined,
  baselineBatches: MeasuredResults[],
  benchmarkBatches: Map<string, MeasuredResults[]>,
  metadata?: Record<string, unknown>,
): ReportGroup {
  const mergedBaseline = baseline
    ? {
        name: baseline.name,
        measuredResults: mergeResults(baselineBatches),
        metadata,
      }
    : undefined;
  const reports = benchmarks.map(b => ({
    name: b.name,
    measuredResults: mergeResults(benchmarkBatches.get(b.name) || []),
    metadata,
  }));
  return { name, reports, baseline: mergedBaseline };
}

function appendToMap(
  map: Map<string, MeasuredResults[]>,
  key: string,
  value: MeasuredResults,
) {
  if (!map.has(key)) map.set(key, []);
  map.get(key)!.push(value);
}

/** Merge multiple batch results into a single MeasuredResults */
function mergeResults(results: MeasuredResults[]): MeasuredResults {
  if (results.length === 0) {
    throw new Error("Cannot merge empty results array");
  }
  if (results.length === 1) return results[0];

  const allSamples = results.flatMap(r => r.samples);
  const allWarmup = results.flatMap(r => r.warmupSamples || []);
  const time = computeStats(allSamples);

  let offset = 0;
  const pauses = results.flatMap(r => {
    const shifted = (r.pausePoints ?? []).map(p => ({
      sampleIndex: p.sampleIndex + offset,
      durationMs: p.durationMs,
    }));
    offset += r.samples.length;
    return shifted;
  });

  return {
    name: results[0].name,
    samples: allSamples,
    warmupSamples: allWarmup.length ? allWarmup : undefined,
    time,
    totalTime: results.reduce((sum, r) => sum + (r.totalTime || 0), 0),
    pausePoints: pauses.length ? pauses : undefined,
  };
}
