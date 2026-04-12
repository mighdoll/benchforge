import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { buildSpeedscopeFile } from "../export/AllocExport.ts";
import { archiveBenchmark, collectSources } from "../export/ArchiveExport.ts";
import {
  annotateFramesWithCounts,
  buildCoverageMap,
} from "../export/CoverageExport.ts";
import { resolveEditorUri } from "../export/EditorUri.ts";
import { exportPerfettoTrace } from "../export/PerfettoExport.ts";
import { buildTimeSpeedscopeFile } from "../export/TimeExport.ts";
import type { CoverageData } from "../profiling/node/CoverageTypes.ts";
import type { TimeProfile } from "../profiling/node/TimeSampler.ts";
import type { ReportGroup, ReportSection } from "../report/BenchmarkReport.ts";
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
import { printHeapReports, withStatus } from "./CliReport.ts";
import {
  optionalJson,
  startViewerServer,
  waitForCtrlC,
} from "./ViewerServer.ts";

/** Options for exporting benchmark results to various formats */
export interface ExportOptions {
  results: ReportGroup[];
  args: DefaultCliArgs;
  sections?: ReportSection[];
  currentVersion?: GitVersion;
  baselineVersion?: GitVersion;
}

/** Export options for matrix benchmarks (results/args supplied by the matrix pipeline). */
export interface MatrixExportOptions {
  sections?: ReportSection[];
  currentVersion?: GitVersion;
  baselineVersion?: GitVersion;
}

type FrameContainer = {
  shared: { frames: { name: string; file?: string; line?: number }[] };
};

/** Export reports (JSON, Perfetto, archive, viewer) based on CLI args. */
export async function exportReports(options: ExportOptions): Promise<void> {
  const { results, args, sections, currentVersion, baselineVersion } = options;

  const wantViewer = args.view || args["view-serve"] || args.archive != null;
  const comparison = cliComparisonOptions(args);
  const htmlOpts = {
    cliArgs: args,
    sections,
    currentVersion,
    baselineVersion,
    ...comparison,
  };
  const reportData = wantViewer
    ? withStatus("computing viewer data", () =>
        prepareHtmlData(results, htmlOpts),
      )
    : undefined;

  exportFileFormats(results, args);

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
  if (args.view || args["view-serve"]) {
    await openViewer(profileFile, timeData, coverageData, reportData, args);
  }
}

/** Print heap reports (if enabled) and export results. */
export async function finishReports(
  results: ReportGroup[],
  args: DefaultCliArgs,
  exportOptions?: MatrixExportOptions,
): Promise<void> {
  if (needsAlloc(args)) {
    printHeapReports(results, cliHeapReportOptions(args));
  }
  await exportReports({ results, args, ...exportOptions });
}

/** Write Perfetto and time profile files if requested by CLI args. */
function exportFileFormats(results: ReportGroup[], args: DefaultCliArgs): void {
  if (args["export-perfetto"])
    exportPerfettoTrace(results, args["export-perfetto"], args);
  if (args["export-profile"])
    exportTimeProfile(results, args["export-profile"]);
}

/** Build combined Speedscope file from all time profiles in results. */
function buildAllTimeProfiles(results: ReportGroup[]) {
  const entries = results.flatMap(group =>
    groupReports(group)
      .filter(r => r.measuredResults.timeProfile)
      .map(r => ({
        name: r.name,
        profile: r.measuredResults.timeProfile as TimeProfile,
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

  const frames = coverage.scripts.map(s => ({ file: s.url }));
  const sources = await collectSources(frames);
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
    open: !args["view-serve"],
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
function mergeCoverage(results: ReportGroup[]): CoverageData | undefined {
  const scripts = results.flatMap(group =>
    groupReports(group).flatMap(r => r.measuredResults.coverage?.scripts ?? []),
  );
  return scripts.length > 0 ? { scripts } : undefined;
}
