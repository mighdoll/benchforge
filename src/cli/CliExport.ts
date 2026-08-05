import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { buildSpeedscopeFile } from "../export/AllocExport.ts";
import { archiveBenchmark, collectSources } from "../export/ArchiveExport.ts";
import {
  annotateFramesWithCounts,
  buildCoverageMap,
} from "../export/CoverageExport.ts";
import { resolveEditorUri } from "../export/EditorUri.ts";
import { exportPerfettoTrace } from "../export/PerfettoExport.ts";
import { userOnlySpeedscope } from "../export/SpeedscopeFilter.ts";
import { buildTimeSpeedscopeFile } from "../export/TimeExport.ts";
import type { CoverageData } from "../profiling/node/CoverageTypes.ts";
import type { ReportGroup, ReportSection } from "../report/BenchmarkReport.ts";
import { groupReports } from "../report/BenchmarkReport.ts";
import type { GitVersion } from "../report/GitUtils.ts";
import { keptProfilesOf, prepareHtmlData } from "../report/HtmlReport.ts";
import { markdownReport } from "../report/MarkdownReport.ts";
import {
  abNoiseRecords,
  appendNoiseLog,
  machineId,
} from "../report/NoiseLog.ts";
import type { ReportData } from "../viewer/ReportData.ts";
import type { DefaultCliArgs } from "./CliArgs.ts";
import {
  allocUserOnly,
  cliComparisonOptions,
  profileUserOnly,
  shouldViewReport,
} from "./CliOptions.ts";
import { printRawSamples, withStatus } from "./CliReport.ts";
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
  /** Prebuilt report data to reuse, skipping a second prepareHtmlData pass. */
  reportData?: ReportData;
}

/** Export options for matrix benchmarks; the matrix pipeline supplies results/args. */
export type MatrixExportOptions = Omit<ExportOptions, "results" | "args">;

type FrameContainer = {
  shared: { frames: { name: string; file?: string; line?: number }[] };
};

// The shared output dir users gitignore, where everything a run emits lands:
// markdown reports, the noise log, and archives. benchforge writes no HTML to
// disk (reports are JSON archives + the in-memory viewer), so markdown sits
// here flat.
const reportDir = "bench-report";

/** Export reports (JSON, Perfetto, archive, viewer) based on CLI args. */
export async function exportReports(options: ExportOptions): Promise<void> {
  const { results, args, sections, currentVersion, baselineVersion } = options;

  const comparison = cliComparisonOptions(args);
  const htmlOpts = {
    cliArgs: args,
    sections,
    currentVersion,
    baselineVersion,
    ...comparison,
  };
  // Reuse the prebuilt report data when the pipeline already computed it (the
  // console summary builds it first); otherwise compute it here. The markdown
  // report below is always written, and the viewer/archive reuse the same data.
  const reportData =
    options.reportData ??
    withStatus("computing viewer data", () =>
      prepareHtmlData(results, htmlOpts),
    );

  writeMarkdownReport(reportData, args);
  appendNoiseLog(abNoiseRecords(reportData, machineId()));
  exportFileFormats(results, args);

  // User-only (default on) hides node internals, GC, and the profiler's own
  // inspector frames from the flamegraphs, matching the summary rows; the same
  // filtered files feed the live viewer and the archive.
  const profileFile = userOnlySpeedscope(
    buildSpeedscopeFile(results),
    allocUserOnly(args),
  );
  const timeFile = userOnlySpeedscope(
    buildAllTimeProfiles(results, comparison.noBatchTrim),
    profileUserOnly(args),
  );
  const coverageData = await annotateCoverage(results, profileFile, timeFile);
  const timeData = optionalJson(timeFile);

  if (args.archive != null) {
    await archiveBenchmark({
      groups: results,
      allocProfile: profileFile,
      reportData,
      timeProfileData: timeData,
      coverageData,
      outputPath: args.archive || undefined,
      outputDir: reportDir,
    });
  }
  if (shouldViewReport(args)) {
    await openViewer(profileFile, timeData, coverageData, reportData, args);
  }
}

/** Dump raw allocation samples (if requested) and export results. The
 *  aggregated heap attribution table is written into the markdown report. */
