import { basename, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { Argv } from "yargs";
import { hideBin } from "yargs/helpers";
import {
  type BenchMatrix,
  type MatrixResults,
  type MatrixSuite,
  runMatrix,
} from "../matrix/BenchMatrix.ts";
import { loadCasesModule } from "../matrix/CaseLoader.ts";
import { runMatrixCalibrationBrowser } from "../matrix/MatrixBrowserRunner.ts";
import { runMatrixCalibration } from "../matrix/MatrixDirRunner.ts";
import {
  type FilteredMatrix,
  filterMatrix,
  type MatrixFilter,
  parseMatrixFilter,
  resolveCaseIds,
  resolveVariantIds,
} from "../matrix/MatrixFilter.ts";
import { runMatrixCalibrationInline } from "../matrix/MatrixInlineRunner.ts";
import { reportMatrixResults } from "../matrix/MatrixReport.ts";
import type { ReportSection } from "../report/BenchmarkReport.ts";
import { calibrationMarkdown } from "../report/CalibrationReport.ts";
import { formatCliCommand } from "../report/CliCommand.ts";
import { consoleSummary } from "../report/ConsoleSummary.ts";
import type { GitVersion } from "../report/GitUtils.ts";
import {
  appendNoiseLog,
  calibrateNoiseRecord,
  machineId,
} from "../report/NoiseLog.ts";
import { browserBenchExports } from "./BrowserBench.ts";
import { formatCalibration, reportCalibrateRun } from "./CalibrateRunner.ts";
import {
  cliDefaults,
  type DefaultCliArgs,
  defaultCliArgs,
  parseCliArgs,
} from "./CliArgs.ts";
import { finishReports, writeCalibrationReport } from "./CliExport.ts";
import { cliToMatrixOptions, validateArgs } from "./CliOptions.ts";
import {
  defaultReportData,
  matrixToReportGroups,
  withStatus,
} from "./CliReport.ts";
import {
  applyRunDefaults,
  type RunDefaults,
  readPreset,
} from "./RunPresets.ts";

export interface BuildResult {
  suite: MatrixSuite;
  sections?: ReportSection[];
  currentVersion?: GitVersion;
  baselineVersion?: GitVersion;
}

export interface BenchCliConfig<Extra = Record<string, never>> {
  /**
   * Augment yargs with custom options. Receives yargs already configured with
   * defaults; explicit command-line args override those defaults at parse time.
   */
  configure?: (yargs: Argv<DefaultCliArgs>) => Argv<DefaultCliArgs & Extra>;
  /** Build the suite and report metadata from parsed args. */
  build: (args: DefaultCliArgs & Extra) => Promise<BuildResult> | BuildResult;
  /** Named bundles of run/calibration defaults, selected with --preset. */
  presets?: Record<string, RunDefaults>;
  /** Preset applied when --preset is omitted. */
  defaultPreset?: string;
}

/** Single entry point: parse args, run the user's build, run the matrix pipeline. */
export async function runBenchCli<Extra = Record<string, never>>(
  config: BenchCliConfig<Extra>,
): Promise<void> {
  const configure =
    config.configure ?? (y => y as Argv<DefaultCliArgs & Extra>);
  const { presets, defaultPreset } = config;
  const argv = hideBin(process.argv);
  const chosen = presetDefaults(presets, defaultPreset, argv);
  const args = parseCliArgs(y => {
    const withOpts = configure(defaultCliArgs(y));
    const withPreset = presets
      ? registerPreset(withOpts, presets, defaultPreset)
      : withOpts;
    return applyRunDefaults(withPreset, chosen);
  }, argv);
  const result = await config.build(args);
  if (args.list) return listMatrixSuite(result.suite);
  return runMatrixPipeline(result, args);
}

/** Resolve the run defaults for the selected (or default) preset. */
function presetDefaults(
  presets: Record<string, RunDefaults> | undefined,
  defaultPreset: string | undefined,
  argv: string[],
): RunDefaults {
  if (!presets) return {};
  const name = readPreset(argv) ?? defaultPreset;
  return (name && presets[name]) || {};
}

/** Add the --preset option (valid names, default) to yargs. */
function registerPreset<T>(
  y: Argv<T>,
  presets: Record<string, RunDefaults>,
  defaultPreset: string | undefined,
): Argv<T> {
  return y.option("preset", {
    type: "string",
    choices: Object.keys(presets),
    default: defaultPreset,
    describe: "run-settings preset (explicit flags override it)",
  }) as unknown as Argv<T>;
}

/** Top-level CLI dispatch: route to view, analyze, or run a benchmark file/url. */
export async function dispatchCli(): Promise<void> {
  const argv = hideBin(process.argv);
  const [command] = argv;

  if (command === "view") {
    const { viewArchive } = await import("./ViewerServer.ts");
    return viewArchive(requireFile(argv[1], "view"));
  }
  if (command === "analyze") {
    const { analyzeArchive } = await import("./AnalyzeArchive.ts");
    return analyzeArchive(requireFile(argv[1], "analyze"));
  }

  const args = parseCliArgs();
  // --url with a bench file: run that file's inline matrix in the browser against
  // the harness url. --url alone: profile the page's own window.__bench.
  if (args.url && args.file) return runFileBench(args.file, args);
  if (args.url) return browserBenchExports(args);
  if (args.file) return runFileBench(args.file, args);
  throw new Error("Provide a benchmark file or --url for browser mode.");
}

/** Run every matrix in a suite, applying default cases/variants or --filter.
 *  A filter that matches no case/variant in a given matrix skips that matrix
 *  (so a variant filter can target one matrix in a multi-matrix suite); it is
 *  only an error when the filter matches nothing across the whole suite. */
export async function runFilteredMatrices(
  suite: MatrixSuite,
  args: DefaultCliArgs,
): Promise<MatrixResults[]> {
  validateArgs(args);
  const filter = args.filter ? parseMatrixFilter(args.filter) : undefined;
  const options = cliToMatrixOptions(args);

  const results: MatrixResults[] = [];
  let lastFilterError: Error | undefined;
  for (const matrix of suite.matrices) {
    let filtered: FilteredMatrix<any>;
    try {
      filtered = await applyMatrixFilters(matrix, args.all, filter);
    } catch (err) {
      if (suite.matrices.length === 1) throw err;
      lastFilterError = err as Error;
      continue;
    }
    const { filteredCases, filteredVariants } = filtered;
    const runOpts = { ...options, filteredCases, filteredVariants };
    results.push(await runMatrix(filtered, runOpts));
  }
  if (!results.length && lastFilterError) throw lastFilterError;
  return results;
}

/** Print available cases and variants in a matrix suite. */
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

/** Matrix end-to-end: filter, run, build the report data once, print the
 *  per-benchmark console summary plus the matrix verdict tally, then reuse the
 *  same data for markdown/viewer exports. */
async function runMatrixPipeline(
  m: BuildResult,
  args: DefaultCliArgs,
): Promise<void> {
  if (args.calibrate) return runMatrixCalibratePipeline(m, args);
  // Echo the effective invocation (including preset-injected settings) so the
  // run's parameters are visible on the console, as they are in the HTML header.
  console.log(formatCliCommand(args, cliDefaults));
  const results = await runFilteredMatrices(m.suite, args);
  const groups = matrixToReportGroups(results);
  const { sections, currentVersion, baselineVersion } = m;
  const reportMeta = { sections, currentVersion, baselineVersion };
  const reportData = withStatus("computing report", () =>
    defaultReportData(groups, args, reportMeta),
  );
  const tally = reportMatrixResults(reportData);
  console.log([consoleSummary(reportData), tally].filter(Boolean).join("\n\n"));
  await finishReports(groups, args, { ...reportMeta, reportData });
}

/** Route calibration to the browser, directory, or inline runner. */
function calibrateMatrix(
  filtered: FilteredMatrix<any>,
  runOpts: ReturnType<typeof cliToMatrixOptions>,
): Promise<Awaited<ReturnType<typeof runMatrixCalibration>>> {
  if (runOpts.browser)
    return runMatrixCalibrationBrowser(filtered, runOpts, reportCalibrateRun);
  if (filtered.variantDir)
    return runMatrixCalibration(filtered, runOpts, reportCalibrateRun);
  return runMatrixCalibrationInline(filtered, runOpts, reportCalibrateRun);
}

/** Require a file argument for a subcommand, exiting with usage on missing. */
function requireFile(filePath: string | undefined, subcommand: string): string {
  if (filePath) return filePath;
  console.error(`Usage: benchforge ${subcommand} <file.benchforge>`);
  process.exit(1);
}

/** Import a file and run it as a benchmark based on what it exports. */
async function runFileBench(
  filePath: string,
  args: DefaultCliArgs,
): Promise<void> {
  const result = await resolveFileResult(filePath);
  if (!result) return;
  if (args.list) return listMatrixSuite(result.suite);
  await runMatrixPipeline(result, args);
}

/** --filter bypasses defaults (implies --all for the filtered dimension). */
async function applyMatrixFilters(
  matrix: FilteredMatrix<any>,
  runAll: boolean,
  filter?: MatrixFilter,
): Promise<FilteredMatrix<any>> {
  const mod = matrix.casesModule
    ? await loadCasesModule(matrix.casesModule)
    : undefined;
  let withDefaults = matrix;
  if (!runAll && !filter && mod) {
    const { defaultCases: filteredCases, defaultVariants: filteredVariants } =
      mod;
    withDefaults = { ...matrix, filteredCases, filteredVariants };
  }
  return filter ? filterMatrix(withDefaults, filter) : withDefaults;
}

/** Calibrate: measure the noise floor on one matrix/variant/case, print the
 *  summary, and save a dated markdown report so the suggested margin and the
 *  settings used are recallable. */
async function runMatrixCalibratePipeline(
  m: BuildResult,
  args: DefaultCliArgs,
): Promise<void> {
  validateArgs(args);
  const filter = args.filter ? parseMatrixFilter(args.filter) : undefined;
  const options = cliToMatrixOptions(args);
  const matrix = m.suite.matrices[0];
  const filtered = await applyMatrixFilters(matrix, args.all, filter);
  const { filteredCases, filteredVariants } = filtered;
  const runOpts = { ...options, filteredCases, filteredVariants };
  const result = await calibrateMatrix(filtered, runOpts);
  console.log(formatCalibration(result));
  const meta = {
    timestamp: new Date().toISOString(),
    cliArgs: args,
    cliDefaults,
    currentVersion: m.currentVersion,
    environment: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
    },
  };
  const md = calibrationMarkdown(result, meta);
  writeCalibrationReport(md, meta.timestamp, args);
  appendNoiseLog([
    calibrateNoiseRecord(result, meta.timestamp, matrix.name, machineId()),
  ]);
}

/** Load a benchmark file and shape its default export into a BuildResult. A
 *  default-exported function becomes a one-variant matrix; a MatrixSuite (has
 *  `matrices`) is used directly. */
async function resolveFileResult(
  filePath: string,
): Promise<BuildResult | undefined> {
  const fileUrl = pathToFileURL(resolve(filePath)).href;
  const { default: candidate } = await import(fileUrl);

  if (candidate && Array.isArray(candidate.matrices)) {
    return { suite: candidate as MatrixSuite };
  }
  if (typeof candidate === "function") {
    const name = basename(filePath).replace(/\.[^.]+$/, "");
    const matrix: BenchMatrix = { name, variants: { [name]: candidate } };
    return { suite: { name, matrices: [matrix] } };
  }
  return undefined;
}
