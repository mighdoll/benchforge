import type { Argv, InferredOptionTypes } from "yargs";
import yargs from "yargs";

export type Configure<T> = (yargs: Argv) => Argv<T>;

/** CLI args type inferred from cliOptions, plus optional file positional. */
export type DefaultCliArgs = InferredOptionTypes<typeof cliOptions> & {
  file?: string;
};

export const defaultAdaptiveMaxTime = 20;

// biome-ignore format: compact option definitions
const cliOptions = {
  duration:         { type: "number",  default: 0.642, requiresArg: true, describe: "duration per batch in seconds" },
  iterations:       { type: "number",  requiresArg: true, describe: "exact iterations per batch (overrides --duration)" },
  warmup:           { type: "number",  default: 0, describe: "warmup iterations before measurement" },
  filter:           { type: "string",  requiresArg: true, describe: "filter by name/regex. Matrix: case/variant, case/, /variant" },
  all:              { type: "boolean", default: false, describe: "run all cases (ignore defaultCases)" },
  list:             { type: "boolean", default: false, describe: "list available benchmarks (or matrix cases/variants)" },
  worker:           { type: "boolean", default: true, describe: "run in worker process for isolation (default: true)" },
  batches:          { type: "number",  default: 1, describe: "divide time into N batches, alternating baseline/current order" },
  "warmup-batch":   { type: "boolean", default: false, describe: "include first batch in results (normally dropped to avoid OS cache warmup)" },
  "equiv-margin":   { type: "number",  default: 2, describe: "equivalence margin % for baseline comparison (0 to disable)" },
  "no-batch-trim":  { type: "boolean", default: false, describe: "disable Tukey trimming of outlier batches" },
  "pause-first":    { type: "number",  describe: "iterations before first pause (then pause-interval applies)" },
  "pause-interval": { type: "number", default: 0, describe: "iterations between pauses for V8 optimization (0 to disable)" },
  "pause-duration": { type: "number", default: 100, describe: "pause duration in ms for V8 optimization" },
  "gc-stats":       { type: "boolean", default: false, describe: "collect GC statistics (Node: --trace-gc-nvp, browser: CDP tracing)" },
  "gc-force":       { type: "boolean", default: false, describe: "force GC after each iteration" },
  adaptive:         { type: "boolean", default: false, describe: "adaptive sampling (experimental)" },
  "min-time":       { type: "number",  default: 1, describe: "minimum time before adaptive convergence can stop" },
  convergence:      { type: "number",  default: 95, describe: "adaptive confidence threshold (0-100)" },
  alloc:            { type: "boolean", default: false, describe: "allocation sampling attribution (includes garbage)" },
  "alloc-interval": { type: "number",  default: 32768, describe: "allocation sampling interval in bytes" },
  "alloc-depth":    { type: "number",  default: 64, describe: "allocation sampling stack depth" },
  "alloc-rows":     { type: "number",  default: 20, describe: "top allocation sites to show" },
  "alloc-stack":    { type: "number",  default: 3, describe: "call stack depth to display" },
  "alloc-verbose":  { type: "boolean", default: false, describe: "verbose output with file:// paths and line numbers" },
  "alloc-raw":      { type: "boolean", default: false, describe: "dump every raw allocation sample (ordinal, size, stack)" },
  "alloc-user-only":{ type: "boolean", default: false, describe: "filter to user code only (hide node internals)" },
  "time-sample":    { type: "boolean", default: false, describe: "V8 CPU time sampling profiler" },
  "time-interval":  { type: "number",  default: 1000, describe: "CPU sampling interval in microseconds" },
  "call-counts":    { type: "boolean", default: false, describe: "collect per-function execution counts via V8 precise coverage" },
  view:             { type: "boolean", default: false, describe: "open viewer in browser" },
  "export-json":    { type: "string",  requiresArg: true, describe: "export benchmark data to JSON file" },
  "export-perfetto":{ type: "string",  requiresArg: true, describe: "export Perfetto trace file (view at ui.perfetto.dev)" },
  "export-time":    { type: "string",  requiresArg: true, describe: "export time profile as .cpuprofile (V8/Chrome DevTools format)" },
  archive:          { type: "string",  describe: "archive profile + sources to .benchforge file" },
  editor:           { type: "string",  default: "vscode", describe: "editor for source links: vscode, cursor, or custom://scheme" },
  inspect:          { type: "boolean", default: false, describe: "run once for external profiler attach" },
  "trace-opt":      { type: "boolean", default: false, describe: "trace V8 optimization tiers (requires --allow-natives-syntax)" },
  "skip-settle":    { type: "boolean", default: false, describe: "skip post-warmup settle time (see V8 optimization cold start)" },
  url:              { type: "string",  requiresArg: true, describe: "page URL for browser profiling (enables browser mode)" },
  "page-load":      { type: "boolean", default: false, describe: "passive page-load profiling (no __bench/__start needed)" },
  "wait-for":       { type: "string",  requiresArg: true, describe: "page-load completion: CSS selector, JS expression, 'load', or 'domcontentloaded'" },
  headless:         { type: "boolean", default: false, describe: "run browser in headless mode (default: headed)" },
  timeout:          { type: "number",  default: 60, describe: "browser page timeout in seconds" },
  chrome:           { type: "string",  requiresArg: true, describe: "Chrome binary path (default: auto-detect or CHROME_PATH)" },
  "chrome-profile": { type: "string",  requiresArg: true, describe: "Chrome user profile directory (default: temp profile)" },
  "chrome-args":    { type: "string",  array: true, requiresArg: true, describe: "extra Chromium flags" },
} as const;

