import type { Argv, InferredOptionTypes } from "yargs";
import yargs from "yargs";

export const defaultAdaptiveMaxTime = 20;

export type Configure<T> = (yargs: Argv) => Argv<T>;

/** CLI args type inferred from cliOptions */
export type DefaultCliArgs = InferredOptionTypes<typeof cliOptions>;

// biome-ignore format: compact option definitions
const cliOptions = {
  time:           { type: "number",  default: 0.642, requiresArg: true, describe: "test duration in seconds" },
  cpu:            { type: "boolean", default: false, describe: "CPU counter measurements (requires root)" },
  collect:        { type: "boolean", default: false, describe: "force GC after each iteration" },
  "gc-stats":     { type: "boolean", default: false, describe: "collect GC statistics (Node: --trace-gc-nvp, browser: CDP tracing)" },
  profile:        { type: "boolean", default: false, describe: "run once for profiling" },
  filter:         { type: "string",  requiresArg: true, describe: "filter benchmarks by regex or substring" },
  all:            { type: "boolean", default: false, describe: "run all cases (ignore defaultCases)" },
  worker:         { type: "boolean", default: true, describe: "run in worker process for isolation (default: true)" },
  adaptive:       { type: "boolean", default: false, describe: "adaptive sampling (experimental)" },
  "min-time":     { type: "number",  default: 1, describe: "minimum time before adaptive convergence can stop" },
  convergence:    { type: "number",  default: 95, describe: "adaptive confidence threshold (0-100)" },
  warmup:         { type: "number",  default: 0, describe: "warmup iterations before measurement" },
  html:           { type: "boolean", default: false, describe: "generate HTML report and open in browser" },
  "export-html":  { type: "string",  requiresArg: true, describe: "export HTML report to specified file" },
  json:           { type: "string",  requiresArg: true, describe: "export benchmark data to JSON file" },
  perfetto:       { type: "string",  requiresArg: true, describe: "export Perfetto trace file (view at ui.perfetto.dev)" },
  "trace-opt":    { type: "boolean", default: false, describe: "trace V8 optimization tiers (requires --allow-natives-syntax)" },
  "skip-settle":  { type: "boolean", default: false, describe: "skip post-warmup settle time (see V8 optimization cold start)" },
  "pause-first":  { type: "number",  describe: "iterations before first pause (then pause-interval applies)" },
  "pause-interval": { type: "number", default: 0, describe: "iterations between pauses for V8 optimization (0 to disable)" },
  "pause-duration": { type: "number", default: 100, describe: "pause duration in ms for V8 optimization" },
  batches:          { type: "number",  default: 1, describe: "divide time into N batches, alternating baseline/current order" },
  iterations:       { type: "number",  requiresArg: true, describe: "exact number of iterations (overrides --time)" },
  "heap-sample":    { type: "boolean", default: false, describe: "heap sampling allocation attribution (includes garbage)" },
  "heap-interval":  { type: "number",  default: 32768, describe: "heap sampling interval in bytes" },
  "heap-depth":     { type: "number",  default: 64, describe: "heap sampling stack depth" },
  "heap-rows":      { type: "number",  default: 20, describe: "top allocation sites to show" },
  "heap-stack":     { type: "number",  default: 3, describe: "call stack depth to display" },
  "heap-verbose":   { type: "boolean", default: false, describe: "verbose output with file:// paths and line numbers" },
  "heap-user-only": { type: "boolean", default: false, describe: "filter to user code only (hide node internals)" },
  url:              { type: "string",  requiresArg: true, describe: "page URL for browser profiling (enables browser mode)" },
  headless:         { type: "boolean", default: true, describe: "run browser in headless mode" },
  timeout:          { type: "number",  default: 60, describe: "browser page timeout in seconds" },
  "chrome-args":    { type: "string",  array: true, requiresArg: true, describe: "extra Chromium flags" },
} as const;

/** @return yargs with standard benchmark options */
export function defaultCliArgs(yargsInstance: Argv): Argv<DefaultCliArgs> {
  return yargsInstance.options(cliOptions).help().strict();
}

/** @return parsed command line arguments */
export function parseCliArgs<T = DefaultCliArgs>(
  args: string[],
  configure: Configure<T> = defaultCliArgs as Configure<T>,
): T {
  const yargsInstance = configure(yargs(args));
  return yargsInstance.parseSync() as T;
}
