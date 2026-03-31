import { type BrowserServer, chromium } from "playwright";

import type { GcStats } from "../../runners/GcStats.ts";
import type { CoverageData } from "../node/CoverageTypes.ts";
import type { HeapProfile, HeapSampleOptions } from "../node/HeapSampler.ts";
import type { TimeProfile } from "../node/TimeSampler.ts";
import { runBenchLoop } from "./BenchLoop.ts";
import { collectTracing, startGcTracing } from "./BrowserCDP.ts";
import { setupLapMode } from "./LapMode.ts";

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
  chromeArgs?: string[];
  timeout?: number; // seconds
  maxTime?: number; // ms, bench function iteration time limit
  maxIterations?: number; // exact iteration count (bench function mode)
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
  const { url, headless = true, chromeArgs, timeout = 60 } = params;
  const collectGc = params.gcStats;
  const samplingInterval = params.allocOptions?.samplingInterval ?? 32768;

  const server = await chromium.launchServer({ headless, args: chromeArgs });
  pipeChromeOutput(server);
  const browser = await chromium.connect(server.wsEndpoint());
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(timeout * 1000);
    const cdp = await page.context().newCDPSession(page);

    const pageErrors: string[] = [];
    page.on("pageerror", err => pageErrors.push(err.message));

    const traceEvents = collectGc ? await startGcTracing(cdp) : [];
    const lapArgs = {
      page,
      cdp,
      params,
      samplingInterval,
      timeout,
      pageErrors,
    };
    const lapMode = await setupLapMode(lapArgs);

    await page.goto(url, { waitUntil: "load" });
    const hasBench = await page.evaluate(
      () => typeof (globalThis as any).__bench === "function",
    );

    let result: BrowserProfileResult;
    if (hasBench) {
      lapMode.cancel();
      lapMode.promise.catch(() => {}); // suppress unused rejection
      result = await runBenchLoop(page, cdp, params, samplingInterval);
    } else {
      result = await lapMode.promise;
      lapMode.cancel();
    }

    if (collectGc) {
      result = { ...result, gcStats: await collectTracing(cdp, traceEvents) };
    }
    return result;
  } finally {
    await browser.close();
    await server.close();
  }
}

/** Forward Chrome's stdout/stderr to the terminal so V8 flag output is visible. */
function pipeChromeOutput(server: BrowserServer): void {
  const proc = server.process();
  const forward = (stream: NodeJS.ReadableStream | null) =>
    stream?.on("data", (chunk: Buffer) => {
      const lines = chunk
        .toString()
        .split("\n")
        .map(l => l.trim())
        .filter(Boolean);
      for (const line of lines) process.stderr.write(`[chrome] ${line}\n`);
    });
  forward(proc.stdout);
  forward(proc.stderr);
}
