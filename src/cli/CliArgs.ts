import type { Argv, InferredOptionTypes } from "yargs";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import pkg from "../../package.json" with { type: "json" };

export type Configure<T> = (yargs: Argv) => Argv<T>;

/** CLI args type inferred from cliOptions, plus optional file positional. */
export type DefaultCliArgs = InferredOptionTypes<typeof cliOptions> & {
  file?: string;
};

// biome-ignore format: compact option definitions
const cliOptions = {
  duration:         { type: "number",  requiresArg: true, describe: "duration per batch in seconds (default: 0.642)" },
  iterations:       { type: "number",  requiresArg: true, describe: "iterations per batch (page loads for page-load mode, inner loop for bench)" },
  warmup:           { type: "number",  default: 0, describe: "warmup iterations before measurement" },
  filter:           { type: "string",  requiresArg: true, describe: "filter by name/regex. Matrix: case/variant, case/, /variant" },
  all:              { type: "boolean", default: false, describe: "run all cases (ignore defaultCases)" },
  list:             { type: "boolean", default: false, describe: "list available benchmarks (or matrix cases/variants)" },
  worker:           { type: "boolean", default: true, describe: "run in worker process for isolation (default: true)" },
  batches:          { type: "number",  default: 1, describe: "divide time into N batches, alternating baseline/current order" },
  "warmup-batch":   { type: "boolean", default: false, describe: "include first batch in results (normally dropped to avoid OS cache warmup)" },
  "equiv-margin":   { type: "number",  default: 2, describe: "equivalence margin % for baseline comparison (0 to disable)" },
  "no-batch-trim":  { type: "boolean", default: false, describe: "disable Tukey trimming of outlier batches" },
  calibrate:        { type: "boolean", default: false, describe: "measure noise floor: run current-vs-current N times, suggest --equiv-margin" },
  "calibrate-runs": { type: "number",  default: 15, describe: "number of self-comparison repetitions for --calibrate" },
  "pause-first":    { type: "number",  describe: "iterations before first pause (then pause-interval applies)" },
  "pause-interval": { type: "number", default: 0, describe: "iterations between pauses for V8 optimization (0 to disable)" },
  "pause-duration": { type: "number", default: 100, describe: "pause duration in ms for V8 optimization" },
  "gc-stats":       { type: "boolean", default: false, describe: "collect GC statistics (Node: --trace-gc-nvp, browser: CDP tracing)" },
  "gc-force":       { type: "boolean", default: false, describe: "force GC after each iteration" },
  alloc:            { type: "boolean", default: false, describe: "allocation sampling attribution (includes garbage)" },
  "alloc-interval": { type: "number",  default: 32768, describe: "allocation sampling interval in bytes" },
  "alloc-depth":    { type: "number",  default: 64, describe: "allocation sampling stack depth" },
  "alloc-rows":     { type: "number",  default: 20, describe: "top allocation sites to show" },
  "alloc-stack":    { type: "number",  default: 3, describe: "call stack depth to display" },
  "alloc-verbose":  { type: "boolean", default: false, describe: "verbose output with file:// paths and line numbers" },
  "alloc-raw":      { type: "boolean", default: false, describe: "dump every raw allocation sample (ordinal, size, stack)" },
  "alloc-user-only":{ type: "boolean", default: false, describe: "filter to user code only (hide node internals)" },
  profile:          { type: "boolean", default: false, alias: "time-sample", describe: "V8 CPU time sampling profiler" },
  "profile-interval":{ type: "number", default: 1000, alias: "time-interval", describe: "CPU sampling interval in microseconds" },
  "profile-rows":   { type: "number",  default: 20, describe: "top CPU self-time functions to show" },
  "profile-user-only":{ type: "boolean", default: false, describe: "filter to user code only (hide node internals)" },
  "call-counts":    { type: "boolean", default: false, describe: "collect per-function execution counts via V8 precise coverage" },
  view:             { type: "boolean", alias: "html", describe: "open viewer in browser (default: on for interactive terminals; use --no-view to disable)" },
  "view-serve":     { type: "boolean", default: false, describe: "start viewer server without opening browser (reload an existing tab)" },
  "export-perfetto":{ type: "string",  requiresArg: true, describe: "export Perfetto trace file (view at ui.perfetto.dev)" },
  "export-profile": { type: "string",  requiresArg: true, alias: "export-time", describe: "export CPU profile as .cpuprofile (V8/Chrome DevTools format)" },
  archive:          { type: "string",  describe: "archive profile + sources to .benchforge file" },
  "report-md":      { type: "string",  requiresArg: true, describe: "markdown report path (default: bench-report/latest.md + timestamped copy; always written)" },
  editor:           { type: "string",  default: "vscode", describe: "editor for source links: vscode, cursor, or custom://scheme" },
  inspect:          { type: "boolean", default: false, describe: "run once for external profiler attach" },
  "pause-warmup":   { type: "number",  default: 0, requiresArg: true, describe: "post-warmup settle time in ms for V8 background compilation (0 to skip)" },
  url:              { type: "string",  requiresArg: true, describe: "page URL for browser profiling (enables browser mode)" },
  "page-load":      { type: "boolean", default: false, describe: "passive page-load profiling (no __bench needed)" },
  "wait-for":       { type: "string",  requiresArg: true, describe: "page-load completion: CSS selector, JS expression, 'load', or 'domcontentloaded'" },
  headless:         { type: "boolean", default: false, describe: "run browser in headless mode (default: headed)" },
  timeout:          { type: "number",  default: 60, describe: "browser page timeout in seconds" },
  chrome:           { type: "string",  requiresArg: true, describe: "Chrome binary path (default: auto-detect or CHROME_PATH)" },
  "chrome-profile": { type: "string",  requiresArg: true, describe: "Chrome user profile directory (default: temp profile)" },
  "baseline-url":   { type: "string",  requiresArg: true, describe: "baseline URL for A/B comparison (fresh tab per batch)" },
  "chrome-args":    { type: "string",  array: true, requiresArg: true, describe: "extra Chromium flags" },
} as const;

