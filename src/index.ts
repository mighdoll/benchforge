export type { DefaultCliArgs } from "./cli/CliArgs.ts";
export type { ExportOptions, MatrixExportOptions } from "./cli/CliExport.ts";
export {
  type BenchCliConfig,
  type BuildResult,
  dispatchCli,
  runBenchCli,
} from "./cli/RunBenchCLI.ts";
export { buildSpeedscopeFile } from "./export/AllocExport.ts";
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
export { isStatefulVariant } from "./matrix/BenchMatrix.ts";
export type { CasesModule } from "./matrix/CaseLoader.ts";
export { loadCaseData, loadCasesModule } from "./matrix/CaseLoader.ts";
export type { FilteredMatrix, MatrixFilter } from "./matrix/MatrixFilter.ts";
export { filterMatrix, parseMatrixFilter } from "./matrix/MatrixFilter.ts";
export { reportMatrixResults } from "./matrix/MatrixReport.ts";
export type {
  BenchmarkReport,
  ComparisonOptions,
  Formatter,
  MetricSection,
  ReportGroup,
  ReportSection,
  ScalarRow,
  ScalarSection,
  UnknownRecord,
} from "./report/BenchmarkReport.ts";
export {
  hasField,
  metricSection,
  metricStatKind,
  scalarSection,
} from "./report/BenchmarkReport.ts";
export { consoleSummary } from "./report/ConsoleSummary.ts";
export { formatBytes, integer, timeMs } from "./report/Formatters.ts";
export { gcSections, gcStatsSection } from "./report/GcSections.ts";
export type { GitVersion } from "./report/GitUtils.ts";
export {
  formatGitVersion,
  getBaselineVersion,
  getCurrentGitVersion,
} from "./report/GitUtils.ts";
export type { PrepareHtmlOptions } from "./report/HtmlReport.ts";
export { prepareHtmlData } from "./report/HtmlReport.ts";
export { markdownReport } from "./report/MarkdownReport.ts";
export { runsSection, timeSection } from "./report/StandardSections.ts";
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
