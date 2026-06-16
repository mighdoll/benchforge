import type {
  BrowserProfileParams,
  BrowserProfileResult,
  NavTiming,
} from "../profiling/browser/BrowserProfiler.ts";
import { profileBrowser } from "../profiling/browser/BrowserProfiler.ts";
import type { ChromeInstance } from "../profiling/browser/ChromeLauncher.ts";
import { launchChrome } from "../profiling/browser/ChromeLauncher.ts";
import type { ReportGroup } from "../report/BenchmarkReport.ts";
import type { MeasuredResults } from "../runners/MeasuredResults.ts";
import {
  type BatchProgress,
  mergeGcStats,
  runBatched,
} from "../runners/MergeBatches.ts";
import { computeStats } from "../runners/SampleStats.ts";
import type { DefaultCliArgs } from "./CliArgs.ts";

/** State shared between makeTabRunner closures and runBatchedTabs. */
type TabRunnerState = {
  lastRaw?: BrowserProfileResult;
  detectedPageLoad: boolean;
};

/** Extract a short name from a URL for report labels. */
export function nameFromUrl(url: string): string {
  return new URL(url).pathname.split("/").pop() || "browser";
}

/** Wrap browser profile result as ReportGroup[] for the standard export pipeline. */
export function browserResultGroups(
  name: string,
  result: BrowserProfileResult,
): ReportGroup[] {
  const measuredResults = toBrowserMeasured(name, result);
  return [{ name, reports: [{ name, measuredResults }] }];
}

/** Launch Chrome, run batched fresh tabs, merge results. */
export async function runBrowserBatches(
  params: BrowserProfileParams,
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

/** Execute batched browser tabs within an already-launched Chrome instance. */
async function runBatchedTabs(
  params: BrowserProfileParams,
  name: string,
  args: DefaultCliArgs,
  chrome: ChromeInstance,
): Promise<{ lastRaw: BrowserProfileResult; results: ReportGroup[] }> {
  const baselineUrl = args["baseline-url"];
  const { maxTime, maxIterations } = params;
  const limits = { maxTime, maxIterations };
  const state: TabRunnerState = { detectedPageLoad: params.pageLoad ?? false };

  const warmup = !(args["warmup-batch"] ?? false) && args.batches > 1;
  const makeRunner = (url: string, label: string) =>
    makeTabRunner(params, chrome, limits, warmup, state, url, label);
  const runCurrent = makeRunner(params.url, name);
  const runBaseline = baselineUrl
    ? makeRunner(baselineUrl, nameFromUrl(baselineUrl))
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

/** Convert a browser profile result into a MeasuredResults for the report pipeline. */
function toBrowserMeasured(
  name: string,
  result: BrowserProfileResult,
): MeasuredResults {
  const { gcStats, gcEvents, heapProfile, timeProfile, coverage } = result;
  const { navTiming, samples } = result;
  const navTimings = navTiming ? [navTiming] : undefined;
  const base = {
    name,
    gcStats,
    gcEvents,
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

/** Create a batch runner closure for a single URL (current or baseline). */
function makeTabRunner(
  params: BrowserProfileParams,
  chrome: ChromeInstance,
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
    // No iteration samples but navTiming present means the page had no __bench: page-load mode
    if (!raw.samples?.length && raw.navTiming) state.detectedPageLoad = true;
    return toBrowserMeasured(label, raw);
  };
}

/** Run page loads until duration or iteration limit, collecting wallTimeMs as samples. */
async function runMultiPageLoad(
  params: BrowserProfileParams, // chrome instance attached by caller
  name: string,
  limits: { maxTime?: number; maxIterations?: number },
): Promise<MeasuredResults> {
  const { maxTime, maxIterations } = limits;
  const raws: BrowserProfileResult[] = [];
  let accumulated = 0;
  for (let i = 0; maxIterations == null || i < maxIterations; i++) {
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
