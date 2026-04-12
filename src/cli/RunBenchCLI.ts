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
import type { ReportSection } from "../report/BenchmarkReport.ts";
import type { BenchSuite } from "../runners/BenchmarkSpec.ts";
import { browserBenchExports } from "./BrowserBench.ts";
import {
  type Configure,
  type DefaultCliArgs,
  parseCliArgs,
} from "./CliArgs.ts";
import { finishReports, type MatrixExportOptions } from "./CliExport.ts";
import { cliToMatrixOptions, validateArgs } from "./CliOptions.ts";
import {
  defaultMatrixReport,
  defaultReport,
  matrixToReportGroups,
  withStatus,
} from "./CliReport.ts";
import { runBenchmarks } from "./SuiteRunner.ts";

/** Options for running a BenchSuite: custom sections replace the CLI-derived defaults. */
export interface BenchExportsOptions {
  sections?: ReportSection[];
}

/** Top-level CLI dispatch: route to view, analyze, or default bench runner. */
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
  await runDefaultBench(undefined, undefined, argv);
}

/** Run benchmarks and display results. Suite is optional with --url (browser mode). */
export async function runDefaultBench(
  suite?: BenchSuite,
  configureArgs?: Configure<any>,
  argv?: string[],
  opts?: BenchExportsOptions,
): Promise<void> {
  const args = parseBenchArgs(configureArgs, argv);
  if (args.url) return browserBenchExports(args);
  if (args.list && suite) return listSuite(suite);
  if (suite) return benchExports(suite, args, opts);
  if (args.file) return fileBenchExports(args.file, args);
  throw new Error(
    "Provide a benchmark file, --url for browser mode, or pass a BenchSuite directly.",
  );
}

/** Parse CLI args with optional custom yargs configuration. */
export function parseBenchArgs<T = DefaultCliArgs>(
  configureArgs?: Configure<T>,
  argv?: string[],
): T & DefaultCliArgs {
  const args = argv ?? hideBin(process.argv);
  return parseCliArgs(args, configureArgs) as T & DefaultCliArgs;
}

/** Run a BenchSuite and print results with standard reporting. */
export async function benchExports(
  suite: BenchSuite,
  args: DefaultCliArgs,
  opts?: BenchExportsOptions,
): Promise<void> {
  const results = await runBenchmarks(suite, args);
  console.log(
    withStatus("computing report", () => defaultReport(results, args, opts)),
  );
  await finishReports(results, args, opts);
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

/** Run a matrix suite, print results, and handle exports. */
export async function matrixBenchExports(
  suite: MatrixSuite,
  args: DefaultCliArgs,
  reportOptions?: MatrixReportOptions,
  exportOptions?: MatrixExportOptions,
): Promise<void> {
  const results = await runMatrixSuite(suite, args);
  const report = withStatus("computing report", () =>
    defaultMatrixReport(results, reportOptions, args),
  );
  console.log(report);

  const groups = matrixToReportGroups(results);
  await finishReports(groups, args, exportOptions);
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

/** Require a file argument for a subcommand, exiting with usage on missing. */
function requireFile(filePath: string | undefined, subcommand: string): string {
  if (filePath) return filePath;
  console.error(`Usage: benchforge ${subcommand} <file.benchforge>`);
  process.exit(1);
}

/** Print available benchmarks in a suite for --list. */
function listSuite(suite: BenchSuite): void {
  for (const group of suite.groups) {
    console.log(group.name);
    for (const bench of group.benchmarks) console.log(`  ${bench.name}`);
    if (group.baseline) console.log(`  ${group.baseline.name} (baseline)`);
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

/** Print available cases and variants in a matrix suite for --list. */
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
