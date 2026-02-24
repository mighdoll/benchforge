import pico from "picocolors";
import { hideBin } from "yargs/helpers";
import type {
  MatrixResults,
  MatrixSuite,
  RunMatrixOptions,
} from "../BenchMatrix.ts";
import { runMatrix } from "../BenchMatrix.ts";
import type { BenchGroup, BenchmarkSpec, BenchSuite } from "../Benchmark.ts";
import type { BenchmarkReport, ReportGroup } from "../BenchmarkReport.ts";
import { reportResults } from "../BenchmarkReport.ts";
import type { BrowserProfileResult } from "../browser/BrowserHeapSampler.ts";
import { exportBenchmarkJson } from "../export/JsonExport.ts";
import { exportPerfettoTrace } from "../export/PerfettoExport.ts";
import type { GitVersion } from "../GitUtils.ts";
import { prepareHtmlData } from "../HtmlDataPrep.ts";
import {
  aggregateSites,
  filterSites,
  flattenProfile,
  formatHeapReport,
  type HeapReportOptions,
  isBrowserUserCode,
  totalProfileBytes,
} from "../heap-sample/HeapSampleReport.ts";
import { generateHtmlReport } from "../html/index.ts";
import type { MeasuredResults } from "../MeasuredResults.ts";
import { loadCasesModule } from "../matrix/CaseLoader.ts";
import {
  type FilteredMatrix,
  filterMatrix,
  parseMatrixFilter,
} from "../matrix/MatrixFilter.ts";
import {
  type MatrixReportOptions,
  reportMatrixResults,
} from "../matrix/MatrixReport.ts";
import { computeStats } from "../runners/BasicRunner.ts";
import type { RunnerOptions } from "../runners/BenchRunner.ts";
import type { KnownRunner } from "../runners/CreateRunner.ts";
import { runBenchmark } from "../runners/RunnerOrchestrator.ts";
import {
  adaptiveSection,
  browserGcStatsSection,
  cpuSection,
  gcStatsSection,
  optSection,
  runsSection,
  timeSection,
  totalTimeSection,
} from "../StandardSections.ts";
import {
  type Configure,
  type DefaultCliArgs,
  defaultAdaptiveMaxTime,
  parseCliArgs,
} from "./CliArgs.ts";
import { filterBenchmarks } from "./FilterBenchmarks.ts";

/** Validate CLI argument combinations */
function validateArgs(args: DefaultCliArgs): void {
  if (args["gc-stats"] && !args.worker && !args.url) {
    throw new Error(
      "--gc-stats requires worker mode (the default). Remove --no-worker flag.",
    );
  }
}

/** Warn about Node-only flags that are ignored in browser mode. */
function warnBrowserFlags(args: DefaultCliArgs): void {
  const ignored: string[] = [];
  if (!args.worker) ignored.push("--no-worker");
  if (args.cpu) ignored.push("--cpu");
  if (args["trace-opt"]) ignored.push("--trace-opt");
  if (args.collect) ignored.push("--collect");
  if (args.adaptive) ignored.push("--adaptive");
  if (args.batches > 1) ignored.push("--batches");
  if (ignored.length) {
    console.warn(yellow(`Ignored in browser mode: ${ignored.join(", ")}`));
  }
}

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

