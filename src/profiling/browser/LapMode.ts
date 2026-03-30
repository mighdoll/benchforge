import type { CDPSession, Page } from "playwright";
import type { BrowserProfileParams, BrowserProfileResult } from "./BrowserProfiler.ts";
import { startInstruments, stopInstruments } from "./BrowserCDP.ts";

export interface LapModeHandle {
  promise: Promise<BrowserProfileResult>;
  cancel: () => void;
}

/** Inject __start/__lap as in-page functions, expose __done for results collection.
 *  __start/__lap are pure in-page (zero CDP overhead). First __start() triggers
 *  instrument start. __done() stops instruments and collects timing data. */
export async function setupLapMode(
  page: Page,
  cdp: CDPSession,
  params: BrowserProfileParams,
  samplingInterval: number,
  timeout: number,
  pageErrors: string[],
): Promise<LapModeHandle> {
  const { alloc = false, timeSample = false, callCounts = false } = params;
  const { promise, resolve, reject } =
    Promise.withResolvers<BrowserProfileResult>();
  let instrumentsStarted = false;

  await page.exposeFunction("__benchInstrumentStart", async () => {
    if (instrumentsStarted) return;
    instrumentsStarted = true;
    await startInstruments(cdp, {
      alloc,
      timeSample,
      callCounts,
      samplingInterval,
      timeInterval: params.timeInterval,
    });
  });

  await page.exposeFunction(
    "__benchCollect",
    async (samples: number[], wallTimeMs: number) => {
      const collected = instrumentsStarted
        ? await stopInstruments(cdp, { alloc, timeSample, callCounts })
        : {};
      resolve({ samples, wallTimeMs, ...collected });
    },
  );

  await page.addInitScript(injectLapFunctions);

  const timer = setTimeout(() => {
    const lines = [`Timed out after ${timeout}s`];
    if (pageErrors.length) {
      lines.push("Page JS errors:", ...pageErrors.map(e => `  ${e}`));
    } else {
      lines.push("Page did not call __done() or define window.__bench");
    }
    reject(new Error(lines.join("\n")));
  }, timeout * 1000);

  return { promise, cancel: () => clearTimeout(timer) };
}

/** In-page timing functions injected via addInitScript (zero CDP overhead).
 *  __start/__lap collect timestamps, __done delegates to exposed __benchCollect. */
function injectLapFunctions(): void {
  const g = globalThis as any;
  g.__benchSamples = [];
  g.__benchLastTime = 0;
  g.__benchFirstStart = 0;

  g.__start = () => {
    const now = performance.now();
    g.__benchLastTime = now;
    if (!g.__benchFirstStart) {
      g.__benchFirstStart = now;
      return g.__benchInstrumentStart();
    }
  };

  g.__lap = () => {
    const now = performance.now();
    g.__benchSamples.push(now - g.__benchLastTime);
    g.__benchLastTime = now;
  };

  g.__done = () => {
    const wall = g.__benchFirstStart
      ? performance.now() - g.__benchFirstStart
      : 0;
    return g.__benchCollect(g.__benchSamples.slice(), wall);
  };
}