export const defaultDuration = 0.642;

/** Default values for all CLI options, including alias keys for yargs filtering. */
export const cliDefaults: Record<string, unknown> = Object.fromEntries(
  Object.entries(cliOptions)
    .filter(([, opt]) => "default" in opt)
    .flatMap(([key, opt]) => {
      const o = opt as Record<string, unknown>;
      const entries: [string, unknown][] = [[key, o.default]];
      if (o.alias) entries.push([o.alias as string, o.default]);
      return entries;
    }),
);

const optionGroups = {
  "Run:": ["duration", "iterations"],
  "Batching:": ["batches", "warmup-batch", "no-batch-trim"],
  "Calibration:": ["calibrate", "calibrate-runs"],
  "Node:": ["worker", "inspect"],
  "Browser:": [
    "url",
    "baseline-url",
    "page-load",
    "wait-for",
    "headless",
    "timeout",
    "chrome",
    "chrome-profile",
    "chrome-args",
  ],
  "GC:": ["gc-stats", "gc-force"],
  "Allocation Profiling:": [
    "alloc",
    "alloc-interval",
    "alloc-depth",
    "alloc-rows",
    "alloc-stack",
    "alloc-verbose",
    "alloc-raw",
    "alloc-user-only",
  ],
  "CPU Profiling:": [
    "profile",
    "profile-interval",
    "profile-rows",
    "profile-user-only",
    "call-counts",
  ],
  "Output:": [
    "view",
    "view-serve",
    "equiv-margin",
    "archive",
    "report-md",
    "export-perfetto",
    "export-profile",
    "editor",
  ],
  "Selecting Benchmarks:": ["filter", "all", "list"],
  "V8 Tuning:": [
    "warmup",
    "pause-first",
    "pause-interval",
    "pause-duration",
    "pause-warmup",
  ],
} as const;

/** Parse command line arguments with optional custom yargs configuration. */
export function parseCliArgs<T = DefaultCliArgs>(
  configure: Configure<T> = defaultCliArgs as Configure<T>,
  args: string[] = hideBin(process.argv),
): T {
  return configure(yargs(args)).parseSync() as T;
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
      .version(pkg.version)
      .help()
      .strict(),
  ) as Argv<DefaultCliArgs>;
}

/** Strip yargs internals (`_`, `$0`) and undefined values, converting kebab-case to camelCase. */
export function cleanCliArgs(args: DefaultCliArgs): Record<string, unknown> {
  const skip = new Set(["_", "$0"]);
  const camel = (k: string) =>
    k.replace(/-([a-z])/g, (_, l: string) => l.toUpperCase());
  return Object.fromEntries(
    Object.entries(args)
      .filter(([k, v]) => v !== undefined && v !== null && !skip.has(k))
      .map(([k, v]) => [camel(k), v]),
  );
}

/** Assign options to their labeled groups in yargs help output. */
function applyGroups(y: Argv): Argv {
  return Object.entries(optionGroups).reduce(
    (acc, [label, keys]) => acc.group(keys as unknown as string[], label),
    y,
  );
}
