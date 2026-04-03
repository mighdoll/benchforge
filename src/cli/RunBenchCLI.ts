import { basename, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { hideBin } from "yargs/helpers";
import type { MatrixResults, MatrixSuite } from "../matrix/BenchMatrix.ts";
import { runMatrix } from "../matrix/BenchMatrix.ts";
import { loadCasesModule } from "../matrix/CaseLoader.ts";
import {
  type FilteredMatrix,
  filterMatrix,
  type MatrixFilter,
  parseMatrixFilter,
  resolveCaseIds,
  resolveVariantIds,
} from "../matrix/MatrixFilter.ts";
import type { MatrixReportOptions } from "../matrix/MatrixReport.ts";
import type { BrowserProfileResult } from "../profiling/browser/BrowserProfiler.ts";
import { isBrowserUserCode } from "../profiling/node/HeapSampleReport.ts";
import type { ReportGroup, ResultsMapper } from "../report/BenchmarkReport.ts";
import colors from "../report/Colors.ts";
import {
  browserGcStatsSection,
  pageLoadSection,
  runsSection,
  timeSection,
} from "../report/StandardSections.ts";
import { reportResults } from "../report/text/TextReport.ts";
import { computeStats } from "../runners/BasicRunner.ts";
import type { BenchSuite } from "../runners/BenchmarkSpec.ts";
import type { MeasuredResults } from "../runners/MeasuredResults.ts";
import { runBatched } from "../runners/MergeBatches.ts";
import {
  type Configure,
  type DefaultCliArgs,
  parseCliArgs,
} from "./CliArgs.ts";
import {
  exportReports,
  finishReports,
  type MatrixExportOptions,
} from "./CliExport.ts";
import {
  cliHeapReportOptions,
  cliToMatrixOptions,
  needsAlloc,
  needsTimeSample,
  validateArgs,
} from "./CliOptions.ts";
import {
  defaultMatrixReport,
  defaultReport,
  matrixToReportGroups,
  printHeapReports,
} from "./CliReport.ts";
import { runBenchmarks } from "./SuiteRunner.ts";

const { yellow } = colors;

/** Parse CLI args with optional custom yargs configuration. */
export function parseBenchArgs<T = DefaultCliArgs>(
  configureArgs?: Configure<T>,
): T & DefaultCliArgs {
  const argv = hideBin(process.argv);
  return parseCliArgs(argv, configureArgs) as T & DefaultCliArgs;
}

/** Run benchmarks and display results. Suite is optional with --url (browser mode). */
export async function runDefaultBench(
  suite?: BenchSuite,
  configureArgs?: Configure<any>,
): Promise<void> {
  const args = parseBenchArgs(configureArgs);
  if (args.url) return browserBenchExports(args);
  if (args.list && suite) return listSuite(suite);
  if (suite) return benchExports(suite, args);
  if (args.file) return fileBenchExports(args.file, args);
  throw new Error(
    "Provide a benchmark file, --url for browser mode, or pass a BenchSuite directly.",
  );
}

/** Run benchmarks, display results, and export reports. */
export async function benchExports(
  suite: BenchSuite,
  args: DefaultCliArgs,
): Promise<void> {
  const results = await runBenchmarks(suite, args);
  const report = defaultReport(results, args);
  console.log(report);
  await finishReports(results, args, suite.name);
}

/** Run browser profiling via CDP and report with standard pipeline. */
export async function browserBenchExports(args: DefaultCliArgs): Promise<void> {
  warnBrowserFlags(args);
  const profileBrowser = await loadBrowserProfiler();
  const params = buildBrowserParams(args);
  const name = nameFromUrl(args.url!);
  const baselineUrl = args["baseline-url"];

  // Single-tab, no baseline: unchanged fast path
  if (args.batches <= 1 && !baselineUrl) {
    const result = await profileBrowser(params);
    const results = browserResultGroups(name, result);
    printBrowserReport(result, results, args);
    await exportReports({ results, args });
    return;
  }

  // Multi-tab batching with optional baseline comparison
  const { lastRaw, results } = await runBrowserBatches(
    profileBrowser,
    params,
    name,
    args,
  );
  printBrowserReport(lastRaw, results, args);
  await exportReports({ results, args });
}

/** Launch Chrome, run batched fresh tabs, merge results. */
async function runBrowserBatches(
  profileBrowser: Awaited<ReturnType<typeof loadBrowserProfiler>>,
  params: ReturnType<typeof buildBrowserParams>,
  name: string,
  args: DefaultCliArgs,
): Promise<{ lastRaw: BrowserProfileResult; results: ReportGroup[] }> {
  const launchChrome = await loadChromeLauncher();
  const chrome = await launchChrome({
    headless: args.headless,
    chromePath: args.chrome,
    chromeProfile: args["chrome-profile"],
    args: params.chromeArgs,
  });

  try {
    return await runBatchedTabs(profileBrowser, params, name, args, chrome);
  } finally {
    await chrome.close();
  }
}

/** Execute batched browser tabs within an already-launched Chrome instance. */
async function runBatchedTabs(
  profileBrowser: Awaited<ReturnType<typeof loadBrowserProfiler>>,
  params: ReturnType<typeof buildBrowserParams>,
  name: string,
  args: DefaultCliArgs,
  chrome: any,
): Promise<{ lastRaw: BrowserProfileResult; results: ReportGroup[] }> {
  const baselineUrl = args["baseline-url"];
  let lastRaw: BrowserProfileResult | undefined;

  const runCurrent = async () => {
    const raw = await profileBrowser({ ...params, chrome });
    lastRaw = raw;
    return toBrowserMeasured(name, raw);
  };
  const runBaseline = baselineUrl
    ? async () => {
        const raw = await profileBrowser({
          ...params,
          chrome,
          url: baselineUrl,
        });
        lastRaw ??= raw;
        return toBrowserMeasured(nameFromUrl(baselineUrl), raw);
      }
    : undefined;

  const batches = Math.max(args.batches, 2);
  const warmupBatch = args["warmup-batch"] ?? false;
  const batched = await runBatched(
    [runCurrent],
    runBaseline,
    batches,
    warmupBatch,
  );
  const {
    results: [current],
    baseline,
  } = batched;

  const baselineReport =
    baseline && baselineUrl
      ? { name: nameFromUrl(baselineUrl), measuredResults: baseline }
      : undefined;
  const group = {
    name,
    reports: [{ name, measuredResults: current }],
    baseline: baselineReport,
  };
  return { lastRaw: lastRaw!, results: [group] };
}

/** Dynamically import the browser profiler (lazy-loaded for non-browser benchmarks). */
async function loadBrowserProfiler() {
  const path = "../profiling/browser/BrowserProfiler.ts";
  type BrowserMod = typeof import("../profiling/browser/BrowserProfiler.ts");
  return ((await import(path)) as BrowserMod).profileBrowser;
}

/** Dynamically import Chrome launcher (lazy-loaded for multi-tab batching). */
async function loadChromeLauncher() {
  const path = "../profiling/browser/ChromeLauncher.ts";
  type Mod = typeof import("../profiling/browser/ChromeLauncher.ts");
  return ((await import(path)) as Mod).launchChrome;
}

/** Build BrowserProfileParams from CLI args. */
function buildBrowserParams(args: DefaultCliArgs) {
  const { iterations, duration } = args;
  const chromeArgs = args["chrome-args"]
    ?.flatMap(a => a.split(/\s+/))
    .map(stripQuotes)
    .filter(Boolean);
  return {
    url: args.url!,
    pageLoad: args["page-load"] || !!args["wait-for"],
    maxTime: iterations ? Number.MAX_SAFE_INTEGER : duration * 1000,
    chromeArgs,
    allocOptions: {
      samplingInterval: args["alloc-interval"],
      stackDepth: args["alloc-depth"],
    },
    alloc: needsAlloc(args),
    timeSample: needsTimeSample(args),
    timeInterval: args["time-interval"],
    headless: args.headless,
    chromePath: args.chrome,
    chromeProfile: args["chrome-profile"],
    timeout: args.timeout,
    gcStats: args["gc-stats"],
    callCounts: args["call-counts"],
    maxIterations: iterations,
    waitFor: args["wait-for"],
  };
}

/** Extract a short name from a URL for report labels. */
function nameFromUrl(url: string): string {
  return new URL(url).pathname.split("/").pop() || "browser";
}

/** Run matrix suite with full CLI handling (parse, run, report, export). */
export async function runDefaultMatrixBench(
  suite: MatrixSuite,
  configureArgs?: Configure<any>,
  reportOptions?: MatrixReportOptions,
): Promise<void> {
  const args = parseBenchArgs(configureArgs);
  await matrixBenchExports(suite, args, reportOptions);
}

/** Run matrix benchmarks, display results, and generate exports. */
export async function matrixBenchExports(
  suite: MatrixSuite,
  args: DefaultCliArgs,
  reportOptions?: MatrixReportOptions,
  exportOptions?: MatrixExportOptions,
): Promise<void> {
  const results = await runMatrixSuite(suite, args);
  const report = defaultMatrixReport(results, reportOptions, args);
  console.log(report);

  const groups = matrixToReportGroups(results);
  await finishReports(groups, args, suite.name, exportOptions);
}

/** Run matrix suite with CLI arguments. --filter narrows defaults, --all --filter narrows all. */
export async function runMatrixSuite(
  suite: MatrixSuite,
  args: DefaultCliArgs,
): Promise<MatrixResults[]> {
  if (args.list) {
    await listMatrixSuite(suite);
    return [];
  }
  validateArgs(args);
  const filter = args.filter ? parseMatrixFilter(args.filter) : undefined;
  const options = cliToMatrixOptions(args);

  const results: MatrixResults[] = [];
  for (const matrix of suite.matrices) {
    const filtered = await applyMatrixFilters(matrix, args.all, filter);
    const { filteredCases, filteredVariants } = filtered;
    const opts = { ...options, filteredCases, filteredVariants };
    results.push(await runMatrix(filtered, opts));
  }
  return results;
}

/** Apply default-case narrowing and user filter to a matrix.
 *  --filter bypasses defaults (implies --all for the filtered dimension). */
async function applyMatrixFilters(
  matrix: FilteredMatrix<any>,
  runAll: boolean,
  filter?: MatrixFilter,
): Promise<FilteredMatrix<any>> {
  const mod = matrix.casesModule
    ? await loadCasesModule(matrix.casesModule)
    : undefined;

  let filtered: FilteredMatrix<any> = matrix;
  if (!runAll && !filter && mod) {
    const { defaultCases: filteredCases, defaultVariants: filteredVariants } =
      mod;
    filtered = { ...matrix, filteredCases, filteredVariants };
  }
  if (filter) filtered = await filterMatrix(filtered, filter);
  return filtered;
}

/** Print available benchmarks in a suite */
function listSuite(suite: BenchSuite): void {
  for (const group of suite.groups) {
    console.log(group.name);
    for (const bench of group.benchmarks) console.log(`  ${bench.name}`);
    if (group.baseline) console.log(`  ${group.baseline.name} (baseline)`);
  }
}

/** Print available cases and variants for each matrix in a suite */
async function listMatrixSuite(suite: MatrixSuite): Promise<void> {
  for (const matrix of suite.matrices) {
    console.log(matrix.name);
    const caseIds = await resolveCaseIds(matrix);
    if (caseIds) {
      console.log("  cases:");
      for (const id of caseIds) console.log(`    ${id}`);
    }
    const variantIds = await resolveVariantIds(matrix);
    console.log("  variants:");
    for (const id of variantIds) console.log(`    ${id}`);
  }
}

/** Import a file and run it as a benchmark based on what it exports. */
async function fileBenchExports(
  filePath: string,
  args: DefaultCliArgs,
): Promise<void> {
  const fileUrl = pathToFileURL(resolve(filePath)).href;
  const { default: candidate } = await import(fileUrl);

  if (candidate && Array.isArray(candidate.matrices)) {
    if (args.list) return listMatrixSuite(candidate as MatrixSuite);
    return matrixBenchExports(candidate as MatrixSuite, args);
  }
  if (candidate && Array.isArray(candidate.groups)) {
    if (args.list) return listSuite(candidate as BenchSuite);
    return benchExports(candidate as BenchSuite, args);
  }
  if (typeof candidate === "function") {
    const name = basename(filePath).replace(/\.[^.]+$/, "");
    const bench = { name, fn: candidate };
    const suite = { name, groups: [{ name, benchmarks: [bench] }] };
    return benchExports(suite, args);
  }
}

/** Warn about Node-only flags ignored in browser mode. */
function warnBrowserFlags(args: DefaultCliArgs): void {
  const checks: [boolean, string][] = [
    [!args.worker, "--no-worker"],
    [!!args["trace-opt"], "--trace-opt"],
    [!!args["gc-force"], "--gc-force"],
    [!!args.adaptive, "--adaptive"],
  ];
  const ignored = checks.filter(([active]) => active).map(([, flag]) => flag);
  if (ignored.length > 0)
    console.warn(yellow(`Ignored in browser mode: ${ignored.join(", ")}`));
}

/** Strip surrounding quotes from a chrome-args token. */
function stripQuotes(s: string): string {
  const bare = s.replace(/^(['"])(.*)\1$/s, "$2");
  return bare.replace(/^(-[^=]+=)(['"])(.*)\2$/s, "$1$3");
}

/** Wrap browser profile result as ReportGroup[] for the standard export pipeline. */
function browserResultGroups(
  name: string,
  result: BrowserProfileResult,
): ReportGroup[] {
  const measuredResults = toBrowserMeasured(name, result);
  return [{ name, reports: [{ name, measuredResults }] }];
}

/** Print browser benchmark tables and heap reports. */
function printBrowserReport(
  result: BrowserProfileResult,
  results: ReportGroup[],
  args: DefaultCliArgs,
): void {
  const hasTime = !!result.samples?.length || result.wallTimeMs != null;
  const showTime = hasTime && !result.navTiming;
  const sections: (ResultsMapper<any> | false)[] = [
    !!result.navTiming && pageLoadSection,
    showTime && timeSection,
    !!result.gcStats && browserGcStatsSection,
    showTime && runsSection,
  ];
  const activeSections = sections.filter(Boolean) as ResultsMapper<any>[];
  if (activeSections.length > 0)
    console.log(reportResults(results, activeSections));
  if (result.heapProfile)
    printHeapReports(results, {
      ...cliHeapReportOptions(args),
      isUserCode: isBrowserUserCode,
    });
}

/** Convert browser profile result to MeasuredResults. */
function toBrowserMeasured(
  name: string,
  result: BrowserProfileResult,
): MeasuredResults {
  const { gcStats, heapProfile, timeProfile, coverage, navTiming } = result;
  const base = { name, gcStats, heapProfile, timeProfile, coverage, navTiming };

  const { samples } = result;
  if (samples && samples.length > 0) {
    const totalTime = result.wallTimeMs ? result.wallTimeMs / 1000 : undefined;
    return { ...base, samples, time: computeStats(samples), totalTime };
  }

  const wallTime = result.wallTimeMs ?? 0;
  return { ...base, samples: [wallTime], time: computeStats([wallTime]) };
}
