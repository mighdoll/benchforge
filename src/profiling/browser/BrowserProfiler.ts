import {
  type BrowserServer,
  type CDPSession,
  chromium,
  type Page,
} from "playwright";
import type { GcStats } from "../../runners/GcStats.ts";
import type { CoverageData, ScriptCoverage } from "../node/CoverageTypes.ts";
import type { HeapProfile, HeapSampleOptions } from "../node/HeapSampler.ts";
import type { TimeProfile } from "../node/TimeSampler.ts";
import { browserGcStats, type TraceEvent } from "./BrowserGcStats.ts";

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
  const { samplingInterval = 32768 } = params.allocOptions ?? {};

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
    await server.close();
  }
}

/** Forward Chrome's stdout/stderr to the terminal so V8 flag output is visible. */
function pipeChromeOutput(server: BrowserServer): void {
  const proc = server.process();
  const pipe = (stream: NodeJS.ReadableStream | null) =>
    stream?.on("data", (chunk: Buffer) => {
      for (const line of chunk.toString().split("\n")) {
        const text = line.trim();
        if (text) process.stderr.write(`[chrome] ${text}\n`);
      }
    });
  pipe(proc.stdout);
  pipe(proc.stderr);
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
  const { alloc } = params;
  const { promise, resolve, reject } =
    Promise.withResolvers<BrowserProfileResult>();
  let instrumentsStarted = false;

  const { timeSample, callCounts } = params;
  const needsProfiler = timeSample || callCounts;

  await page.exposeFunction("__benchInstrumentStart", async () => {
    if (instrumentsStarted) return;
    instrumentsStarted = true;
    if (alloc) {
      await cdp.send(
        "HeapProfiler.startSampling",
        heapSamplingParams(samplingInterval),
      );
    }
    if (needsProfiler) await cdp.send("Profiler.enable");
    if (timeSample) await startTimeProfiling(cdp, params.timeInterval);
    if (callCounts) await startCoverageCollection(cdp);
  });

  await page.exposeFunction(
    "__benchCollect",
    async (samples: number[], wallTimeMs: number) => {
      let heapProfile: HeapProfile | undefined;
      if (alloc && instrumentsStarted) {
        const result = await cdp.send("HeapProfiler.stopSampling");
        heapProfile = result.profile as unknown as HeapProfile;
      }
      let timeProfile: TimeProfile | undefined;
      if (timeSample && instrumentsStarted) {
        timeProfile = await stopTimeProfiling(cdp);
      }
      let coverage: CoverageData | undefined;
      if (callCounts && instrumentsStarted) {
        coverage = await collectCoverage(cdp);
      }
      if (needsProfiler && instrumentsStarted) {
        await cdp.send("Profiler.disable");
      }
      resolve({ samples, heapProfile, timeProfile, coverage, wallTimeMs });
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

/** Bench function mode: run window.__bench in a timed iteration loop. */
async function runBenchLoop(
  page: Page,
  cdp: CDPSession,
  params: BrowserProfileParams,
  samplingInterval: number,
): Promise<BrowserProfileResult> {
  const { alloc, timeSample, callCounts } = params;
  const maxTime = params.maxTime ?? 642;
  const maxIter = params.maxIterations ?? Number.MAX_SAFE_INTEGER;

  if (alloc) {
    await cdp.send(
      "HeapProfiler.startSampling",
      heapSamplingParams(samplingInterval),
    );
  }
  const needsProfiler = timeSample || callCounts;
  if (needsProfiler) await cdp.send("Profiler.enable");
  if (timeSample) await startTimeProfiling(cdp, params.timeInterval);
  if (callCounts) await startCoverageCollection(cdp);

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
  if (alloc) {
    const result = await cdp.send("HeapProfiler.stopSampling");
    heapProfile = result.profile as unknown as HeapProfile;
  }

  let timeProfile: TimeProfile | undefined;
  if (timeSample) timeProfile = await stopTimeProfiling(cdp);

  let coverage: CoverageData | undefined;
  if (callCounts) coverage = await collectCoverage(cdp);

  if (needsProfiler) await cdp.send("Profiler.disable");

  return { samples, heapProfile, timeProfile, coverage, wallTimeMs: totalMs };
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

function heapSamplingParams(samplingInterval: number) {
  return {
    samplingInterval,
    includeObjectsCollectedByMajorGC: true,
    includeObjectsCollectedByMinorGC: true,
  };
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

/** Start CDP Profiler for CPU time sampling (caller manages Profiler.enable/disable) */
async function startTimeProfiling(
  cdp: CDPSession,
  interval?: number,
): Promise<void> {
  if (interval) {
    await cdp.send("Profiler.setSamplingInterval", { interval });
  }
  await cdp.send("Profiler.start");
}

/** Stop CDP Profiler CPU sampling and return the profile */
async function stopTimeProfiling(cdp: CDPSession): Promise<TimeProfile> {
  const { profile } = await cdp.send("Profiler.stop");
  return profile as unknown as TimeProfile;
}

/** Start CDP precise coverage (caller manages Profiler.enable/disable) */
async function startCoverageCollection(cdp: CDPSession): Promise<void> {
  await cdp.send("Profiler.startPreciseCoverage", {
    callCount: true,
    detailed: true,
  });
}

/** Collect precise coverage and filter to page-relevant URLs */
async function collectCoverage(cdp: CDPSession): Promise<CoverageData> {
  const { result } = await cdp.send("Profiler.takePreciseCoverage");
  await cdp.send("Profiler.stopPreciseCoverage");
  const scripts = (result as unknown as ScriptCoverage[]).filter(
    s => s.url && !s.url.startsWith("chrome") && !s.url.startsWith("devtools"),
  );
  return { scripts };
}