const optionGroups = {
  "Benchmark:": [
    "duration",
    "iterations",
    "warmup",
    "filter",
    "all",
    "list",
    "worker",
    "batches",
    "warmup-batch",
    "equiv-margin",
    "pause-first",
    "pause-interval",
    "pause-duration",
  ],
  "GC:": ["gc-stats", "gc-force"],
  "Adaptive:": ["adaptive", "min-time", "convergence"],
  "Allocation:": [
    "alloc",
    "alloc-interval",
    "alloc-depth",
    "alloc-rows",
    "alloc-stack",
    "alloc-verbose",
    "alloc-raw",
    "alloc-user-only",
  ],
  "Time Sample:": ["time-sample", "time-interval"],
  "Coverage:": ["call-counts"],
  "Output:": [
    "view",
    "export-json",
    "export-perfetto",
    "export-time",
    "archive",
    "editor",
  ],
  "Browser:": [
    "url",
    "page-load",
    "wait-for",
    "headless",
    "timeout",
    "chrome",
    "chrome-profile",
    "chrome-args",
  ],
  "Advanced:": ["inspect", "trace-opt", "skip-settle"],
} as const;

const { url: _url, ...browserOnlyOptions } = cliOptions;

/** Configure yargs for browser benchmarking with url as a required positional. */
export function browserCliArgs(yargsInstance: Argv): Argv<DefaultCliArgs> {
  return applyGroups(
    yargsInstance
      .command("$0 <url>", "run browser benchmarks", y => {
        y.positional("url", {
          type: "string",
          describe: "page URL for browser profiling",
        });
      })
      .options(browserOnlyOptions)
      .help()
      .strict(),
  ) as Argv<DefaultCliArgs>;
}

/** Configure yargs with standard benchmark options and file positional. */
export function defaultCliArgs(yargsInstance: Argv): Argv<DefaultCliArgs> {
  return applyGroups(
    yargsInstance
      .command("$0 [file]", "run benchmarks", y => {
        y.positional("file", {
          type: "string",
          describe: "benchmark file to run",
        });
      })
      .options(cliOptions)
      .help()
      .strict(),
  ) as Argv<DefaultCliArgs>;
}

/** Parse command line arguments with optional custom yargs configuration. */
export function parseCliArgs<T = DefaultCliArgs>(
  args: string[],
  configure: Configure<T> = defaultCliArgs as Configure<T>,
): T {
  const yargsInstance = configure(yargs(args));
  return yargsInstance.parseSync() as T;
}

/** Strip yargs internals (`_`, `$0`) and undefined values, converting kebab-case to camelCase. */
export function cleanCliArgs(args: DefaultCliArgs): Record<string, unknown> {
  const skip = new Set(["_", "$0"]);
  const toCamel = (k: string) =>
    k.replace(/-([a-z])/g, (_, l: string) => l.toUpperCase());
  return Object.fromEntries(
    Object.entries(args)
      .filter(([k, v]) => v !== undefined && v !== null && !skip.has(k))
      .map(([k, v]) => [toCamel(k), v]),
  );
}

/** Assign options to their labeled groups in yargs help output. */
function applyGroups(y: Argv): Argv {
  return Object.entries(optionGroups).reduce(
    (acc, [label, keys]) => acc.group(keys as unknown as string[], label),
    y,
  );
}
