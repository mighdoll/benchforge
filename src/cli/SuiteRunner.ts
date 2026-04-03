import type {
  BenchmarkReport,
  ReportGroup,
} from "../report/BenchmarkReport.ts";
import type {
  BenchGroup,
  BenchmarkSpec,
  BenchSuite,
} from "../runners/BenchmarkSpec.ts";
import type { RunnerOptions } from "../runners/BenchRunner.ts";
import type { KnownRunner } from "../runners/CreateRunner.ts";
import { runBatched } from "../runners/MergeBatches.ts";
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
  warmupBatch: boolean;
};

/** Run a benchmark suite with CLI arguments. */
export async function runBenchmarks(
  suite: BenchSuite,
  args: DefaultCliArgs,
): Promise<ReportGroup[]> {
  validateArgs(args);
  const { filter, worker: useWorker, batches = 1 } = args;
  const warmupBatch = args["warmup-batch"] ?? false;
  const options = cliToRunnerOptions(args);
  const filtered = filterBenchmarks(suite, filter);

  const params = {
    suite: filtered,
    runner: "basic" as const,
    options,
    useWorker,
    batches,
    warmupBatch,
  };
  return runSuite(params);
}

/** Execute all groups in a suite sequentially. */
async function runSuite(params: SuiteParams): Promise<ReportGroup[]> {
  const { suite, ...rest } = params;
  return serialMap(suite.groups, g => runGroup(g, rest));
}

/** Like Promise.all(arr.map(fn)) but runs one at a time. */
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

/** Execute group with shared setup, optionally batching to reduce ordering bias. */
async function runGroup(
  group: BenchGroup,
  suiteParams: Omit<SuiteParams, "suite">,
): Promise<ReportGroup> {
  const { batches = 1, warmupBatch = false, ...rest } = suiteParams;
  const { name, benchmarks, baseline, setup, metadata } = group;
  const setupParams = await setup?.();
  validateBenchmarkParameters(group);

  const runParams: RunParams = { ...rest, params: setupParams, metadata };
  if (batches === 1)
    return runSingleBatch(name, benchmarks, baseline, runParams);
  return runMultipleBatches(
    name,
    benchmarks,
    baseline,
    runParams,
    batches,
    warmupBatch,
  );
}

/** Warn if parameterized benchmarks lack a setup function. */
function validateBenchmarkParameters(group: BenchGroup): void {
  if (group.setup) return;
  const all = group.baseline
    ? [...group.benchmarks, group.baseline]
    : group.benchmarks;
  for (const bench of all.filter(b => b.fn.length > 0)) {
    console.warn(
      `Benchmark "${bench.name}" in group "${group.name}" expects parameters but no setup() provided.`,
    );
  }
}

/** Run benchmarks in a single batch. */
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

/** Run benchmarks in multiple batches, alternating order to reduce bias. */
async function runMultipleBatches(
  name: string,
  benchmarks: BenchmarkSpec[],
  baseline: BenchmarkSpec | undefined,
  runParams: RunParams,
  batches: number,
  warmupBatch = false,
): Promise<ReportGroup> {
  const { metadata } = runParams;
  const run = (spec: BenchmarkSpec) => async () => {
    const r = await runSingleBenchmark(spec, runParams);
    return r.measuredResults;
  };
  const runners = benchmarks.map(run);
  const baselineFn = baseline ? run(baseline) : undefined;

  const batched = await runBatched(runners, baselineFn, batches, warmupBatch);
  const { results, baseline: merged } = batched;

  const reports = benchmarks.map((b, i) => ({
    name: b.name,
    measuredResults: results[i],
    metadata,
  }));
  const baselineReport =
    merged && baseline
      ? { name: baseline.name, measuredResults: merged, metadata }
      : undefined;
  return { name, reports, baseline: baselineReport };
}

/** Run single benchmark and create report. */
async function runSingleBenchmark(
  spec: BenchmarkSpec,
  { runner, options, useWorker, params, metadata }: RunParams,
): Promise<BenchmarkReport> {
  const args = { spec, runner, options, useWorker, params };
  const [result] = await runBenchmark(args);
  return { name: spec.name, measuredResults: result, metadata };
}
