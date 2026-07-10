import {
  instrumentOpts,
  startInstruments,
  stopInstruments,
} from "./BrowserCDP.ts";
import { loopStartMark } from "./BrowserGcStats.ts";
import type { BrowserProfileResult, ProfileCtx } from "./BrowserProfiler.ts";

/**
 * Bench function mode: run a bench function in a timed iteration loop.
 *
 * The bench is either the page's own `window.__bench` or, in matrix parity mode,
 * a serialized inline variant injected via `params.inject` (its run/setup code is
 * eval'd in-page and bound to the serialized case data, mirroring how the Node
 * worker reconstructs an inline variant).
 *
 * Simplified vs BenchRunner because it runs inside page.evaluate()
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
    async ({ maxTime, maxIter, loopMark, inject }) => {
      const compile = (code: string) =>
        // biome-ignore lint/security/noGlobalEval: self-authored variant code, same trust as the Node worker
        eval(`(${code})`);
      let bench: () => unknown = (globalThis as any).__bench;
      if (inject) {
        const run = compile(inject.runCode);
        if (inject.setupCode) {
          const state = await compile(inject.setupCode)(inject.caseData);
          bench = () => run(state);
        } else {
          const data = inject.caseData;
          bench = () => run(data);
        }
      }
      const estimated = Math.min(maxIter, Math.ceil(maxTime / 0.1));
      const samples = new Array<number>(estimated);
      let count = 0;
      const startAll = performance.now();
      // anchor loop start on the trace clock so GC offsets are loop-relative
      performance.mark(loopMark);
      const deadline = startAll + maxTime;
      for (let i = 0; i < maxIter && performance.now() < deadline; i++) {
        const t0 = performance.now();
        await bench();
        samples[count++] = performance.now() - t0;
      }
      samples.length = count;
      return { samples, totalMs: performance.now() - startAll };
    },
    { maxTime, maxIter, loopMark: loopStartMark, inject: params.inject },
  );

  const collected = await stopInstruments(cdp, opts);

  return { samples, wallTimeMs: totalMs, ...collected };
}
