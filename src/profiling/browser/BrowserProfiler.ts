import type { GcStats } from "../../runners/GcStats.ts";
import type { CoverageData } from "../node/CoverageTypes.ts";
import type { HeapProfile, HeapSampleOptions } from "../node/HeapSampler.ts";
import type { TimeProfile } from "../node/TimeSampler.ts";
import { runBenchLoop } from "./BenchLoop.ts";
import { collectTracing, startGcTracing } from "./BrowserCDP.ts";
import { type CdpClient, connectCdp } from "./CdpClient.ts";
import { type CdpPage, createCdpPage } from "./CdpPage.ts";
import {
  type ChromeInstance,
  closeTab,
  createTab,
  launchChrome,
} from "./ChromeLauncher.ts";
import { runPageLoad } from "./PageLoadMode.ts";

/** Options for a browser benchmark run. */
export interface BrowserProfileParams {
  /** URL to benchmark */
  url: string;
  /** Enable heap allocation profiling */
  alloc?: boolean;
  /** Heap sampling options (interval, depth) */
  allocOptions?: HeapSampleOptions;
  /** Enable CPU time profiling */
  profile?: boolean;
  /** CPU profiling sample interval in microseconds (default 1000) */
  profileInterval?: number;
  /** Track function call counts via V8 coverage */
  callCounts?: boolean;
  /** Collect GC statistics via CDP tracing */
  gcStats?: boolean;
  /** Run Chrome in headless mode */
  headless?: boolean;
  /** Path to Chrome executable */
  chromePath?: string;
  /** Chrome user data directory for persistent profile */
  chromeProfile?: string;
  /** Extra Chrome launch arguments */
  chromeArgs?: string[];
  /** Page timeout in seconds */
  timeout?: number;
  /** Bench function iteration time limit in ms */
  maxTime?: number;
  /** Exact iteration count for bench function mode */
  maxIterations?: number;
  /** Passive page-load profiling mode */
  pageLoad?: boolean;
  /** Completion signal: CSS selector, JS expression, "load", or "domcontentloaded" */
  waitFor?: string;
  /** Reuse an existing Chrome instance (caller manages lifecycle) */
  chrome?: ChromeInstance;
}

/** Navigation timing metrics from the Performance API. */
export interface NavTiming {
  /** DOMContentLoaded time in ms */
  domContentLoaded: number;
  /** Load event time in ms */
  loadEvent: number;
  /** Largest Contentful Paint time in ms */
  lcp?: number;
}

/** Collected profiles, timing samples, and GC stats from a browser benchmark. */
export interface BrowserProfileResult {
  /** Heap allocation profile */
  heapProfile?: HeapProfile;
  /** CPU time profile */
  timeProfile?: TimeProfile;
  /** V8 code coverage data */
  coverage?: CoverageData;
  /** Garbage collection statistics */
  gcStats?: GcStats;
  /** Wall-clock ms for the entire bench loop or page load */
  wallTimeMs?: number;
  /** Per-iteration timing samples (ms) from bench function mode */
  samples?: number[];
  /** Navigation timing from page-load mode */
  navTiming?: NavTiming;
}

/** Shared context passed to bench/page-load mode runners. */
export interface ProfileCtx {
  page: CdpPage;
  cdp: CdpClient;
  params: BrowserProfileParams;
  samplingInterval: number;
}

/**
 * Run browser benchmark, auto-detecting mode:
 * - Bench function (window.__bench): CLI controls iteration and timing.
 * - Page load (no __bench, or --page-load): measures navigation timing.
 */
export async function profileBrowser(
  params: BrowserProfileParams,
): Promise<BrowserProfileResult> {
  const {
    headless = false,
    chromePath,
    chromeProfile,
    chromeArgs: args,
  } = params;
  const owned = !params.chrome;
  const launch = { headless, chromePath, chromeProfile, args };
  const chrome = params.chrome ?? (await launchChrome(launch));
  try {
    const { wsUrl, targetId } = await createTab(chrome.port);
    const cdp = await connectCdp(wsUrl);
    try {
      const timeout = (params.timeout ?? 60) * 1000;
      const page = await createCdpPage(cdp, { timeout });
      return await runProfile(page, cdp, params);
    } finally {
      cdp.close();
      await closeTab(chrome.port, targetId);
    }
  } finally {
    if (owned) await chrome.close();
  }
}

/**
 * Run profiling on an open CDP page, auto-detecting mode:
 * - **bench**: page exports `window.__bench` ==> CLI iterates and times it
 * - **page-load**: no `__bench` found (or `--page-load` flag) ==> profile navigation
 *
 * When auto-detecting, navigates once to check for `__bench`. If not found,
 * reloads via `runPageLoad` which starts instruments before navigation.
 */
async function runProfile(
  page: CdpPage,
  cdp: CdpClient,
  params: BrowserProfileParams,
): Promise<BrowserProfileResult> {
  const samplingInterval = params.allocOptions?.samplingInterval ?? 32768;
  const traceEvents = params.gcStats ? await startGcTracing(cdp) : [];
  const ctx = { page, cdp, params, samplingInterval };

  let result: BrowserProfileResult;
  if (params.pageLoad) {
    result = await runPageLoad(ctx);
  } else {
    await page.navigate(params.url, { waitUntil: "load" });
    const hasBench = await page.evaluate(
      () => typeof (globalThis as any).__bench === "function",
    );
    if (hasBench) {
      result = await runBenchLoop(ctx);
    } else {
      console.warn("No __bench found. Reloading in --page-load mode.");
      result = await runPageLoad(ctx);
    }
  }

  if (params.gcStats)
    return { ...result, gcStats: await collectTracing(cdp, traceEvents) };
  return result;
}
