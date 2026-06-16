import type {
  BrowserProfileParams,
  BrowserProfileResult,
} from "../profiling/browser/BrowserProfiler.ts";
import { profileBrowser } from "../profiling/browser/BrowserProfiler.ts";
import { isBrowserUserCode } from "../profiling/node/HeapSampleReport.ts";
import type { ReportGroup, ReportSection } from "../report/BenchmarkReport.ts";
import colors from "../report/Colors.ts";
import { consoleSummary } from "../report/ConsoleSummary.ts";
import {
  browserGcStatsSection,
  pageLoadStatsSections,
} from "../report/GcSections.ts";
import { prepareHtmlData } from "../report/HtmlReport.ts";
import { runsSection, timeSection } from "../report/StandardSections.ts";
import type { ReportData } from "../viewer/ReportData.ts";
import {
  browserResultGroups,
  nameFromUrl,
  runBrowserBatches,
} from "./BrowserBatcher.ts";
import type { DefaultCliArgs } from "./CliArgs.ts";
import { exportReports } from "./CliExport.ts";
import {
  cliHeapReportOptions,
  needsAlloc,
  needsProfile,
  resolveLimits,
} from "./CliOptions.ts";
import { printHeapReports, withStatus } from "./CliReport.ts";

const { yellow } = colors;

/** Run browser profiling via CDP and report with standard pipeline. */
export async function browserBenchExports(args: DefaultCliArgs): Promise<void> {
  warnBrowserFlags(args);
  const params = buildBrowserParams(args);
  const name = nameFromUrl(args.url!);
  const baselineUrl = args["baseline-url"];

  const needsBatching =
    args.batches > 1 ||
    !!baselineUrl ||
    (args.iterations ?? 0) > 1 ||
    (params.pageLoad ?? false);
  const { raw, results } = await collectBrowserResults(
    needsBatching,
    params,
    name,
    args,
  );

  const reportData = printBrowserReport(raw, results, args);
  await exportReports({ results, args, reportData });
}

/** Warn about Node-only flags ignored in browser mode. */
function warnBrowserFlags(args: DefaultCliArgs): void {
  const checks: [boolean, string][] = [
    [!args.worker, "--no-worker"],
    [!!args["gc-force"], "--gc-force"],
  ];
  const ignored = checks.filter(([active]) => active).map(([, flag]) => flag);
  if (ignored.length > 0)
    console.warn(yellow(`Ignored in browser mode: ${ignored.join(", ")}`));
}

/** Convert CLI args to browser profiler parameters. */
function buildBrowserParams(args: DefaultCliArgs): BrowserProfileParams {
  const { maxTime, maxIterations } = resolveLimits(args);
  const chromeArgs = args["chrome-args"]
    ?.flatMap(a => a.split(/\s+/))
    .map(stripQuotes)
    .filter(Boolean);
  return {
    url: args.url!,
    pageLoad: args["page-load"] || !!args["wait-for"],
    maxTime,
    maxIterations,
    chromeArgs,
    allocOptions: {
      samplingInterval: args["alloc-interval"],
      stackDepth: args["alloc-depth"],
    },
    alloc: needsAlloc(args),
    profile: needsProfile(args),
    profileInterval: args["profile-interval"],
    headless: args.headless,
    chromePath: args.chrome,
    chromeProfile: args["chrome-profile"],
    timeout: args.timeout,
    gcStats: args["gc-stats"],
    callCounts: args["call-counts"],
    waitFor: args["wait-for"],
  };
}

/** Profile the browser once or in batches, returning the last raw result plus
 *  the report groups for the standard export pipeline. */
async function collectBrowserResults(
  needsBatching: boolean,
  params: BrowserProfileParams,
  name: string,
  args: DefaultCliArgs,
): Promise<{ raw: BrowserProfileResult; results: ReportGroup[] }> {
  if (needsBatching) {
    const { lastRaw, results } = await runBrowserBatches(params, name, args);
    return { raw: lastRaw, results };
  }
  const raw = await profileBrowser(params);
  return { raw, results: browserResultGroups(name, raw) };
}

/** Build the report data, print the console summary and optional heap profile
 *  for browser results. @return the report data for reuse by exportReports. */
function printBrowserReport(
  result: BrowserProfileResult,
  results: ReportGroup[],
  args: DefaultCliArgs,
): ReportData | undefined {
  const mr = results[0]?.reports[0]?.measuredResults;
  const hasPageLoad = (mr?.navTimings?.length ?? 0) > 0 || !!result.navTiming;
  const hasIterSamples = !!result.samples?.length;
  const sections: ReportSection[] = [
    ...(hasIterSamples ? [timeSection] : []),
    ...(hasPageLoad ? pageLoadStatsSections : []),
    ...(result.gcStats ? [browserGcStatsSection] : []),
    ...(hasPageLoad || hasIterSamples ? [runsSection] : []),
  ];
  let reportData: ReportData | undefined;
  if (sections.length > 0) {
    reportData = withStatus("computing report", () =>
      prepareHtmlData(results, { cliArgs: args, sections }),
    );
    console.log(consoleSummary(reportData));
  }
  if (result.heapProfile) {
    printHeapReports(results, {
      ...cliHeapReportOptions(args),
      isUserCode: isBrowserUserCode,
    });
  }
  return reportData;
}

/** Strip surrounding quotes from a chrome-args token. */
function stripQuotes(s: string): string {
  const bare = s.replace(/^(['"])(.*)\1$/s, "$2");
  return bare.replace(/^(-[^=]+=)(['"])(.*)\2$/s, "$1$3");
}