export async function finishReports(
  results: ReportGroup[],
  args: DefaultCliArgs,
  exportOptions?: MatrixExportOptions,
): Promise<void> {
  if (args["alloc-raw"]) printRawSamples(results);
  await exportReports({ results, args, ...exportOptions });
}

/** Write a calibration markdown report so its noise floor and suggested margin
 *  are recallable. Mirrors writeMarkdownReport: `--report-md <path>` writes a
 *  single explicit file, else a timestamped file plus a stable
 *  `calibrate-latest.md` in bench-report/. */
export function writeCalibrationReport(
  md: string,
  timestamp: string,
  args: DefaultCliArgs,
): void {
  writeStampedReport(md, timestamp, args, "calibrate");
}

/** Write a markdown report to bench-report/: a single explicit file when
 *  `--report-md <path>` overrides, else a timestamped file plus a stable
 *  "latest" file. Shared by the benchmark and calibration report writers,
 *  which differ only in filename prefix and log wording. */
function writeStampedReport(
  md: string,
  timestamp: string,
  args: DefaultCliArgs,
  kind: "bench" | "calibrate",
): void {
  const label = kind === "calibrate" ? "Calibration report" : "Markdown report";
  const override = args["report-md"];
  if (override) {
    const path = resolve(override);
    writeFileSync(path, md);
    console.log(`${label} written to: ${path}`);
    return;
  }
  mkdirSync(reportDir, { recursive: true });
  const stamp = fileStamp(timestamp);
  const prefix = kind === "calibrate" ? "calibrate-" : "bench-";
  const latestName = kind === "calibrate" ? "calibrate-latest.md" : "latest.md";
  const timestamped = resolve(join(reportDir, `${prefix}${stamp}.md`));
  const latest = resolve(join(reportDir, latestName));
  writeFileSync(timestamped, md);
  writeFileSync(latest, md);
  console.log(`${label} written to: ${latest} (and ${timestamped})`);
}

/** Write the always-on markdown report (shift tables + GC/scalar comparison) so
 *  agents and other text consumers get the full distribution the HTML viewer
 *  shows. Default: a timestamped file plus a stable `latest.md` in bench-report/
 *  (history preserved, predictable path for agents). `--report-md <path>` writes
 *  a single explicit file instead. */
function writeMarkdownReport(data: ReportData, args: DefaultCliArgs): void {
  writeStampedReport(
    markdownReport(data),
    data.metadata.timestamp,
    args,
    "bench",
  );
}

/** Write Perfetto and time profile files if requested by CLI args. */
function exportFileFormats(results: ReportGroup[], args: DefaultCliArgs): void {
  if (args["export-perfetto"])
    exportPerfettoTrace(results, args["export-perfetto"], args);
  if (args["export-profile"])
    exportTimeProfile(results, args["export-profile"]);
}

/** Build combined Speedscope file from all time profiles in results, pooling
 *  each benchmark's kept batch profiles (same source and Tukey trim the markdown
 *  hot-functions summary uses) so the flamegraph reflects every sampled tick from
 *  the batches the verdict keeps, not one batch and not the noisy outliers. */
function buildAllTimeProfiles(results: ReportGroup[], noTrim?: boolean) {
  const entries = results.flatMap(group =>
    groupReports(group)
      .map(r => ({
        name: r.name,
        profiles: keptProfilesOf(r.measuredResults, noTrim).profiles,
      }))
      .filter(e => e.profiles.length > 0),
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

/** ISO timestamp ==> filename-safe stamp (drop ms/zone, ':' is illegal on Windows). */
function fileStamp(iso: string): string {
  return iso.replace(/\.\d+Z$/, "").replace(/[:]/g, "-");
}

/** Export the first raw V8 TimeProfile to a JSON file. Stays a single
 *  (last-kept-batch) profile by design: this is the raw V8 node-tree shape for
 *  external tools, which can't pool across batches the way the sampled
 *  speedscope flamegraph does. */
function exportTimeProfile(results: ReportGroup[], path: string): void {
  const profile = results
    .flatMap(g => groupReports(g))
    .find(r => r.measuredResults.timeProfile)?.measuredResults.timeProfile;
  if (!profile) {
    console.log("No time profiles to export.");
    return;
  }
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
