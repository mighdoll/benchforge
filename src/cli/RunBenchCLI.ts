import { writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import pico from "picocolors";
import { hideBin } from "yargs/helpers";
import type {
  BenchGroup,
  BenchmarkSpec,
  BenchSuite,
} from "../core/Benchmark.ts";
import type { MeasuredResults } from "../core/MeasuredResults.ts";
import {
  archiveBenchmark,
  buildSpeedscopeFile,
  collectSources,
} from "../export/AllocExport.ts";
import {
  annotateFramesWithCounts,
  buildCoverageMap,
} from "../export/CoverageExport.ts";
import { resolveEditorUri } from "../export/EditorUri.ts";
import { exportBenchmarkJson } from "../export/JsonExport.ts";
import { exportPerfettoTrace } from "../export/PerfettoExport.ts";
import { buildTimeSpeedscopeFile } from "../export/TimeExport.ts";
import type {
  MatrixResults,
  MatrixSuite,
  RunMatrixOptions,
} from "../matrix/BenchMatrix.ts";
import { runMatrix } from "../matrix/BenchMatrix.ts";
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
import type { BrowserProfileResult } from "../profiling/browser/BrowserProfiler.ts";
import {
  aggregateSites,
  filterSites,
  flattenProfile,
  formatHeapReport,
  formatRawSamples,
  type HeapReportOptions,
  isBrowserUserCode,
} from "../profiling/node/HeapSampleReport.ts";
import { resolveProfile } from "../profiling/node/ResolvedProfile.ts";
import type {
  BenchmarkReport,
  ReportGroup,
  ResultsMapper,
} from "../report/BenchmarkReport.ts";
import { groupReports, reportResults } from "../report/BenchmarkReport.ts";
import type { GitVersion } from "../report/GitUtils.ts";
import { prepareHtmlData } from "../report/HtmlDataPrep.ts";
import {
  adaptiveSection,
  browserGcStatsSection,
  gcStatsSection,
  optSection,
  runsSection,
  timeSection,
  totalTimeSection,
} from "../report/StandardSections.ts";
import { computeStats } from "../runners/BasicRunner.ts";
import type { RunnerOptions } from "../runners/BenchRunner.ts";
import type { KnownRunner } from "../runners/CreateRunner.ts";
import { runBenchmark } from "../runners/RunnerOrchestrator.ts";
import { startViewerServer } from "../viewer/ViewerServer.ts";
import type { ReportData } from "../viewer/ReportData.ts";
import {
  type Configure,
  type DefaultCliArgs,
  defaultAdaptiveMaxTime,
  parseCliArgs,
} from "./CliArgs.ts";
import { filterBenchmarks } from "./FilterBenchmarks.ts";

export interface ExportOptions {
  results: ReportGroup[];
  args: DefaultCliArgs;
  sections?: any[];
  suiteName?: string;
  currentVersion?: GitVersion;
  baselineVersion?: GitVersion;
}

export interface MatrixExportOptions {
  sections?: any[];
  currentVersion?: GitVersion;
  baselineVersion?: GitVersion;
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

const isTest = process.env.NODE_ENV === "test" || process.env.VITEST === "true";
const { yellow, dim } = isTest
  ? { yellow: (s: string) => s, dim: (s: string) => s }
  : pico;

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

/** Generate table with standard sections */
export function defaultReport(
  groups: ReportGroup[],
  args: DefaultCliArgs,
): string {
  const { adaptive, "gc-stats": gcStats, "trace-opt": traceOpt } = args;
  const hasOpt = hasField(groups, "optStatus");
  const sections = buildReportSections(adaptive, gcStats, traceOpt && hasOpt);
  return reportResults(groups, sections);
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

  let profileBrowser: typeof import("../profiling/browser/BrowserProfiler.ts").profileBrowser;
  try {
    ({ profileBrowser } = await import(
      "../profiling/browser/BrowserProfiler.ts"
    ));
  } catch {
    throw new Error(
      "playwright is required for browser benchmarking (--url).\n\n" +
        "Quick start:  npx benchforge-browser <your-url>\n\n" +
        "Or install manually:\n" +
        "  npm install playwright\n" +
        "  npx playwright install chromium",
    );
  }

  const url = args.url!;
  const { iterations, duration } = args;
  const result = await profileBrowser({
    url,
    alloc: needsAlloc(args),
    allocOptions: {
      samplingInterval: args["alloc-interval"],
      stackDepth: args["alloc-depth"],
    },
    timeSample: needsTimeSample(args),
    timeInterval: args["time-interval"],
    headless: args.headless,
    chromeArgs: args["chrome-args"]
      ?.flatMap(a => a.split(/\s+/))
      .map(stripQuotes)
      .filter(Boolean),
    timeout: args.timeout,
    gcStats: args["gc-stats"],
    callCounts: args["call-counts"],
    maxTime: iterations ? Number.MAX_SAFE_INTEGER : duration * 1000,
    maxIterations: iterations,
  });

  const name = new URL(url).pathname.split("/").pop() || "browser";
  const results = browserResultGroups(name, result);
  printBrowserReport(result, results, args);
  await exportReports({ results, args });
}

/** Print heap allocation reports for benchmarks with heap profiles */
export function printHeapReports(
  groups: ReportGroup[],
  options: HeapReportOptions,
): void {
  for (const group of groups) {
    for (const report of groupReports(group)) {
      const { heapProfile } = report.measuredResults;
      if (!heapProfile) continue;

      console.log(dim(`\n─── Heap profile: ${report.name} ───`));
      const resolved = resolveProfile(heapProfile);
      const sites = flattenProfile(resolved);
      const userSites = filterSites(sites, options.isUserCode);
      const totalUserCode = userSites.reduce((sum, s) => sum + s.bytes, 0);
      const aggregated = aggregateSites(options.userOnly ? userSites : sites);
      const extra = {
        totalAll: resolved.totalBytes,
        totalUserCode,
        sampleCount: resolved.sortedSamples?.length,
      };
      console.log(formatHeapReport(aggregated, { ...options, ...extra }));
      if (options.raw) {
        console.log(dim(`\n─── Raw samples: ${report.name} ───`));
        console.log(formatRawSamples(resolved));
      }
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
  } else if (args.file) {
    await fileBenchExports(args.file, args);
  } else {
    throw new Error(
      "Provide a benchmark file, --url for browser mode, or pass a BenchSuite directly.",
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

/** Log V8 optimization tier distribution and deoptimizations */
export function reportOptStatus(groups: ReportGroup[]): void {
  const optData = groups.flatMap(group => {
    return groupReports(group)
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
  return results.some(group =>
    groupReports(group).some(
      ({ measuredResults }) => measuredResults[field] !== undefined,
    ),
  );
}

/** Export reports (JSON, Perfetto, archive, viewer) based on CLI args */
export async function exportReports(options: ExportOptions): Promise<void> {
  const { results, args, sections, suiteName } = options;
  const { currentVersion, baselineVersion } = options;

  // Prepare report data (needed for --view and --archive)
  let reportData: ReportData | undefined;
  if (args.view || args.archive != null) {
    const htmlOpts = {
      cliArgs: args,
      sections,
      currentVersion,
      baselineVersion,
    };
    reportData = prepareHtmlData(results, htmlOpts);
  }

  exportFileFormats(results, args, suiteName);

  // Build speedscope files and annotate with coverage if available
  const profileFile = buildSpeedscopeFile(results);
  const timeProfileFile = parseTimeProfileFile(results);
  await annotateCoverage(results, profileFile, timeProfileFile);

  const timeData = timeProfileFile
    ? JSON.stringify(timeProfileFile)
    : undefined;
  if (args.archive != null) {
    const archivePath =
      typeof args.archive === "string" && args.archive
        ? args.archive
        : undefined;
    await archiveBenchmark({
      groups: results,
      reportData,
      timeProfileData: timeData,
      outputPath: archivePath,
    });
  }

  if (args.view) {
    await openViewer(profileFile, timeData, reportData, args);
  }
}

function exportFileFormats(
  results: ReportGroup[],
  args: DefaultCliArgs,
  suiteName?: string,
): void {
  if (args["export-json"])
    exportBenchmarkJson(results, args["export-json"], args, suiteName);
  if (args["export-perfetto"])
    exportPerfettoTrace(results, args["export-perfetto"], args);
  if (args["export-time"]) exportTimeProfile(results, args["export-time"]);
}

function parseTimeProfileFile(results: ReportGroup[]) {
  return buildAllTimeProfiles(results);
}

async function openViewer(
  profileFile: ReturnType<typeof buildSpeedscopeFile>,
  timeProfileData: string | undefined,
  reportData: ReportData | undefined,
  args: DefaultCliArgs,
): Promise<void> {
  const profileData = profileFile ? JSON.stringify(profileFile) : undefined;
  const viewer = await startViewerServer({
    profileData,
    timeProfileData,
    reportData: reportData ? JSON.stringify(reportData) : undefined,
    editorUri: resolveEditorUri(args.editor),
  });
  await waitForCtrlC();
  viewer.close();
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
  const { duration, iterations, worker } = args;
  return {
    iterations,
    maxTime: iterations ? undefined : duration * 1000,
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

/** Validate CLI argument combinations */
function validateArgs(args: DefaultCliArgs): void {
  if (args["gc-stats"] && !args.worker && !args.url) {
    throw new Error(
      "--gc-stats requires worker mode (the default). Remove --no-worker flag.",
    );
  }
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

/** Build report sections based on CLI options */
function buildReportSections(
  adaptive: boolean,
  gcStats: boolean,
  hasOptData: boolean,
) {
  const sections = adaptive
    ? [adaptiveSection, totalTimeSection]
    : [timeSection];

  if (gcStats) sections.push(gcStatsSection);
  if (hasOptData) sections.push(optSection);
  sections.push(runsSection);

  return sections;
}

/** Print heap reports (if enabled) and export results */
async function finishReports(
  results: ReportGroup[],
  args: DefaultCliArgs,
  suiteName?: string,
  exportOptions?: MatrixExportOptions,
): Promise<void> {
  if (needsAlloc(args)) {
    printHeapReports(results, cliHeapReportOptions(args));
  }
  await exportReports({ results, args, suiteName, ...exportOptions });
}

/** Warn about Node-only flags that are ignored in browser mode. */
function warnBrowserFlags(args: DefaultCliArgs): void {
  const ignored: string[] = [];
  if (!args.worker) ignored.push("--no-worker");
  if (args["trace-opt"]) ignored.push("--trace-opt");
  if (args["gc-force"]) ignored.push("--gc-force");
  if (args.adaptive) ignored.push("--adaptive");
  if (args.batches > 1) ignored.push("--batches");
  if (ignored.length) {
    console.warn(yellow(`Ignored in browser mode: ${ignored.join(", ")}`));
  }
}

/** @return true if any alloc-related flag implies allocation sampling */
function needsAlloc(args: DefaultCliArgs): boolean {
  return (
    args.alloc ||
    args.archive != null ||
    args["alloc-raw"] ||
    args["alloc-verbose"] ||
    args["alloc-user-only"]
  );
}

/** @return true if time sampling should be enabled */
function needsTimeSample(args: DefaultCliArgs): boolean {
  return args["time-sample"] || !!args["export-time"];
}

/** Build combined time profile SpeedScope file from all results */
function buildAllTimeProfiles(results: ReportGroup[]) {
  const entries: {
    name: string;
    profile: import("../profiling/node/TimeSampler.ts").TimeProfile;
  }[] = [];
  for (const group of results) {
    for (const report of groupReports(group)) {
      const { timeProfile } = report.measuredResults;
      if (timeProfile)
        entries.push({ name: report.name, profile: timeProfile });
    }
  }
  return buildTimeSpeedscopeFile(entries);
}

/** Find the first raw V8 TimeProfile in results */
function findTimeProfile(
  results: ReportGroup[],
): import("../profiling/node/TimeSampler.ts").TimeProfile | undefined {
  for (const group of results) {
    for (const report of groupReports(group)) {
      if (report.measuredResults.timeProfile)
        return report.measuredResults.timeProfile;
    }
  }
  return undefined;
}

/** Merge coverage data from all results into a single CoverageData */
function mergeCoverage(
  results: ReportGroup[],
): import("../profiling/node/CoverageTypes.ts").CoverageData | undefined {
  const allScripts: import("../profiling/node/CoverageTypes.ts").ScriptCoverage[] =
    [];
  for (const group of results) {
    for (const report of groupReports(group)) {
      const { coverage } = report.measuredResults;
      if (coverage) allScripts.push(...coverage.scripts);
    }
  }
  return allScripts.length > 0 ? { scripts: allScripts } : undefined;
}

/** Annotate speedscope frame names with coverage counts if available */
async function annotateCoverage(
  results: ReportGroup[],
  profileFile?: {
    shared: { frames: { name: string; file?: string; line?: number }[] };
  },
  timeProfileFile?: {
    shared: { frames: { name: string; file?: string; line?: number }[] };
  },
): Promise<void> {
  const coverage = mergeCoverage(results);
  if (!coverage) return;
  if (!profileFile && !timeProfileFile) return;

  // Collect sources keyed by coverage script URLs for offset→line resolution
  const coverageUrls = coverage.scripts.map(s => ({ file: s.url }));
  const sources = await collectSources(coverageUrls);
  const coverageResult = buildCoverageMap(coverage, sources);
  if (profileFile)
    annotateFramesWithCounts(profileFile.shared.frames, coverageResult);
  if (timeProfileFile)
    annotateFramesWithCounts(timeProfileFile.shared.frames, coverageResult);
}

/** Export the first raw V8 TimeProfile to a JSON file */
function exportTimeProfile(results: ReportGroup[], path: string): void {
  const profile = findTimeProfile(results);
  if (profile) {
    const absPath = resolve(path);
    writeFileSync(absPath, JSON.stringify(profile));
    console.log(`Time profile exported to: ${path}`);
  } else {
    console.log("No time profiles to export.");
  }
}

/** Strip surrounding quotes from a chrome arg token.
 *
 * (Needed because --chrome-args values pass through yargs and spawn() without
 * shell processing, so literal quote characters reach Chrome/V8 unrecognized.)
 */
function stripQuotes(s: string): string {
  /* (['"]): opening quote; (.*): content; \1: require same closing quote */
  const unquote = s.replace(/^(['"])(.*)\1$/s, "$2");

  /* value portion: --flag="--value" or --flag='--value'
     (-[^=]+=): flag name and =; (['"])(.*)\2: quoted value */
  const valueUnquote = unquote.replace(/^(-[^=]+=)(['"])(.*)\2$/s, "$1$3");

  return valueUnquote;
}

/** Wrap browser profile result as ReportGroup[] for the standard pipeline */
function browserResultGroups(
  name: string,
  result: BrowserProfileResult,
): ReportGroup[] {
  const { gcStats, heapProfile, timeProfile, coverage } = result;
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
      timeProfile,
      coverage,
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
    measured = {
      name,
      samples: [wallMs],
      time,
      gcStats,
      heapProfile,
      timeProfile,
      coverage,
    };
  }

  return [{ name, reports: [{ name, measuredResults: measured }] }];
}

/** Print browser benchmark tables and heap reports */
function printBrowserReport(
  result: BrowserProfileResult,
  results: ReportGroup[],
  args: DefaultCliArgs,
): void {
  const hasSamples = result.samples && result.samples.length > 0;
  const sections: ResultsMapper<any>[] = [];
  if (hasSamples || result.wallTimeMs != null) {
    sections.push(timeSection);
  }
  if (result.gcStats) {
    sections.push(browserGcStatsSection);
  }
  if (hasSamples || result.wallTimeMs != null) {
    sections.push(runsSection);
  }
  if (sections.length > 0) {
    console.log(reportResults(results, sections));
  }
  if (result.heapProfile) {
    printHeapReports(results, {
      ...cliHeapReportOptions(args),
      isUserCode: isBrowserUserCode,
    });
  }
}

/** Import a file and run it as a benchmark based on what it exports */
async function fileBenchExports(
  filePath: string,
  args: DefaultCliArgs,
): Promise<void> {
  const fileUrl = pathToFileURL(resolve(filePath)).href;
  const mod = await import(fileUrl);
  const candidate = mod.default;

  if (candidate && Array.isArray(candidate.matrices)) {
    // MatrixSuite export
    await matrixBenchExports(candidate as MatrixSuite, args);
  } else if (candidate && Array.isArray(candidate.groups)) {
    // BenchSuite export
    await benchExports(candidate as BenchSuite, args);
  } else if (typeof candidate === "function") {
    // Default function export: wrap as a single benchmark
    const name = basename(filePath).replace(/\.[^.]+$/, "");
    await benchExports(
      { name, groups: [{ name, benchmarks: [{ name, fn: candidate }] }] },
      args,
    );
  }
  // else: self-executing file already ran on import
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
  const gcForce = args["gc-force"];
  const { "trace-opt": traceOpt, "skip-settle": noSettle } = args;
  const { "pause-first": pauseFirst, "pause-interval": pauseInterval } = args;
  const { "pause-duration": pauseDuration, "gc-stats": gcStats } = args;
  const alloc = needsAlloc(args);
  const { "alloc-interval": allocInterval } = args;
  const { "alloc-depth": allocDepth } = args;
  const timeSample = needsTimeSample(args);
  const { "time-interval": timeInterval } = args;
  const callCounts = args["call-counts"];
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
      args["trace-opt"] && hasField(groups, "optStatus"),
    );
  }

  return result;
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

/** @return HeapReportOptions from CLI args */
function cliHeapReportOptions(args: DefaultCliArgs): HeapReportOptions {
  return {
    topN: args["alloc-rows"],
    stackDepth: args["alloc-stack"],
    verbose: args["alloc-verbose"],
    raw: args["alloc-raw"],
    userOnly: args["alloc-user-only"],
  };
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
