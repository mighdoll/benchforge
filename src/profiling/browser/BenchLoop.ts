import {
  instrumentOpts,
  startInstruments,
  stopInstruments,
} from "./BrowserCDP.ts";
import type { BrowserProfileResult, ProfileCtx } from "./BrowserProfiler.ts";

/**
 * Bench function mode: run window.__bench in a timed iteration loop.
 *
 * Simplified vs TimingRunner because it runs inside page.evaluate()
 * where shared code, Node APIs, and V8 intrinsics are unavailable.
 *
 * Not feasible in browser page context:
 *  - heap tracking (no getHeapStatistics)
 *  - V8 opt status tracing (no %GetOptimizationStatus)
 *  - explicit GC or pause-for-compilation
 */
export async function runBenchLoop(
  ctx: ProfileCtx,
): Promise<BrowserProfileResult> {
  const { page, cdp, params, samplingInterval } = ctx;
  const maxTime = params.maxTime ?? Number.MAX_SAFE_INTEGER;
  const maxIter = params.maxIterations ?? Number.MAX_SAFE_INTEGER;
  const opts = instrumentOpts(params, samplingInterval);

  await startInstruments(cdp, opts);

  const { samples, totalMs } = await page.evaluate(
    async ({ maxTime, maxIter }) => {
      const bench = (globalThis as any).__bench;
      const estimated = Math.min(maxIter, Math.ceil(maxTime / 0.1));
      const samples = new Array<number>(estimated);
      let count = 0;
      const startAll = performance.now();
      const deadline = startAll + maxTime;
      for (let i = 0; i < maxIter && performance.now() < deadline; i++) {
        const t0 = performance.now();
        await bench();
        samples[count++] = performance.now() - t0;
      }
      samples.length = count;
      return { samples, totalMs: performance.now() - startAll };
    },
    { maxTime, maxIter },
  );

  const collected = await stopInstruments(cdp, opts);

  return { samples, wallTimeMs: totalMs, ...collected };
}
