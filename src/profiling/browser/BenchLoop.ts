import type { CDPSession, Page } from "playwright";
import { startInstruments, stopInstruments } from "./BrowserCDP.ts";
import type {
  BrowserProfileParams,
  BrowserProfileResult,
} from "./BrowserProfiler.ts";

/** Bench function mode: run window.__bench in a timed iteration loop. */
export async function runBenchLoop(
  page: Page,
  cdp: CDPSession,
  params: BrowserProfileParams,
  samplingInterval: number,
): Promise<BrowserProfileResult> {
  const { alloc = false, timeSample = false, callCounts = false } = params;
  const maxTime = params.maxTime ?? 642;
  const maxIter = params.maxIterations ?? Number.MAX_SAFE_INTEGER;

  await startInstruments(cdp, {
    alloc,
    timeSample,
    callCounts,
    samplingInterval,
    timeInterval: params.timeInterval,
  });

  const { samples, totalMs } = await page.evaluate(
    async ({ maxTime, maxIter }) => {
      const bench = (globalThis as any).__bench;
      const samples: number[] = [];
      const startAll = performance.now();
      const deadline = startAll + maxTime;
      for (let i = 0; i < maxIter && performance.now() < deadline; i++) {
        const t0 = performance.now();
        await bench();
        samples.push(performance.now() - t0);
      }
      return { samples, totalMs: performance.now() - startAll };
    },
    { maxTime, maxIter },
  );

  const collected = await stopInstruments(cdp, {
    alloc,
    timeSample,
    callCounts,
  });

  return { samples, wallTimeMs: totalMs, ...collected };
}
