import { runSingleUrlBrowser } from "../matrix/MatrixBrowserRunner.ts";
import { isBrowserUserCode } from "../profiling/node/HeapSampleReport.ts";
import type { ReportSection } from "../report/BenchmarkReport.ts";
import colors from "../report/Colors.ts";
import { consoleSummary } from "../report/ConsoleSummary.ts";
import {
  browserGcStatsSection,
  pageLoadStatsSections,
} from "../report/GcSections.ts";
import { prepareHtmlData } from "../report/HtmlReport.ts";
import { runsSection, timeSection } from "../report/StandardSections.ts";
import type { MeasuredResults } from "../runners/MeasuredResults.ts";
import type { DefaultCliArgs } from "./CliArgs.ts";
import { finishReports } from "./CliExport.ts";
import {
  cliComparisonOptions,
  cliHeapReportOptions,
  cliToMatrixOptions,
} from "./CliOptions.ts";
import { matrixToReportGroups, withStatus } from "./CliReport.ts";

const { yellow } = colors;

/** Run a bare `--url` browser benchmark and report with the standard pipeline.
 *  The page owns the benchmark, so this runs as a synthesized one-variant matrix
 *  (see runSingleUrlBrowser) that shares the batching, stats, and report code
 *  with the inline browser-matrix path. */
export async function browserBenchExports(args: DefaultCliArgs): Promise<void> {
  warnBrowserFlags(args);
  const options = cliToMatrixOptions(args);
  const results = await runSingleUrlBrowser(
    args.url!,
    args["baseline-url"],
    options,
  );
  const groups = matrixToReportGroups([results]);

  const measured = groups[0]?.reports[0]?.measuredResults;
  const sections = browserSections(measured, args["gc-stats"] ?? false);
  const reportData = sections.length
    ? withStatus("computing report", () =>
        prepareHtmlData(groups, {
          cliArgs: args,
          sections,
          heapReport: {
            ...cliHeapReportOptions(args),
            isUserCode: isBrowserUserCode,
          },
          ...cliComparisonOptions(args),
        }),
      )
    : undefined;
  if (reportData) console.log(consoleSummary(reportData));
  await finishReports(groups, args, { sections, reportData });
}

/** Warn about Node-only flags ignored in browser mode. */
export function warnBrowserFlags(args: DefaultCliArgs): void {
  const checks: [boolean, string][] = [
    [!args.worker, "--no-worker"],
    [!!args["gc-force"], "--gc-force"],
    [args["max-samples"] != null, "--max-samples"],
  ];
  const ignored = checks.filter(([active]) => active).map(([, flag]) => flag);
  if (ignored.length > 0)
    console.warn(yellow(`Ignored in browser mode: ${ignored.join(", ")}`));
}

/** Select report sections for a browser result: a mean-time metric for bench
 *  pages, per-metric page-load nav stats for page-load pages, optional GC, and a
 *  runs footer. Page load has no per-iteration metric, so it shows nav stats
 *  instead of the time section. */
function browserSections(
  measured: MeasuredResults | undefined,
  gcStats: boolean,
): ReportSection[] {
  const hasPageLoad = (measured?.navTimings?.length ?? 0) > 0;
  const hasIterSamples = !hasPageLoad && (measured?.samples?.length ?? 0) > 0;
  return [
    ...(hasIterSamples ? [timeSection] : []),
    ...(hasPageLoad ? pageLoadStatsSections : []),
    ...(gcStats ? [browserGcStatsSection] : []),
    ...(hasPageLoad || hasIterSamples ? [runsSection] : []),
  ];
}
