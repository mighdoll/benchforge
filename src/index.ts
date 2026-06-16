export type { DefaultCliArgs } from "./cli/CliArgs.ts";
export {
  type BenchCliConfig,
  type BuildResult,
  runBenchCli,
} from "./cli/RunBenchCLI.ts";
export type {
  AnyVariant,
  BenchMatrix,
  CaseResult,
  InlineCases,
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
export { metricSection, scalarSection } from "./report/BenchmarkReport.ts";
export { formatBytes, integer, timeMs } from "./report/Formatters.ts";
export { gcSections, gcStatsSection } from "./report/GcSections.ts";
export type { GitVersion } from "./report/GitUtils.ts";
export { getBaselineVersion, getCurrentGitVersion } from "./report/GitUtils.ts";
export { runsSection, timeSection } from "./report/StandardSections.ts";
export type { MeasuredResults } from "./runners/MeasuredResults.ts";
export type { StatKind } from "./stats/CoreStats.ts";
export { mean } from "./stats/CoreStats.ts";
