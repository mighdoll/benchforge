import type { RunMatrixOptions } from "../matrix/BenchMatrix.ts";
import type { HeapReportOptions } from "../profiling/node/HeapSampleReport.ts";
import type { RunnerOptions } from "../runners/BenchRunner.ts";
import { type DefaultCliArgs, defaultAdaptiveMaxTime } from "./CliArgs.ts";

/** Validate CLI argument combinations */
export function validateArgs(args: DefaultCliArgs): void {
  if (args["gc-stats"] && !args.worker && !args.url) {
    throw new Error(
      "--gc-stats requires worker mode (the default). Remove --no-worker flag.",
    );
  }
}

/** Convert CLI args to runner options */
export function cliToRunnerOptions(args: DefaultCliArgs): RunnerOptions {
  const { inspect, iterations } = args;
  const gcForce = args["gc-force"];
  if (inspect)
    return { maxIterations: iterations ?? 1, warmupTime: 0, gcForce };
  if (args.adaptive) return createAdaptiveOptions(args);

  return {
    maxTime: iterations ? Number.POSITIVE_INFINITY : args.duration * 1000,
    maxIterations: iterations,
    ...cliCommonOptions(args),
  };
}

/** Convert CLI args to matrix run options */
export function cliToMatrixOptions(args: DefaultCliArgs): RunMatrixOptions {
  const { duration, iterations, worker } = args;
  return {
    iterations,
    maxTime: iterations ? undefined : duration * 1000,
    useWorker: worker,
    ...cliCommonOptions(args),
  };
}

/** @return HeapReportOptions from CLI args */
export function cliHeapReportOptions(args: DefaultCliArgs): HeapReportOptions {
  return {
    topN: args["alloc-rows"],
    stackDepth: args["alloc-stack"],
    verbose: args["alloc-verbose"],
    raw: args["alloc-raw"],
    userOnly: args["alloc-user-only"],
  };
}

/** @return true if any alloc-related flag implies allocation sampling */
export function needsAlloc(args: DefaultCliArgs): boolean {
  return (
    args.alloc ||
    args.archive != null ||
    args["alloc-raw"] ||
    args["alloc-verbose"] ||
    args["alloc-user-only"]
  );
}

/** @return true if time sampling should be enabled */
export function needsTimeSample(args: DefaultCliArgs): boolean {
  return args["time-sample"] || !!args["export-time"];
}

/** Create options for adaptive mode */
function createAdaptiveOptions(args: DefaultCliArgs): RunnerOptions {
  return {
    minTime: (args["min-time"] ?? 1) * 1000,
    maxTime: defaultAdaptiveMaxTime * 1000,
    targetConfidence: args.convergence,
    adaptive: true,
    ...cliCommonOptions(args),
  } as any;
}

/** Runner/matrix options shared across all CLI modes */
function cliCommonOptions(args: DefaultCliArgs) {
  const { warmup } = args;
  const { "gc-force": gcForce, "gc-stats": gcStats } = args;
  const { "trace-opt": traceOpt, "skip-settle": noSettle } = args;
  const { "pause-first": pauseFirst, "pause-interval": pauseInterval } = args;
  const { "pause-duration": pauseDuration } = args;
  const { "alloc-interval": allocInterval, "alloc-depth": allocDepth } = args;
  const { "time-interval": timeInterval, "call-counts": callCounts } = args;
  const alloc = needsAlloc(args);
  const timeSample = needsTimeSample(args);
  return {
    gcForce,
    warmup,
    traceOpt,
    noSettle,
    pauseFirst,
    pauseInterval,
    pauseDuration,
    gcStats,
    alloc,
    allocInterval,
    allocDepth,
    timeSample,
    timeInterval,
    callCounts,
  };
}
