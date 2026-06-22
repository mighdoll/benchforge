import type { RunMatrixOptions } from "../matrix/BenchMatrix.ts";
import type { HeapReportOptions } from "../profiling/node/HeapSampleReport.ts";
import type { ComparisonOptions } from "../report/BenchmarkReport.ts";
import { type DefaultCliArgs, defaultDuration } from "./CliArgs.ts";

/** Runner limits resolved from the duration/iterations flags. */
type Limits = {
  maxTime: number | undefined;
  maxIterations: number | undefined;
};

/** Convert CLI args to matrix runner options. */
export function cliToMatrixOptions(args: DefaultCliArgs): RunMatrixOptions {
  const { iterations, worker, batches } = args;
  const common = cliCommonOptions(args);
  // --inspect: one iteration, no warmup, single batch (no time budget), run
  // in-process so an attached profiler sees the benchmark itself rather than the
  // orchestrator that would otherwise fork it into an un-inspected worker.
  if (args.inspect)
    return {
      ...common,
      iterations: iterations ?? 1,
      useWorker: false,
      batches: 1,
      warmup: 0,
    };
  return {
    iterations,
    maxTime: resolveLimits(args).maxTime,
    useWorker: worker,
    batches,
    warmupBatch: args["warmup-batch"],
    calibrate: args.calibrate,
    calibrateRuns: args["calibrate-runs"],
    ...common,
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

/** Whether to launch the viewer: --view-serve or explicit --view wins; else default on for interactive terminals. */
export function shouldViewReport(args: DefaultCliArgs): boolean {
  if (args["view-serve"]) return true;
  return args.view ?? interactiveSession();
}

/** A human is watching: stdout is a real terminal and we are not in CI. */
function interactiveSession(): boolean {
  return !!process.stdout.isTTY && !process.env.CI;
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
  const { "call-counts": callCounts } = args;
  const { "pause-warmup": pauseWarmup, "pause-first": pauseFirst } = args;
  const { "pause-interval": pauseInterval, "pause-duration": pauseDuration } =
    args;
  const { "alloc-interval": allocInterval, "alloc-depth": allocDepth } = args;
  const { "profile-interval": profileInterval } = args;
  return {
    gcForce,
    warmup,
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
