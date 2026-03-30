import type { CDPSession, Page } from "playwright";
import {
  instrumentOpts,
  startInstruments,
  stopInstruments,
} from "./BrowserCDP.ts";
import type {
  BrowserProfileParams,
  BrowserProfileResult,
} from "./BrowserProfiler.ts";

/** Handle for a pending lap-mode benchmark, with cancellation for the timeout. */
export interface LapModeHandle {
  promise: Promise<BrowserProfileResult>;
  cancel: () => void;
}

/**
 * Inject __start/__lap/__done as in-page timing functions.
 *
 * __start/__lap are pure in-page (zero CDP overhead). The first __start()
 * triggers instrument start. __done() stops instruments and collects timing data.
 */
export async function setupLapMode(
  page: Page,
  cdp: CDPSession,
  params: BrowserProfileParams,
  samplingInterval: number,
  timeout: number,
  pageErrors: string[],
): Promise<LapModeHandle> {
  const { promise, resolve, reject } =
    Promise.withResolvers<BrowserProfileResult>();
  let instrumentsStarted = false;

  const opts = instrumentOpts(params, samplingInterval);
  await page.exposeFunction("__benchInstrumentStart", async () => {
    if (instrumentsStarted) return;
    instrumentsStarted = true;
    await startInstruments(cdp, opts);
  });

  await page.exposeFunction(
    "__benchCollect",
    async (samples: number[], wallTimeMs: number) => {
      const collected = instrumentsStarted
        ? await stopInstruments(cdp, opts)
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

/**
 * In-page timing functions injected via addInitScript (zero CDP overhead).
 * __start/__lap collect timestamps, __done delegates to exposed __benchCollect.
 */
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
