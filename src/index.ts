export type { Configure, DefaultCliArgs } from "./cli/CliArgs.ts";
export { browserCliArgs, defaultCliArgs, parseCliArgs } from "./cli/CliArgs.ts";
export type { ExportOptions, MatrixExportOptions } from "./cli/CliExport.ts";
export { exportReports } from "./cli/CliExport.ts";
export { cliToMatrixOptions } from "./cli/CliOptions.ts";
export {
  defaultMatrixReport,
  defaultReport,
  matrixToReportGroups,
  printHeapReports,
  reportOptStatus,
} from "./cli/CliReport.ts";
export {
  benchExports,
  dispatchCli,
  matrixBenchExports,
  parseBenchArgs,
  runDefaultBench,
  runDefaultMatrixBench,
  runMatrixSuite,
} from "./cli/RunBenchCLI.ts";
export { runBenchmarks } from "./cli/SuiteRunner.ts";
export {
  buildSpeedscopeFile,
  exportSpeedscope,
  heapProfileToSpeedscope,
} from "./export/AllocExport.ts";
export { archiveBenchmark } from "./export/ArchiveExport.ts";
export type {
  ArchiveMetadata,
  BenchforgeArchive,
} from "./export/ArchiveFormat.ts";
export { exportPerfettoTrace } from "./export/PerfettoExport.ts";
export type {
  AnyVariant,
  BenchMatrix,
  CaseResult,
  LoadedCase,
  MatrixDefaults,
  MatrixResults,
  MatrixSuite,
  RunMatrixOptions,
  StatefulVariant,
  Variant,
  VariantFn,
  VariantResult,
} from "./matrix/BenchMatrix.ts";
export { isStatefulVariant, runMatrix } from "./matrix/BenchMatrix.ts";
export type { CasesModule } from "./matrix/CaseLoader.ts";
export { loadCaseData, loadCasesModule } from "./matrix/CaseLoader.ts";
export type { FilteredMatrix, MatrixFilter } from "./matrix/MatrixFilter.ts";
export { filterMatrix, parseMatrixFilter } from "./matrix/MatrixFilter.ts";
export type { MatrixReportOptions } from "./matrix/MatrixReport.ts";
export { reportMatrixResults } from "./matrix/MatrixReport.ts";
export type {
  BenchmarkReport,
  ComparisonOptions,
  ReportColumn,
  ReportGroup,
  ReportSection,
  UnknownRecord,
} from "./report/BenchmarkReport.ts";
export {
  computeColumnValues,
  hasField,
} from "./report/BenchmarkReport.ts";
export {
  formatBytes,
  formatConvergence,
  integer,
  timeMs,
  truncate,
} from "./report/Formatters.ts";
export {
  gcSection,
  gcSections,
  gcStatsSection,
} from "./report/GcSections.ts";
export type { GitVersion } from "./report/GitUtils.ts";
export {
  formatGitVersion,
  getBaselineVersion,
  getCurrentGitVersion,
} from "./report/GitUtils.ts";
export type { PrepareHtmlOptions } from "./report/HtmlReport.ts";
export { prepareHtmlData } from "./report/HtmlReport.ts";
export {
  adaptiveSections,
  buildGenericSections,
  buildTimeSection,
  optSection,
  runsSection,
  timeSection,
  totalTimeSection,
} from "./report/StandardSections.ts";
export { reportResults } from "./report/text/TextReport.ts";
export type {
  BenchGroup,
  BenchmarkSpec,
  BenchSuite,
} from "./runners/BenchmarkSpec.ts";
export type { RunnerOptions } from "./runners/BenchRunner.ts";
export type { MeasuredResults } from "./runners/MeasuredResults.ts";
export {
  average,
  computeStat,
  isBootstrappable,
  maxBootstrapInput,
  median,
  percentile,
  type StatKind,
} from "./stats/StatisticalUtils.ts";
export {
  formatDateWithTimezone,
  formatRelativeTime,
} from "./viewer/DateFormat.ts";
export type { ReportData } from "./viewer/ReportData.ts";
