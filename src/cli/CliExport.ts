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
import { cliHeapReportOptions, needsAlloc } from "./CliOptions.ts";
import { printHeapReports } from "./CliReport.ts";
import { startViewerServer, waitForCtrlC } from "./ViewerServer.ts";

/** Options for exporting benchmark results to various formats */
export interface ExportOptions {
  results: ReportGroup[];
  args: DefaultCliArgs;
  sections?: any[];
  suiteName?: string;
  currentVersion?: GitVersion;
  baselineVersion?: GitVersion;
}

/** Export options specific to matrix benchmarks (no results/args — uses MatrixResults) */
export interface MatrixExportOptions {
  sections?: any[];
  currentVersion?: GitVersion;
  baselineVersion?: GitVersion;
}

type FrameContainer = {
  shared: { frames: { name: string; file?: string; line?: number }[] };
};

/** Export reports (JSON, Perfetto, archive, viewer) based on CLI args */
export async function exportReports(options: ExportOptions): Promise<void> {
  const { results, args, suiteName } = options;
  const { sections, currentVersion, baselineVersion } = options;

  const needsReportData = args.view || args.archive != null;
  const htmlOptions = {
    cliArgs: args,
    sections,
    currentVersion,
    baselineVersion,
  };
  const reportData = needsReportData
    ? prepareHtmlData(results, htmlOptions)
    : undefined;

  exportFileFormats(results, args, suiteName);

  const profileFile = buildSpeedscopeFile(results);
  const timeFile = buildAllTimeProfiles(results);
  const coverageData = await annotateCoverage(results, profileFile, timeFile);

  const timeData = timeFile ? JSON.stringify(timeFile) : undefined;
  if (args.archive != null) {
    const archivePath = args.archive || undefined;
    await archiveBenchmark({
      groups: results,
      reportData,
      timeProfileData: timeData,
      coverageData,
      outputPath: archivePath,
    });
  }

  if (args.view) {
    await openViewer(profileFile, timeData, coverageData, reportData, args);
  }
}

/** Print heap reports (if enabled) and export results */
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

/** Write JSON, Perfetto, and time profile files if requested by CLI args */
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

/** Build combined time profile SpeedScope file from all results */
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

/** Annotate speedscope frame names with coverage counts if available.
 *  Returns serialized coverage map for archive/viewer use. */
async function annotateCoverage(
  results: ReportGroup[],
  profileFile?: FrameContainer,
  timeFile?: FrameContainer,
): Promise<string | undefined> {
  const coverage = mergeCoverage(results);
  if (!coverage) return undefined;

  const coverageUrls = coverage.scripts.map(s => ({ file: s.url }));
  const sources = await collectSources(coverageUrls);
  const result = buildCoverageMap(coverage, sources);
  if (profileFile) annotateFramesWithCounts(profileFile.shared.frames, result);
  if (timeFile) annotateFramesWithCounts(timeFile.shared.frames, result);

  return JSON.stringify(Object.fromEntries(result.map));
}

/** Start viewer server with profile data and block until Ctrl+C */
async function openViewer(
  profileFile: ReturnType<typeof buildSpeedscopeFile>,
  timeData: string | undefined,
  coverageData: string | undefined,
  reportData: ReportData | undefined,
  args: DefaultCliArgs,
): Promise<void> {
  const toJson = (v: unknown) => (v ? JSON.stringify(v) : undefined);
  const viewer = await startViewerServer({
    profileData: toJson(profileFile),
    timeProfileData: timeData,
    coverageData,
    reportData: toJson(reportData),
    editorUri: resolveEditorUri(args.editor),
  });
  await waitForCtrlC();
  viewer.close();
}

/** Export the first raw V8 TimeProfile to a JSON file */
function exportTimeProfile(results: ReportGroup[], path: string): void {
  const profile = findTimeProfile(results);
  if (profile) {
    const absPath = resolve(path);
    writeFileSync(absPath, JSON.stringify(profile));
    console.log(`Time profile exported to: ${path}`);
  } else {
    console.log("No time profiles to export.");
  }
}

/** Merge coverage data from all results into a single CoverageData */
function mergeCoverage(
  results: ReportGroup[],
): import("../profiling/node/CoverageTypes.ts").CoverageData | undefined {
  const scripts = results.flatMap(group =>
    groupReports(group).flatMap(r => r.measuredResults.coverage?.scripts ?? []),
  );
  return scripts.length > 0 ? { scripts } : undefined;
}

/** Find the first raw V8 TimeProfile in results */
function findTimeProfile(
  results: ReportGroup[],
): import("../profiling/node/TimeSampler.ts").TimeProfile | undefined {
  const reports = results.flatMap(g => groupReports(g));
  return reports.find(r => r.measuredResults.timeProfile)?.measuredResults
    .timeProfile;
}
