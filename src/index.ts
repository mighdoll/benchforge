export type { Configure, DefaultCliArgs } from "./cli/CliArgs.ts";
export { browserCliArgs, defaultCliArgs, parseCliArgs } from "./cli/CliArgs.ts";
export type { ExportOptions, MatrixExportOptions } from "./cli/RunBenchCLI.ts";
export {
  benchExports,
  cliToMatrixOptions,
  defaultMatrixReport,
  defaultReport,
  exportReports,
  hasField,
  matrixBenchExports,
  matrixToReportGroups,
  parseBenchArgs,
  printHeapReports,
  reportOptStatus,
  runBenchmarks,
  runDefaultBench,
  runDefaultMatrixBench,
  runMatrixSuite,
} from "./cli/RunBenchCLI.ts";
export type { MeasuredResults } from "./core/MeasuredResults.ts";
export {
  archiveBenchmark,
  buildSpeedscopeFile,
  exportSpeedscope,
  heapProfileToSpeedscope,
} from "./export/AllocExport.ts";
export * from "./export/JsonFormat.ts";
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
export type {
  ExtraColumn,
  MatrixReportOptions,
} from "./matrix/MatrixReport.ts";
export {
  gcPauseColumn,
  gcStatsColumns,
  heapTotalColumn,
  reportMatrixResults,
} from "./matrix/MatrixReport.ts";
export type {
  BenchmarkReport,
  ReportColumnGroup,
  ReportGroup,
  ResultsMapper,
  UnknownRecord,
} from "./report/BenchmarkReport.ts";
export {
  formatBytes,
  integer,
  timeMs,
  truncate,
} from "./report/Formatters.ts";
export type { GitVersion } from "./report/GitUtils.ts";
export {
  formatGitVersion,
  getBaselineVersion,
  getCurrentGitVersion,
} from "./report/GitUtils.ts";
export type { PrepareHtmlOptions } from "./report/HtmlReport.ts";
export { prepareHtmlData } from "./report/HtmlReport.ts";
export {
  adaptiveSection,
  buildGenericSections,
  gcSection,
  gcStatsSection,
  optSection,
  runsSection,
  timeSection,
  totalTimeSection,
} from "./report/StandardSections.ts";
export { formatConvergence } from "./report/text/ConvergenceFormatters.ts";
export { reportResults } from "./report/text/TextReport.ts";
export type {
  BenchGroup,
  BenchmarkSpec,
  BenchSuite,
} from "./runners/BenchmarkSpec.ts";
export type { RunnerOptions } from "./runners/BenchRunner.ts";
export { average } from "./stats/StatisticalUtils.ts";
export {
  formatDateWithTimezone,
  formatRelativeTime,
} from "./viewer/DateFormat.ts";
export type { ReportData } from "./viewer/ReportData.ts";
