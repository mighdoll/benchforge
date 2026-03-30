import { basename, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { hideBin } from "yargs/helpers";
import type { BrowserProfileResult } from "../profiling/browser/BrowserProfiler.ts";
import {
  isBrowserUserCode,
} from "../profiling/node/HeapSampleReport.ts";
import type {
  ReportGroup,
  ResultsMapper,
} from "../report/BenchmarkReport.ts";
import {
  browserGcStatsSection,
  runsSection,
  timeSection,
} from "../report/StandardSections.ts";
import { reportResults } from "../report/text/TextReport.ts";
import colors from "../report/Colors.ts";
import { computeStats } from "../runners/BasicRunner.ts";
import type { BenchSuite } from "../runners/BenchmarkSpec.ts";
import type { MeasuredResults } from "../runners/MeasuredResults.ts";
import type {
  MatrixResults,
  MatrixSuite,
} from "../matrix/BenchMatrix.ts";
import { runMatrix } from "../matrix/BenchMatrix.ts";
import { loadCasesModule } from "../matrix/CaseLoader.ts";
import {
  type FilteredMatrix,
  filterMatrix,
  parseMatrixFilter,
} from "../matrix/MatrixFilter.ts";
import type { MatrixReportOptions } from "../matrix/MatrixReport.ts";
import {
  type Configure,
  type DefaultCliArgs,
  parseCliArgs,
} from "./CliArgs.ts";
import {
  cliHeapReportOptions,
  cliToMatrixOptions,
  needsAlloc,
  needsTimeSample,
  validateArgs,
} from "./CliOptions.ts";
import { runBenchmarks } from "./SuiteRunner.ts";
import {
  defaultMatrixReport,
  defaultReport,
  matrixToReportGroups,
  printHeapReports,
} from "./CliReport.ts";
import {
  type MatrixExportOptions,
  exportReports,
  finishReports,
} from "./CliExport.ts";

const { yellow } = colors;

/** Parse CLI with custom configuration */
export function parseBenchArgs<T = DefaultCliArgs>(
  configureArgs?: Configure<T>,
): T & DefaultCliArgs {
  const argv = hideBin(process.argv);
  return parseCliArgs(argv, configureArgs) as T & DefaultCliArgs;
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

/** Run matrix suite with full CLI handling (parse, run, report, export) */
export async function runDefaultMatrixBench(
  suite: MatrixSuite,
  configureArgs?: Configure<any>,
  reportOptions?: MatrixReportOptions,
): Promise<void> {
  const args = parseBenchArgs(configureArgs);
  await matrixBenchExports(suite, args, reportOptions);
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

/** Import a file and run it as a benchmark based on what it exports */
async function fileBenchExports(
  filePath: string,
  args: DefaultCliArgs,
): Promise<void> {
  const fileUrl = pathToFileURL(resolve(filePath)).href;
  const mod = await import(fileUrl);
  const candidate = mod.default;

  if (candidate && Array.isArray(candidate.matrices)) {
    await matrixBenchExports(candidate as MatrixSuite, args);
  } else if (candidate && Array.isArray(candidate.groups)) {
    await benchExports(candidate as BenchSuite, args);
  } else if (typeof candidate === "function") {
    const name = basename(filePath).replace(/\.[^.]+$/, "");
    await benchExports(
      { name, groups: [{ name, benchmarks: [{ name, fn: candidate }] }] },
      args,
    );
  }
}

/** Wrap browser profile result as ReportGroup[] for the standard pipeline */
function browserResultGroups(
  name: string,
  result: BrowserProfileResult,
): ReportGroup[] {
  const { gcStats, heapProfile, timeProfile, coverage } = result;
  const base = { name, gcStats, heapProfile, timeProfile, coverage };
  let measured: MeasuredResults;

  if (result.samples && result.samples.length > 0) {
    const { samples } = result;
    const totalTime = result.wallTimeMs ? result.wallTimeMs / 1000 : undefined;
    measured = {
      ...base,
      samples,
      time: computeStats(samples),
      totalTime,
    };
  } else {
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
    measured = { ...base, samples: [wallMs], time };
  }

  return [{ name, reports: [{ name, measuredResults: measured }] }];
}

/** Print browser benchmark tables and heap reports */
function printBrowserReport(
  result: BrowserProfileResult,
  results: ReportGroup[],
  args: DefaultCliArgs,
): void {
  const hasTime =
    (result.samples && result.samples.length > 0) || result.wallTimeMs != null;
  const sections: ResultsMapper<any>[] = [
    ...(hasTime ? [timeSection] : []),
    ...(result.gcStats ? [browserGcStatsSection] : []),
    ...(hasTime ? [runsSection] : []),
  ];
  if (sections.length > 0) console.log(reportResults(results, sections));
  if (result.heapProfile) {
    printHeapReports(results, {
      ...cliHeapReportOptions(args),
      isUserCode: isBrowserUserCode,
    });
  }
}

/** Warn about Node-only flags that are ignored in browser mode. */
function warnBrowserFlags(args: DefaultCliArgs): void {
  const ignored = [
    !args.worker && "--no-worker",
    args["trace-opt"] && "--trace-opt",
    args["gc-force"] && "--gc-force",
    args.adaptive && "--adaptive",
    args.batches > 1 && "--batches",
  ].filter(Boolean);
  if (ignored.length)
    console.warn(yellow(`Ignored in browser mode: ${ignored.join(", ")}`));
}

/** Strip surrounding quotes from a chrome arg token. */
function stripQuotes(s: string): string {
  const unquote = s.replace(/^(['"])(.*)\1$/s, "$2");
  const valueUnquote = unquote.replace(/^(-[^=]+=)(['"])(.*)\2$/s, "$1$3");
  return valueUnquote;
}

