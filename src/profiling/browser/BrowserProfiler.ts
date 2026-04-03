import type { GcStats } from "../../runners/GcStats.ts";
import type { CoverageData } from "../node/CoverageTypes.ts";
import type { HeapProfile, HeapSampleOptions } from "../node/HeapSampler.ts";
import type { TimeProfile } from "../node/TimeSampler.ts";
import { runBenchLoop } from "./BenchLoop.ts";
import { collectTracing, startGcTracing } from "./BrowserCDP.ts";
import { type CdpClient, connectCdp } from "./CdpClient.ts";
import { type CdpPage, createCdpPage } from "./CdpPage.ts";
import { type ChromeInstance, createTab, launchChrome } from "./ChromeLauncher.ts";
import { setupLapMode } from "./LapMode.ts";
import { runPageLoad } from "./PageLoadMode.ts";

/** Options for a browser benchmark run (profiling, GC, iteration limits). */
export interface BrowserProfileParams {
  url: string;
  alloc?: boolean;
  allocOptions?: HeapSampleOptions;
  timeSample?: boolean;
  timeInterval?: number; // microseconds (default 1000)
  callCounts?: boolean;
  gcStats?: boolean;
  headless?: boolean;
  chromePath?: string;
  chromeProfile?: string;
  chromeArgs?: string[];
  timeout?: number; // seconds
  maxTime?: number; // ms, bench function iteration time limit
  maxIterations?: number; // exact iteration count (bench function mode)
  pageLoad?: boolean; // passive page-load profiling mode
  waitFor?: string; // completion signal: selector, JS expression, "load", "domcontentloaded"
  chrome?: ChromeInstance; // reuse an existing Chrome instance (caller manages lifecycle)
}

/** Navigation timing metrics from the page's Performance API. */
export interface NavTiming {
  domContentLoaded: number; // ms
  loadEvent: number; // ms
  lcp?: number; // ms
}

/** Collected profiles, timing samples, and GC stats from a browser benchmark. */
export interface BrowserProfileResult {
  heapProfile?: HeapProfile;
  timeProfile?: TimeProfile;
  coverage?: CoverageData;
  gcStats?: GcStats;
  /** Wall-clock ms (lap mode: first start to done, bench function: total loop) */
  wallTimeMs?: number;
  /** Per-iteration timing samples (ms) from bench function or lap mode */
  samples?: number[];
  /** Navigation timing from page-load mode */
  navTiming?: NavTiming;
}

/**
 * Run browser benchmark, auto-detecting bench function vs lap mode.
 *
 * Bench function (window.__bench): CLI controls iteration and timing.
 * Lap mode (__start/__lap/__done): page controls the measured region.
 */
export async function profileBrowser(
  params: BrowserProfileParams,
): Promise<BrowserProfileResult> {
  const { headless = false, chromePath, chromeProfile } = params;
  const owned = !params.chrome;
  const chrome =
    params.chrome ??
    (await launchChrome({
      headless,
      chromePath,
      chromeProfile,
      args: params.chromeArgs,
    }));
  try {
    const pageWsUrl = await createTab(chrome.port);
    const cdp = await connectCdp(pageWsUrl);
    const timeout = (params.timeout ?? 60) * 1000;
    const page = await createCdpPage(cdp, { timeout });
    return await runProfile(page, cdp, params);
  } finally {
    if (owned) await chrome.close();
  }
}

/** Run profiling on an open CDP page, auto-detecting mode. */
async function runProfile(
  page: CdpPage,
  cdp: CdpClient,
  params: BrowserProfileParams,
): Promise<BrowserProfileResult> {
  const wantGc = params.gcStats;
  const samplingInterval = params.allocOptions?.samplingInterval ?? 32768;

  const pageErrors: string[] = [];
  page.onPageError(msg => pageErrors.push(msg));

  const traceEvents = wantGc ? await startGcTracing(cdp) : [];

  const ctx = { page, cdp, params, samplingInterval };
  const result = params.pageLoad
    ? await runPageLoad(ctx)
    : await runBenchOrLap(ctx, pageErrors);

  if (wantGc)
    return { ...result, gcStats: await collectTracing(cdp, traceEvents) };
  return result;
}

export interface ProfileCtx {
  page: CdpPage;
  cdp: CdpClient;
  params: BrowserProfileParams;
  samplingInterval: number;
}

/** Auto-detect bench function vs lap mode after page load. */
async function runBenchOrLap(
  ctx: ProfileCtx,
  pageErrors: string[],
): Promise<BrowserProfileResult> {
  const { page, params } = ctx;
  const timeout = params.timeout ?? 60;
  const lapMode = await setupLapMode({ ...ctx, timeout, pageErrors });

  await page.navigate(params.url, { waitUntil: "load" });
  const hasBench = await page.evaluate(
    () => typeof (globalThis as any).__bench === "function",
  );

  if (hasBench) {
    lapMode.cancel();
    lapMode.promise.catch(() => {}); // suppress unused rejection
    return runBenchLoop(ctx);
  }
  const result = await lapMode.promise;
  lapMode.cancel();
  return result;
}
