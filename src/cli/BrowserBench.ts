import {
  type BrowserProfileResult,
  type NavTiming,
  profileBrowser,
} from "../profiling/browser/BrowserProfiler.ts";
import { launchChrome } from "../profiling/browser/ChromeLauncher.ts";
import { isBrowserUserCode } from "../profiling/node/HeapSampleReport.ts";
import type { ReportGroup, ReportSection } from "../report/BenchmarkReport.ts";
import colors from "../report/Colors.ts";
import {
  browserGcStatsSection,
  pageLoadStatsSections,
} from "../report/GcSections.ts";
import { buildTimeSection, runsSection } from "../report/StandardSections.ts";
import { reportResults } from "../report/text/TextReport.ts";
import type { MeasuredResults } from "../runners/MeasuredResults.ts";
import {
  type BatchProgress,
  mergeGcStats,
  runBatched,
} from "../runners/MergeBatches.ts";
import { computeStats } from "../runners/SampleStats.ts";
import type { DefaultCliArgs } from "./CliArgs.ts";
import { exportReports } from "./CliExport.ts";
import {
  cliHeapReportOptions,
  needsAlloc,
  needsProfile,
  resolveLimits,
} from "./CliOptions.ts";
import { printHeapReports, withStatus } from "./CliReport.ts";

/** State shared between makeTabRunner closures and runBatchedTabs. */
type TabRunnerState = {
  lastRaw?: BrowserProfileResult;
  detectedPageLoad: boolean;
};

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
    params.pageLoad;
  if (!needsBatching) {
    const result = await profileBrowser(params);
    const results = browserResultGroups(name, result);

    printBrowserReport(result, results, args);
    await exportReports({ results, args });
    return;
  }

  const { lastRaw, results } = await runBrowserBatches(params, name, args);
  printBrowserReport(lastRaw, results, args);
  await exportReports({ results, args });
}

/** Warn about Node-only flags ignored in browser mode. */
function warnBrowserFlags(args: DefaultCliArgs): void {
  const checks: [boolean, string][] = [
    [!args.worker, "--no-worker"],
    [!!args["trace-opt"], "--trace-opt"],
    [!!args["gc-force"], "--gc-force"],
    [!!args.adaptive, "--adaptive"],
  ];
  const ignored = checks.filter(([active]) => active).map(([, flag]) => flag);
  if (ignored.length > 0)
    console.warn(yellow(`Ignored in browser mode: ${ignored.join(", ")}`));
}

