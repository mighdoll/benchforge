import type { RunMatrixOptions } from "../matrix/BenchMatrix.ts";
import type { HeapReportOptions } from "../profiling/node/HeapSampleReport.ts";
import type { ComparisonOptions } from "../report/BenchmarkReport.ts";
import type { RunnerOptions } from "../runners/BenchRunner.ts";
import { type DefaultCliArgs, defaultDuration } from "./CliArgs.ts";

/** Runner limits resolved from the duration/iterations flags. */
type Limits = {
  maxTime: number | undefined;
  maxIterations: number | undefined;
};

/** Convert CLI args to matrix runner options. */
export function cliToMatrixOptions(args: DefaultCliArgs): RunMatrixOptions {
  const { iterations, worker, batches } = args;
  const { maxTime } = resolveLimits(args);
  return {
    iterations,
    maxTime,
    useWorker: worker,
    batches,
    warmupBatch: args["warmup-batch"],
    calibrate: args.calibrate,
    calibrateRuns: args["calibrate-runs"],
    ...cliCommonOptions(args),
  };
}

/** Validate CLI argument combinations. */
export function validateArgs(args: DefaultCliArgs): void {
  if (args["gc-stats"] && !args.worker && !args.url) {
    throw new Error(
      "--gc-stats requires worker mode (the default). Remove --no-worker flag.",
    );
  }
}

/** Convert CLI args to benchmark runner options. */
export function cliToRunnerOptions(args: DefaultCliArgs): RunnerOptions {
  const { inspect, iterations } = args;
  const gcForce = args["gc-force"];
  if (inspect) return { maxIterations: iterations ?? 1, gcForce };
  return { ...resolveLimits(args), ...cliCommonOptions(args) };
}

/** Convert CLI args to heap report display options. */
export function cliHeapReportOptions(args: DefaultCliArgs): HeapReportOptions {
  return {
    topN: args["alloc-rows"],
    stackDepth: args["alloc-stack"],
    verbose: args["alloc-verbose"],
    raw: args["alloc-raw"],
    userOnly: args["alloc-user-only"],
  };
}

/** True if any alloc-related flag implies allocation sampling. */
export function needsAlloc(args: DefaultCliArgs): boolean {
  return (
    args.alloc ||
    args.archive != null ||
    args["alloc-raw"] ||
    args["alloc-verbose"] ||
    args["alloc-user-only"]
  );
}

/** True if any profiling flag implies CPU time sampling. */
export function needsProfile(args: DefaultCliArgs): boolean {
  return args.profile || !!args["export-profile"];
}

/** Extract baseline comparison options from CLI args. */
export function cliComparisonOptions(args: DefaultCliArgs): ComparisonOptions {
  return {
    equivMargin: args["equiv-margin"],
    noBatchTrim: args["no-batch-trim"],
  };
}

/**
 * Resolve duration/iterations flags into runner limits.
 *
 * | Flags set         | maxTime              | maxIterations |
 * |-------------------|----------------------|---------------|
 * | neither           | defaultDuration*1000 | undefined     |
 * | --iterations only | undefined            | N             |
 * | --duration only   | duration*1000        | undefined     |
 * | both              | duration*1000        | N             |
 */
export function resolveLimits(args: {
  duration?: number;
  iterations?: number;
}): Limits {
  const { duration, iterations } = args;
  if (duration == null && iterations == null)
    return { maxTime: defaultDuration * 1000, maxIterations: undefined };
  return {
    maxTime: duration != null ? duration * 1000 : undefined,
    maxIterations: iterations,
  };
}

/** Runner/matrix options shared across all CLI modes. */
function cliCommonOptions(args: DefaultCliArgs) {
  const { warmup } = args;
  const { "gc-force": gcForce, "gc-stats": gcStats } = args;
  const { "trace-opt": traceOpt, "call-counts": callCounts } = args;
  const { "pause-warmup": pauseWarmup, "pause-first": pauseFirst } = args;
  const { "pause-interval": pauseInterval, "pause-duration": pauseDuration } =
    args;
  const { "alloc-interval": allocInterval, "alloc-depth": allocDepth } = args;
  const { "profile-interval": profileInterval } = args;
  return {
    gcForce,
    warmup,
    traceOpt,
    gcStats,
    callCounts,
    pauseWarmup,
    pauseFirst,
    pauseInterval,
    pauseDuration,
    alloc: needsAlloc(args),
    allocInterval,
    allocDepth,
    profile: needsProfile(args),
    profileInterval,
  };
}
