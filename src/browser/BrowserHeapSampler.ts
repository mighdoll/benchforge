import { type CDPSession, chromium, type Page } from "playwright";
import type {
  HeapProfile,
  HeapSampleOptions,
} from "../heap-sample/HeapSampler.ts";
import type { GcStats } from "../runners/GcStats.ts";
import { browserGcStats, type TraceEvent } from "./BrowserGcStats.ts";

export interface BrowserProfileParams {
  url: string;
  heapSample?: boolean;
  heapOptions?: HeapSampleOptions;
  gcStats?: boolean;
  headless?: boolean;
  chromeArgs?: string[];
  timeout?: number; // seconds
  maxTime?: number; // ms, bench function iteration time limit
  maxIterations?: number; // exact iteration count (bench function mode)
}

export interface BrowserProfileResult {
  heapProfile?: HeapProfile;
  gcStats?: GcStats;
  /** Wall-clock ms (lap mode: first start to done, bench function: total loop) */
  wallTimeMs?: number;
  /** Per-iteration timing samples (ms) from bench function or lap mode */
  samples?: number[];
}

interface LapModeHandle {
  promise: Promise<BrowserProfileResult>;
  cancel: () => void;
}

/** Run browser benchmark, auto-detecting page API mode.
 *  Bench function (window.__bench): CLI controls iteration and timing.
 *  Lap mode (__start/__lap/__done): page controls the measured region. */
export async function profileBrowser(
  params: BrowserProfileParams,
): Promise<BrowserProfileResult> {
  const { url, headless = true, chromeArgs, timeout = 60 } = params;
  const { gcStats: collectGc } = params;
  const { samplingInterval = 32768 } = params.heapOptions ?? {};

  const browser = await chromium.launch({ headless, args: chromeArgs });
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(timeout * 1000);
    const cdp = await page.context().newCDPSession(page);

    const pageErrors: string[] = [];
    page.on("pageerror", err => pageErrors.push(err.message));

    const traceEvents = collectGc ? await startGcTracing(cdp) : [];
    const lapMode = await setupLapMode(
      page,
      cdp,
      params,
      samplingInterval,
      timeout,
      pageErrors,
    );

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
  }
}

/** Inject __start/__lap as in-page functions, expose __done for results collection.
 *  __start/__lap are pure in-page (zero CDP overhead). First __start() triggers
 *  instrument start. __done() stops instruments and collects timing data. */
async function setupLapMode(
  page: Page,
  cdp: CDPSession,
  params: BrowserProfileParams,
  samplingInterval: number,
  timeout: number,
  pageErrors: string[],
): Promise<LapModeHandle> {
  const { heapSample } = params;
  const { promise, resolve, reject } =
    Promise.withResolvers<BrowserProfileResult>();
  let instrumentsStarted = false;

  await page.exposeFunction("__benchInstrumentStart", async () => {
    if (instrumentsStarted) return;
    instrumentsStarted = true;
    if (heapSample) {
      await cdp.send(
        "HeapProfiler.startSampling",
        heapSamplingParams(samplingInterval),
      );
    }
  });

  await page.exposeFunction(
    "__benchCollect",
    async (samples: number[], wallTimeMs: number) => {
      let heapProfile: HeapProfile | undefined;
      if (heapSample && instrumentsStarted) {
        const result = await cdp.send("HeapProfiler.stopSampling");
        heapProfile = result.profile as unknown as HeapProfile;
      }
      resolve({ samples, heapProfile, wallTimeMs });
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

function heapSamplingParams(samplingInterval: number) {
  return {
    samplingInterval,
    includeObjectsCollectedByMajorGC: true,
    includeObjectsCollectedByMinorGC: true,
  };
}

/** Start CDP GC tracing, returns the event collector array. */
async function startGcTracing(cdp: CDPSession): Promise<TraceEvent[]> {
  const events: TraceEvent[] = [];
  cdp.on("Tracing.dataCollected", ({ value }) => {
    for (const e of value) events.push(e as unknown as TraceEvent);
  });
  await cdp.send("Tracing.start", {
    traceConfig: { includedCategories: ["v8", "v8.gc"] },
  });
  return events;
}

/** Bench function mode: run window.__bench in a timed iteration loop. */
async function runBenchLoop(
  page: Page,
  cdp: CDPSession,
  params: BrowserProfileParams,
  samplingInterval: number,
): Promise<BrowserProfileResult> {
  const { heapSample } = params;
  const maxTime = params.maxTime ?? 642;
  const maxIter = params.maxIterations ?? Number.MAX_SAFE_INTEGER;

  if (heapSample) {
    await cdp.send(
      "HeapProfiler.startSampling",
      heapSamplingParams(samplingInterval),
    );
  }

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

  let heapProfile: HeapProfile | undefined;
  if (heapSample) {
    const result = await cdp.send("HeapProfiler.stopSampling");
    heapProfile = result.profile as unknown as HeapProfile;
  }

  return { samples, heapProfile, wallTimeMs: totalMs };
}

/** Stop CDP tracing and parse GC events into GcStats. */
async function collectTracing(
  cdp: CDPSession,
  traceEvents: TraceEvent[],
): Promise<GcStats> {
  const complete = new Promise<void>(resolve =>
    cdp.once("Tracing.tracingComplete", () => resolve()),
  );
  await cdp.send("Tracing.end");
  await complete;
  return browserGcStats(traceEvents);
}

export { profileBrowser as profileBrowserHeap };