/** Convert CLI args to browser profiler parameters. */
function buildBrowserParams(args: DefaultCliArgs) {
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

/** Extract a short name from a URL for report labels. */
function nameFromUrl(url: string): string {
  return new URL(url).pathname.split("/").pop() || "browser";
}

/** Wrap browser profile result as ReportGroup[] for the standard export pipeline. */
function browserResultGroups(
  name: string,
  result: BrowserProfileResult,
): ReportGroup[] {
  const measuredResults = toBrowserMeasured(name, result);
  return [{ name, reports: [{ name, measuredResults }] }];
}

/** Print text report and optional heap profile for browser results. */
function printBrowserReport(
  result: BrowserProfileResult,
  results: ReportGroup[],
  args: DefaultCliArgs,
): void {
  const mr = results[0]?.reports[0]?.measuredResults;
  const hasPageLoad = (mr?.navTimings?.length ?? 0) > 0 || !!result.navTiming;
  const hasIterSamples = !!result.samples?.length;
  const sections: ReportSection[] = [
    ...(hasPageLoad ? pageLoadStatsSections : []),
    ...(hasIterSamples ? [buildTimeSection(args.stats)] : []),
    ...(result.gcStats ? [browserGcStatsSection] : []),
    ...(hasPageLoad || hasIterSamples ? [runsSection] : []),
  ];
  if (sections.length > 0) {
    console.log(
      withStatus("computing report", () => reportResults(results, sections)),
    );
  }
  if (!result.heapProfile) return;
  printHeapReports(results, {
    ...cliHeapReportOptions(args),
    isUserCode: isBrowserUserCode,
  });
}

/** Launch Chrome, run batched fresh tabs, merge results. */
async function runBrowserBatches(
  params: ReturnType<typeof buildBrowserParams>,
  name: string,
  args: DefaultCliArgs,
): Promise<{ lastRaw: BrowserProfileResult; results: ReportGroup[] }> {
  const { headless, chrome: chromePath } = args;
  const chromeProfile = args["chrome-profile"];
  const chrome = await launchChrome({
    headless,
    chromePath,
    chromeProfile,
    args: params.chromeArgs,
  });
  try {
    return await runBatchedTabs(params, name, args, chrome);
  } finally {
    await chrome.close();
  }
}

/** Strip surrounding quotes from a chrome-args token. */
function stripQuotes(s: string): string {
  const bare = s.replace(/^(['"])(.*)\1$/s, "$2");
  return bare.replace(/^(-[^=]+=)(['"])(.*)\2$/s, "$1$3");
}

/** Convert a browser profile result into a MeasuredResults for the report pipeline. */
function toBrowserMeasured(
  name: string,
  result: BrowserProfileResult,
): MeasuredResults {
  const { gcStats, heapProfile, timeProfile, coverage, navTiming, samples } =
    result;
  const navTimings = navTiming ? [navTiming] : undefined;
  const base = {
    name,
    gcStats,
    heapProfile,
    timeProfile,
    coverage,
    navTimings,
  };

  if (samples?.length) {
    const totalTime = result.wallTimeMs ? result.wallTimeMs / 1000 : undefined;
    return { ...base, samples, time: computeStats(samples), totalTime };
  }
  const wallTime = result.wallTimeMs ?? 0;
  return { ...base, samples: [wallTime], time: computeStats([wallTime]) };
}

/** Execute batched browser tabs within an already-launched Chrome instance. */
async function runBatchedTabs(
  params: ReturnType<typeof buildBrowserParams>,
  name: string,
  args: DefaultCliArgs,
  chrome: any,
): Promise<{ lastRaw: BrowserProfileResult; results: ReportGroup[] }> {
  const baselineUrl = args["baseline-url"];
  const { maxTime, maxIterations } = params;
  const limits = { maxTime, maxIterations };
  const state: TabRunnerState = { detectedPageLoad: params.pageLoad };

  const warmup = !(args["warmup-batch"] ?? false) && args.batches > 1;
  const mk = (url: string, label: string) =>
    makeTabRunner(params, chrome, limits, warmup, state, url, label);
  const runCurrent = mk(params.url, name);
  const runBaseline = baselineUrl
    ? mk(baselineUrl, nameFromUrl(baselineUrl))
    : undefined;

  const progress = (p: BatchProgress) => {
    const sec = (p.elapsed / 1000).toFixed(0);
    const msg = `\r◊ batch ${p.batch + 1}/${p.batches} ${p.label} (${sec}s)   `;
    process.stderr.write(msg);
  };

  const {
    results: [current],
    baseline,
  } = await runBatched(
    [runCurrent],
    runBaseline,
    Math.max(args.batches, 2),
    args["warmup-batch"] ?? false,
    progress,
  );
  process.stderr.write("\r" + " ".repeat(50) + "\r");

  const baseName = baselineUrl ? nameFromUrl(baselineUrl) : undefined;
  const baselineEntry =
    baseline && baseName
      ? { name: baseName, measuredResults: baseline }
      : undefined;
  const reports = [{ name, measuredResults: current }];
  return {
    lastRaw: state.lastRaw!,
    results: [{ name, reports, baseline: baselineEntry }],
  };
}

/** Create a batch runner closure for a single URL (current or baseline). */
function makeTabRunner(
  params: ReturnType<typeof buildBrowserParams>,
  chrome: any,
  limits: { maxTime?: number; maxIterations?: number },
  warmup: boolean,
  state: TabRunnerState,
  url: string,
  label: string,
): () => Promise<MeasuredResults> {
  let firstCall = warmup;
  return async () => {
    const isWarmup = firstCall;
    firstCall = false;
    const p = { ...params, chrome, url };
    if (state.detectedPageLoad) {
      const batchLimits = isWarmup ? { maxIterations: 1 } : limits;
      const result = await runMultiPageLoad(
        { ...p, pageLoad: true },
        label,
        batchLimits,
      );
      state.lastRaw ??= {
        navTiming: result.navTimings?.[0],
        wallTimeMs: result.time.p50,
      };
      return result;
    }
    const raw = await profileBrowser(p);
    state.lastRaw = raw;
    // Probe: if no iteration samples and navTiming present, it's page-load mode
    if (!raw.samples?.length && raw.navTiming) state.detectedPageLoad = true;
    return toBrowserMeasured(label, raw);
  };
}

/** Run page loads until duration or iteration limit, collecting wallTimeMs as samples. */
async function runMultiPageLoad(
  params: any, // BrowserProfileParams with chrome attached by caller
  name: string,
  limits: { maxTime?: number; maxIterations?: number },
): Promise<MeasuredResults> {
  const { maxTime, maxIterations } = limits;
  const raws: BrowserProfileResult[] = [];
  let accumulated = 0;
  for (let i = 0; ; i++) {
    if (maxIterations != null && i >= maxIterations) break;
    const raw = await profileBrowser(params);
    raws.push(raw);
    accumulated += raw.wallTimeMs ?? 0;
    if (maxTime != null && accumulated >= maxTime) break;
  }

  const samples = raws.map(r => r.wallTimeMs ?? 0);
  const navTimings = raws.map(r => r.navTiming).filter(Boolean) as NavTiming[];
  const { heapProfile, timeProfile, coverage } = raws[raws.length - 1];
  const totalTime = accumulated / 1000;
  const gcStats = mergeGcStats(raws);
  return {
    name,
    samples,
    time: computeStats(samples),
    totalTime,
    navTimings: navTimings.length ? navTimings : undefined,
    gcStats,
    heapProfile,
    timeProfile,
    coverage,
  };
}
