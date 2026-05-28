import { basename, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { Argv } from "yargs";
import { hideBin } from "yargs/helpers";
import {
  type MatrixResults,
  type MatrixSuite,
  runMatrix,
} from "../matrix/BenchMatrix.ts";
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
import type { ReportSection } from "../report/BenchmarkReport.ts";
import type { GitVersion } from "../report/GitUtils.ts";
import type { BenchSuite } from "../runners/BenchmarkSpec.ts";
import { browserBenchExports } from "./BrowserBench.ts";
import { type DefaultCliArgs, defaultCliArgs, parseCliArgs } from "./CliArgs.ts";
import { finishReports } from "./CliExport.ts";
import { cliToMatrixOptions, validateArgs } from "./CliOptions.ts";
import {
  defaultMatrixReport,
  defaultReport,
  matrixToReportGroups,
  withStatus,
} from "./CliReport.ts";
import { runBench } from "./SuiteRunner.ts";

export interface BenchBuildResult {
  suite: BenchSuite;
  sections?: ReportSection[];
}

export interface MatrixBuildResult {
  suite: MatrixSuite;
  sections?: ReportSection[];
  reportOptions?: MatrixReportOptions;
  currentVersion?: GitVersion;
  baselineVersion?: GitVersion;
}

export type BuildResult = BenchBuildResult | MatrixBuildResult;

export interface BenchCliConfig<Extra = Record<string, never>> {
  /** Augment yargs with custom options. Receives yargs already configured with defaults. */
  configure?: (yargs: Argv<DefaultCliArgs>) => Argv<DefaultCliArgs & Extra>;
  /** Build the suite and report metadata from parsed args. */
  build: (args: DefaultCliArgs & Extra) => Promise<BuildResult> | BuildResult;
}

/** Single entry point: parse args, run the user's build, dispatch to bench or matrix pipeline. */
export async function runBenchCli<Extra = Record<string, never>>(
  config: BenchCliConfig<Extra>,
): Promise<void> {
  const configure = config.configure ?? (y => y as Argv<DefaultCliArgs & Extra>);
  const args = parseCliArgs(y => configure(defaultCliArgs(y)));
  const result = await config.build(args);
  if (args.list) return listResult(result.suite);
  return dispatchResult(result, args);
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
  if (args.url) return browserBenchExports(args);
  if (args.file) return runFileBench(args.file, args);
  throw new Error("Provide a benchmark file or --url for browser mode.");
}

/** Route a build result to the bench or matrix pipeline. */
function dispatchResult(
  result: BuildResult,
  args: DefaultCliArgs,
): Promise<void> {
  if (isMatrixResult(result)) return runMatrixPipeline(result, args);
  return runBenchPipeline(result, args);
}

function isMatrixResult(result: BuildResult): result is MatrixBuildResult {
  return "matrices" in result.suite;
}

/** Bench end-to-end: run, print report, finish exports. */
async function runBenchPipeline(
  b: BenchBuildResult,
  args: DefaultCliArgs,
): Promise<void> {
  const groups = await runBench(b.suite, args);
  console.log(
    withStatus("computing report", () =>
      defaultReport(groups, args, { sections: b.sections }),
    ),
  );
  await finishReports(groups, args, { sections: b.sections });
}

/** Matrix end-to-end: filter, run, print report, finish exports. */
async function runMatrixPipeline(
  m: MatrixBuildResult,
  args: DefaultCliArgs,
): Promise<void> {
  const results = await runFilteredMatrices(m.suite, args);
  const groups = matrixToReportGroups(results);
  console.log(
    withStatus("computing report", () =>
      defaultMatrixReport(
        results,
        { sections: m.sections, ...m.reportOptions },
        args,
      ),
    ),
  );
  await finishReports(groups, args, {
    sections: m.sections,
    currentVersion: m.currentVersion,
    baselineVersion: m.baselineVersion,
  });
}

/** Run every matrix in a suite, applying default cases/variants or --filter. */
async function runFilteredMatrices(
  suite: MatrixSuite,
  args: DefaultCliArgs,
): Promise<MatrixResults[]> {
  validateArgs(args);
  const filter = args.filter ? parseMatrixFilter(args.filter) : undefined;
  const options = cliToMatrixOptions(args);

  const results: MatrixResults[] = [];
  for (const matrix of suite.matrices) {
    const filtered = await applyMatrixFilters(matrix, args.all, filter);
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

/** Print available benchmarks for --list, dispatched by suite shape. */
async function listResult(suite: BenchSuite | MatrixSuite): Promise<void> {
  if ("matrices" in suite) await listMatrixSuite(suite);
  else listSuite(suite);
}

/** Print available benchmarks in a bench suite. */
function listSuite(suite: BenchSuite): void {
  for (const group of suite.groups) {
    console.log(group.name);
    for (const bench of group.benchmarks) console.log(`  ${bench.name}`);
    if (group.baseline) console.log(`  ${group.baseline.name} (baseline)`);
  }
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

/** Import a file and run it as a benchmark based on what it exports. */
async function runFileBench(
  filePath: string,
  args: DefaultCliArgs,
): Promise<void> {
  const result = await resolveFileResult(filePath);
  if (!result) return;
  if (args.list) return listResult(result.suite);
  await dispatchResult(result, args);
}

/** Load a benchmark file and shape its default export into a BuildResult. */
async function resolveFileResult(
  filePath: string,
): Promise<BuildResult | undefined> {
  const fileUrl = pathToFileURL(resolve(filePath)).href;
  const { default: candidate } = await import(fileUrl);

  if (candidate && Array.isArray(candidate.matrices)) {
    return { suite: candidate as MatrixSuite };
  }
  if (candidate && Array.isArray(candidate.groups)) {
    return { suite: candidate as BenchSuite };
  }
  if (typeof candidate === "function") {
    const name = basename(filePath).replace(/\.[^.]+$/, "");
    const bench = { name, fn: candidate };
    return { suite: { name, groups: [{ name, benchmarks: [bench] }] } };
  }
  return undefined;
}

/** Require a file argument for a subcommand, exiting with usage on missing. */
function requireFile(filePath: string | undefined, subcommand: string): string {
  if (filePath) return filePath;
  console.error(`Usage: benchforge ${subcommand} <file.benchforge>`);
  process.exit(1);
}
