import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
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
import type { ReportGroup } from "../report/BenchmarkReport.ts";
import { groupReports } from "../report/BenchmarkReport.ts";
import type { GitVersion } from "../report/GitUtils.ts";
import { prepareHtmlData } from "../report/HtmlReport.ts";
import type { ReportData } from "../viewer/ReportData.ts";
import type { DefaultCliArgs } from "./CliArgs.ts";
import {
  cliComparisonOptions,
  cliHeapReportOptions,
  needsAlloc,
} from "./CliOptions.ts";
import { printHeapReports } from "./CliReport.ts";
import {
  optionalJson,
  startViewerServer,
  waitForCtrlC,
} from "./ViewerServer.ts";

/** Options for exporting benchmark results to various formats */
export interface ExportOptions {
  results: ReportGroup[];
  args: DefaultCliArgs;
  sections?: any[];
  suiteName?: string;
  currentVersion?: GitVersion;
  baselineVersion?: GitVersion;
}

/** Export options for matrix benchmarks (results and args come from the matrix pipeline). */
export interface MatrixExportOptions {
  sections?: any[];
  currentVersion?: GitVersion;
  baselineVersion?: GitVersion;
}

type FrameContainer = {
  shared: { frames: { name: string; file?: string; line?: number }[] };
};

/** Export reports (JSON, Perfetto, archive, viewer) based on CLI args. */
export async function exportReports(options: ExportOptions): Promise<void> {
  const { results, args, suiteName } = options;
  const { sections, currentVersion, baselineVersion } = options;

  const needsReportData = args.view || args.archive != null;
  const htmlOpts = {
    cliArgs: args,
    sections,
    currentVersion,
    baselineVersion,
    ...cliComparisonOptions(args),
  };
  const reportData = needsReportData
    ? prepareHtmlData(results, htmlOpts)
    : undefined;

  exportFileFormats(results, args, suiteName);

  const profileFile = buildSpeedscopeFile(results);
  const timeFile = buildAllTimeProfiles(results);
  const coverageData = await annotateCoverage(results, profileFile, timeFile);
  const timeData = timeFile ? JSON.stringify(timeFile) : undefined;

  if (args.archive != null) {
    const outputPath = args.archive || undefined;
    await archiveBenchmark({
      groups: results,
      reportData,
      timeProfileData: timeData,
      coverageData,
      outputPath,
    });
  }
  if (args.view) {
    await openViewer(profileFile, timeData, coverageData, reportData, args);
  }
}

/** Print heap reports (if enabled) and export results. */
export async function finishReports(
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

/** Write JSON, Perfetto, and time profile files if requested by CLI args. */
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

/** Build combined Speedscope file from all time profiles in results. */
function buildAllTimeProfiles(results: ReportGroup[]) {
  type TP = import("../profiling/node/TimeSampler.ts").TimeProfile;
  const entries = results.flatMap(group =>
    groupReports(group)
      .filter(r => r.measuredResults.timeProfile)
      .map(r => ({
        name: r.name,
        profile: r.measuredResults.timeProfile as TP,
      })),
  );
  return buildTimeSpeedscopeFile(entries);
}

/** Annotate speedscope frame names with coverage counts. Returns serialized coverage map. */
async function annotateCoverage(
  results: ReportGroup[],
  profileFile?: FrameContainer,
  timeFile?: FrameContainer,
): Promise<string | undefined> {
  const coverage = mergeCoverage(results);
  if (!coverage) return undefined;

  const files = coverage.scripts.map(s => ({ file: s.url }));
  const sources = await collectSources(files);
  const covMap = buildCoverageMap(coverage, sources);
  if (profileFile) annotateFramesWithCounts(profileFile.shared.frames, covMap);
  if (timeFile) annotateFramesWithCounts(timeFile.shared.frames, covMap);
  return JSON.stringify(Object.fromEntries(covMap.map));
}

/** Start viewer server with profile data and block until Ctrl+C. */
async function openViewer(
  profileFile: ReturnType<typeof buildSpeedscopeFile>,
  timeData: string | undefined,
  coverageData: string | undefined,
  reportData: ReportData | undefined,
  args: DefaultCliArgs,
): Promise<void> {
  const viewer = await startViewerServer({
    profileData: optionalJson(profileFile),
    timeProfileData: timeData,
    coverageData,
    reportData: optionalJson(reportData),
    editorUri: resolveEditorUri(args.editor),
  });
  await waitForCtrlC();
  viewer.close();
}

/** Export the first raw V8 TimeProfile to a JSON file. */
function exportTimeProfile(results: ReportGroup[], path: string): void {
  const profile = results
    .flatMap(g => groupReports(g))
    .find(r => r.measuredResults.timeProfile)?.measuredResults.timeProfile;
  if (!profile) return void console.log("No time profiles to export.");
  writeFileSync(resolve(path), JSON.stringify(profile));
  console.log(`Time profile exported to: ${path}`);
}

/** Merge coverage data from all results into a single CoverageData. */
function mergeCoverage(
  results: ReportGroup[],
): import("../profiling/node/CoverageTypes.ts").CoverageData | undefined {
  const scripts = results.flatMap(group =>
    groupReports(group).flatMap(r => r.measuredResults.coverage?.scripts ?? []),
  );
  return scripts.length > 0 ? { scripts } : undefined;
}