/** Parse CLI with custom configuration */
export function parseBenchArgs<T = DefaultCliArgs>(
  configureArgs?: Configure<T>,
): T & DefaultCliArgs {
  const argv = hideBin(process.argv);
  return parseCliArgs(argv, configureArgs) as T & DefaultCliArgs;
}

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
  const results: ReportGroup[] = [];
  for (const group of suite.groups) {
    results.push(await runGroup(group, runner, options, useWorker, batches));
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
  const timePerBatch = (runParams.options.maxTime || 5000) / batches;
  const batchParams = {
    ...runParams,
    options: { ...runParams.options, maxTime: timePerBatch },
  };
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

  const meta = runParams.metadata;
  return mergeBatchResults(
    name,
    benchmarks,
    baseline,
    baselineBatches,
    benchmarkBatches,
    meta,
  );
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

/** Run single benchmark and create report */
async function runSingleBenchmark(
  spec: BenchmarkSpec,
  runParams: RunParams,
): Promise<BenchmarkReport> {
  const { runner, options, useWorker, params, metadata } = runParams;
  const benchmarkParams = { spec, runner, options, useWorker, params };
  const [result] = await runBenchmark(benchmarkParams);
  return { name: spec.name, measuredResults: result, metadata };
}

/** Warn if parameterized benchmarks lack setup */
function validateBenchmarkParameters(group: BenchGroup): void {
  const { name, setup, benchmarks, baseline } = group;
  if (setup) return;

  const allBenchmarks = baseline ? [...benchmarks, baseline] : benchmarks;
  for (const benchmark of allBenchmarks) {
    if (benchmark.fn.length > 0) {
      console.warn(
        `Benchmark "${benchmark.name}" in group "${name}" expects parameters but no setup() provided.`,
      );
    }
  }
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
  const allPausePoints = results.flatMap(r => {
    const pts = (r.pausePoints ?? []).map(p => ({
      sampleIndex: p.sampleIndex + offset,
      durationMs: p.durationMs,
    }));
    offset += r.samples.length;
    return pts;
  });

  return {
    name: results[0].name,
    samples: allSamples,
    warmupSamples: allWarmup.length ? allWarmup : undefined,
    time,
    totalTime: results.reduce((sum, r) => sum + (r.totalTime || 0), 0),
    pausePoints: allPausePoints.length ? allPausePoints : undefined,
  };
}

function appendToMap(
  map: Map<string, MeasuredResults[]>,
  key: string,
  value: MeasuredResults,
) {
  if (!map.has(key)) map.set(key, []);
  map.get(key)!.push(value);
}

/** Generate table with standard sections */
export function defaultReport(
  groups: ReportGroup[],
  args: DefaultCliArgs,
): string {
  const { adaptive, "gc-stats": gcStats, "trace-opt": traceOpt } = args;
  const hasCpu = hasField(groups, "cpu");
  const hasOpt = hasField(groups, "optStatus");
  const sections = buildReportSections(
    adaptive,
    gcStats,
    hasCpu,
    traceOpt && hasOpt,
  );
  return reportResults(groups, sections);
}

/** Build report sections based on CLI options */
function buildReportSections(
  adaptive: boolean,
  gcStats: boolean,
  hasCpuData: boolean,
  hasOptData: boolean,
) {
  const sections = adaptive
    ? [adaptiveSection, runsSection, totalTimeSection]
    : [timeSection, runsSection];

  if (gcStats) sections.push(gcStatsSection);
  if (hasCpuData) sections.push(cpuSection);
  if (hasOptData) sections.push(optSection);

  return sections;
}

/** Run benchmarks, display table, and optionally generate HTML report */
export async function benchExports(
  suite: BenchSuite,
  args: DefaultCliArgs,
): Promise<void> {
  const results = await runBenchmarks(suite, args);
  const report = defaultReport(results, args);
  console.log(report);
  await finishReports(results, args, suite.name);
}

/** Run browser profiling via Playwright + CDP, report with standard pipeline */
export async function browserBenchExports(args: DefaultCliArgs): Promise<void> {
  warnBrowserFlags(args);

  let profileBrowser: typeof import("../browser/BrowserHeapSampler.ts").profileBrowser;
  try {
    ({ profileBrowser } = await import("../browser/BrowserHeapSampler.ts"));
  } catch {
    throw new Error(
      "playwright is required for browser benchmarking (--url).\n\n" +
        "Quick start:  npx benchforge-browser --url <your-url>\n\n" +
        "Or install manually:\n" +
        "  npm install playwright\n" +
        "  npx playwright install chromium",
    );
  }

  const url = args.url!;
  const { iterations, time } = args;
  const result = await profileBrowser({
    url,
    heapSample: args["heap-sample"],
    heapOptions: {
      samplingInterval: args["heap-interval"],
      stackDepth: args["heap-depth"],
    },
    headless: args.headless,
    chromeArgs: args["chrome-args"]?.split(/\s+/).filter(Boolean),
    timeout: args.timeout,
    gcStats: args["gc-stats"],
    maxTime: iterations ? Number.MAX_SAFE_INTEGER : time * 1000,
    maxIterations: iterations,
  });

  const name = new URL(url).pathname.split("/").pop() || "browser";
  const hasSamples = result.samples && result.samples.length > 0;
  const results = browserResultGroups(name, result);

  // Time report
  if (hasSamples || result.wallTimeMs != null) {
    console.log(reportResults(results, [timeSection, runsSection]));
  }

  // GC stats table
  if (result.gcStats) {
    console.log(reportResults(results, [browserGcStatsSection]));
  }

  // Heap allocation report
  if (result.heapProfile) {
    printHeapReports(results, {
      ...cliHeapReportOptions(args),
      isUserCode: isBrowserUserCode,
    });
  }

  await exportReports({ results, args });
}

/** Wrap browser profile result as ReportGroup[] for the standard pipeline */
function browserResultGroups(
  name: string,
  result: BrowserProfileResult,
): ReportGroup[] {
  const { gcStats, heapProfile } = result;
  let measured: MeasuredResults;

  // Bench function mode: multiple timing samples with real statistics
  if (result.samples && result.samples.length > 0) {
    const { samples } = result;
    const totalTime = result.wallTimeMs ? result.wallTimeMs / 1000 : undefined;
    measured = {
      name,
      samples,
      time: computeStats(samples),
      totalTime,
      gcStats,
      heapProfile,
    };
  } else {
    // Lap mode: 0 laps = single wall-clock, N laps handled above
    const wallMs = result.wallTimeMs ?? 0;
    const time = {
      min: wallMs,
      max: wallMs,
      avg: wallMs,
      p50: wallMs,
      p75: wallMs,
      p99: wallMs,
      p999: wallMs,
    };
    measured = { name, samples: [wallMs], time, gcStats, heapProfile };
  }

  return [{ name, reports: [{ name, measuredResults: measured }] }];
}

/** Print heap allocation reports for benchmarks with heap profiles */
export function printHeapReports(
  groups: ReportGroup[],
  options: HeapReportOptions,
): void {
  for (const group of groups) {
    const allReports = group.baseline
      ? [...group.reports, group.baseline]
      : group.reports;

    for (const report of allReports) {
      const { heapProfile } = report.measuredResults;
      if (!heapProfile) continue;

      console.log(dim(`\n─── Heap profile: ${report.name} ───`));
      const totalAll = totalProfileBytes(heapProfile);
      const sites = flattenProfile(heapProfile);
      const userSites = filterSites(sites, options.isUserCode);
      const totalUserCode = userSites.reduce((sum, s) => sum + s.bytes, 0);
      const aggregated = aggregateSites(options.userOnly ? userSites : sites);
      const extra = {
        totalAll,
        totalUserCode,
        sampleCount: heapProfile.samples?.length,
      };
      console.log(formatHeapReport(aggregated, { ...options, ...extra }));
    }
  }
}

/** Run benchmarks and display table. Suite is optional with --url (browser mode). */
export async function runDefaultBench(
  suite?: BenchSuite,
  configureArgs?: Configure<any>,
): Promise<void> {
  const args = parseBenchArgs(configureArgs);
  if (args.url) {
    await browserBenchExports(args);
  } else if (suite) {
    await benchExports(suite, args);
  } else {
    throw new Error("Either --url or a BenchSuite is required.");
  }
}

/** Convert CLI args to runner options */
export function cliToRunnerOptions(args: DefaultCliArgs): RunnerOptions {
  const { profile, collect, iterations } = args;
  if (profile)
    return { maxIterations: iterations ?? 1, warmupTime: 0, collect };
  if (args.adaptive) return createAdaptiveOptions(args);

  return {
    maxTime: iterations ? Number.POSITIVE_INFINITY : args.time * 1000,
    maxIterations: iterations,
    ...cliCommonOptions(args),
  };
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
  const { collect, cpu, warmup } = args;
  const { "trace-opt": traceOpt, "skip-settle": noSettle } = args;
  const { "pause-first": pauseFirst, "pause-interval": pauseInterval } = args;
  const { "pause-duration": pauseDuration, "gc-stats": gcStats } = args;
  const { "heap-sample": heapSample, "heap-interval": heapInterval } = args;
  const { "heap-depth": heapDepth } = args;
  return {
    collect,
    cpuCounters: cpu,
    warmup,
    traceOpt,
    noSettle,
    pauseFirst,
    pauseInterval,
    pauseDuration,
    gcStats,
    heapSample,
    heapInterval,
    heapDepth,
  };
}

const isTest = process.env.NODE_ENV === "test" || process.env.VITEST === "true";
const { yellow, dim } = isTest
  ? { yellow: (s: string) => s, dim: (s: string) => s }
  : pico;

/** Log V8 optimization tier distribution and deoptimizations */
export function reportOptStatus(groups: ReportGroup[]): void {
  const optData = groups.flatMap(({ reports, baseline }) => {
    const all = baseline ? [...reports, baseline] : reports;
    return all
      .filter(r => r.measuredResults.optStatus)
      .map(r => ({
        name: r.name,
        opt: r.measuredResults.optStatus!,
        samples: r.measuredResults.samples.length,
      }));
  });
  if (optData.length === 0) return;

  console.log(dim("\nV8 optimization:"));
  for (const { name, opt, samples } of optData) {
    const total = Object.values(opt.byTier).reduce((s, t) => s + t.count, 0);
    const tierParts = Object.entries(opt.byTier)
      .sort((a, b) => b[1].count - a[1].count)
      .map(
        ([tier, info]) => `${tier} ${((info.count / total) * 100).toFixed(0)}%`,
      )
      .join(", ");
    console.log(`  ${name}: ${tierParts} ${dim(`(${samples} samples)`)}`);
  }

  const totalDeopts = optData.reduce((s, d) => s + d.opt.deoptCount, 0);
  if (totalDeopts > 0) {
    console.log(
      yellow(
        `  ⚠ ${totalDeopts} deoptimization${totalDeopts > 1 ? "s" : ""} detected`,
      ),
    );
  }
}

/** @return true if any result has the specified field with a defined value */
export function hasField(
  results: ReportGroup[],
  field: keyof MeasuredResults,
): boolean {
  return results.some(({ reports, baseline }) => {
    const all = baseline ? [...reports, baseline] : reports;
    return all.some(
      ({ measuredResults }) => measuredResults[field] !== undefined,
    );
  });
}

export interface ExportOptions {
  results: ReportGroup[];
  args: DefaultCliArgs;
  sections?: any[];
  suiteName?: string;
  currentVersion?: GitVersion;
  baselineVersion?: GitVersion;
}

/** Print heap reports (if enabled) and export results */
async function finishReports(
  results: ReportGroup[],
  args: DefaultCliArgs,
  suiteName?: string,
  exportOptions?: MatrixExportOptions,
): Promise<void> {
  if (args["heap-sample"]) {
    printHeapReports(results, cliHeapReportOptions(args));
  }
  await exportReports({ results, args, suiteName, ...exportOptions });
}

/** Export reports (HTML, JSON, Perfetto) based on CLI args */
export async function exportReports(options: ExportOptions): Promise<void> {
  const { results, args, sections, suiteName } = options;
  const { currentVersion, baselineVersion } = options;
  const openInBrowser = args.html && !args["export-html"];
  let closeServer: (() => void) | undefined;

  if (args.html || args["export-html"]) {
    const htmlOpts = {
      cliArgs: args,
      sections,
      currentVersion,
      baselineVersion,
    };
    const reportData = prepareHtmlData(results, htmlOpts);
    const result = await generateHtmlReport(reportData, {
      openBrowser: openInBrowser,
      outputPath: args["export-html"],
    });
    closeServer = result.closeServer;
  }

  if (args.json) {
    await exportBenchmarkJson(results, args.json, args, suiteName);
  }

  if (args.perfetto) {
    exportPerfettoTrace(results, args.perfetto, args);
  }

  // Keep process running when HTML report is opened in browser
  if (openInBrowser) {
    await waitForCtrlC();
    closeServer?.();
  }
}

/** Wait for Ctrl+C before exiting */
function waitForCtrlC(): Promise<void> {
  return new Promise(resolve => {
    console.log(dim("\nPress Ctrl+C to exit"));
    process.on("SIGINT", () => {
      console.log();
      resolve();
    });
  });
}

/** Run matrix suite with CLI arguments.
 *  no options ==> defaultCases/defaultVariants, --filter ==> subset of defaults,
 *  --all --filter ==> subset of all, --all ==> all cases/variants */
export async function runMatrixSuite(
  suite: MatrixSuite,
  args: DefaultCliArgs,
): Promise<MatrixResults[]> {
  validateArgs(args);
  const filter = args.filter ? parseMatrixFilter(args.filter) : undefined;
  const options = cliToMatrixOptions(args);

  const results: MatrixResults[] = [];
  for (const matrix of suite.matrices) {
    const casesModule = matrix.casesModule
      ? await loadCasesModule(matrix.casesModule)
      : undefined;

    let filtered: FilteredMatrix<any> = matrix;
    if (!args.all && casesModule) {
      filtered = {
        ...matrix,
        filteredCases: casesModule.defaultCases,
        filteredVariants: casesModule.defaultVariants,
      };
    }

    // filter merges via intersection with defaults
    if (filter) {
      filtered = await filterMatrix(filtered, filter);
    }

    const { filteredCases, filteredVariants } = filtered;
    results.push(
      await runMatrix(filtered, {
        ...options,
        filteredCases,
        filteredVariants,
      }),
    );
  }
  return results;
}

/** Convert CLI args to matrix run options */
export function cliToMatrixOptions(args: DefaultCliArgs): RunMatrixOptions {
  const { time, iterations, worker } = args;
  return {
    iterations,
    maxTime: iterations ? undefined : time * 1000,
    useWorker: worker,
    ...cliCommonOptions(args),
  };
}

/** Generate report for matrix results. Uses same sections as regular benchmarks. */
export function defaultMatrixReport(
  results: MatrixResults[],
  reportOptions?: MatrixReportOptions,
  args?: DefaultCliArgs,
): string {
  const options = args
    ? mergeMatrixDefaults(reportOptions, args, results)
    : reportOptions;
  return results.map(r => reportMatrixResults(r, options)).join("\n\n");
}

/** @return HeapReportOptions from CLI args */
function cliHeapReportOptions(args: DefaultCliArgs): HeapReportOptions {
  return {
    topN: args["heap-rows"],
    stackDepth: args["heap-stack"],
    verbose: args["heap-verbose"],
    userOnly: args["heap-user-only"],
  };
}

/** Apply default sections and extra columns for matrix reports */
function mergeMatrixDefaults(
  reportOptions: MatrixReportOptions | undefined,
  args: DefaultCliArgs,
  results: MatrixResults[],
): MatrixReportOptions {
  const result: MatrixReportOptions = { ...reportOptions };

  if (!result.sections?.length) {
    const groups = matrixToReportGroups(results);
    result.sections = buildReportSections(
      args.adaptive,
      args["gc-stats"],
      hasField(groups, "cpu"),
      args["trace-opt"] && hasField(groups, "optStatus"),
    );
  }

  return result;
}

/** Run matrix suite with full CLI handling (parse, run, report, export) */
export async function runDefaultMatrixBench(
  suite: MatrixSuite,
  configureArgs?: Configure<any>,
  reportOptions?: MatrixReportOptions,
): Promise<void> {
  const args = parseBenchArgs(configureArgs);
  await matrixBenchExports(suite, args, reportOptions);
}

/** Convert MatrixResults to ReportGroup[] for export compatibility */
export function matrixToReportGroups(results: MatrixResults[]): ReportGroup[] {
  return results.flatMap(matrix =>
    matrix.variants.flatMap(variant =>
      variant.cases.map(c => {
        const { metadata } = c;
        const report = {
          name: variant.id,
          measuredResults: c.measured,
          metadata,
        };
        const baseline = c.baseline
          ? {
              name: `${variant.id} (baseline)`,
              measuredResults: c.baseline,
              metadata,
            }
          : undefined;
        return {
          name: `${variant.id} / ${c.caseId}`,
          reports: [report],
          baseline,
        };
      }),
    ),
  );
}

export interface MatrixExportOptions {
  sections?: any[];
  currentVersion?: GitVersion;
  baselineVersion?: GitVersion;
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

/** Run matrix benchmarks, display table, and generate exports */
export async function matrixBenchExports(
  suite: MatrixSuite,
  args: DefaultCliArgs,
  reportOptions?: MatrixReportOptions,
  exportOptions?: MatrixExportOptions,
): Promise<void> {
  const results = await runMatrixSuite(suite, args);
  const report = defaultMatrixReport(results, reportOptions, args);
  console.log(report);

  const reportGroups = matrixToReportGroups(results);
  await finishReports(reportGroups, args, suite.name, exportOptions);
}
