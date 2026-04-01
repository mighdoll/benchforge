import {
  instrumentOpts,
  startInstruments,
  stopInstruments,
} from "./BrowserCDP.ts";
import type { BrowserProfileResult, ProfileCtx } from "./BrowserProfiler.ts";

/** Bench function mode: run window.__bench in a timed iteration loop. */
export async function runBenchLoop(
  ctx: ProfileCtx,
): Promise<BrowserProfileResult> {
  const { page, cdp, params, samplingInterval } = ctx;
  const maxTime = params.maxTime ?? 642;
  const maxIter = params.maxIterations ?? Number.MAX_SAFE_INTEGER;
  const opts = instrumentOpts(params, samplingInterval);

  await startInstruments(cdp, opts);

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

  const collected = await stopInstruments(cdp, opts);

  return { samples, wallTimeMs: totalMs, ...collected };
}
