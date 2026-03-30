import type { CDPSession } from "playwright";
import type { GcStats } from "../../runners/GcStats.ts";
import type { CoverageData, ScriptCoverage } from "../node/CoverageTypes.ts";
import type { HeapProfile } from "../node/HeapSampler.ts";
import type { TimeProfile } from "../node/TimeSampler.ts";
import { browserGcStats, type TraceEvent } from "./BrowserGcStats.ts";

/** Start CDP GC tracing, returns the event collector array. */
export async function startGcTracing(cdp: CDPSession): Promise<TraceEvent[]> {
  const events: TraceEvent[] = [];
  cdp.on("Tracing.dataCollected", ({ value }) => {
    for (const e of value) events.push(e as unknown as TraceEvent);
  });
  await cdp.send("Tracing.start", {
    traceConfig: { includedCategories: ["v8", "v8.gc"] },
  });
  return events;
}

/** Stop CDP tracing and parse GC events into GcStats. */
export async function collectTracing(
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

export function heapSamplingParams(samplingInterval: number): {
  samplingInterval: number;
  includeObjectsCollectedByMajorGC: boolean;
  includeObjectsCollectedByMinorGC: boolean;
} {
  return {
    samplingInterval,
    includeObjectsCollectedByMajorGC: true,
    includeObjectsCollectedByMinorGC: true,
  };
}

/** Start CDP Profiler for CPU time sampling (caller manages Profiler.enable/disable) */
export async function startTimeProfiling(
  cdp: CDPSession,
  interval?: number,
): Promise<void> {
  if (interval) {
    await cdp.send("Profiler.setSamplingInterval", { interval });
  }
  await cdp.send("Profiler.start");
}

/** Stop CDP Profiler CPU sampling and return the profile */
export async function stopTimeProfiling(cdp: CDPSession): Promise<TimeProfile> {
  const { profile } = await cdp.send("Profiler.stop");
  return profile as unknown as TimeProfile;
}

/** Start CDP precise coverage (caller manages Profiler.enable/disable) */
export async function startCoverageCollection(cdp: CDPSession): Promise<void> {
  await cdp.send("Profiler.startPreciseCoverage", {
    callCount: true,
    detailed: true,
  });
}

/** Collect precise coverage and filter to page-relevant URLs */
export async function collectCoverage(cdp: CDPSession): Promise<CoverageData> {
  const { result } = await cdp.send("Profiler.takePreciseCoverage");
  await cdp.send("Profiler.stopPreciseCoverage");
  const scripts = (result as unknown as ScriptCoverage[]).filter(
    s => s.url && !s.url.startsWith("chrome") && !s.url.startsWith("devtools"),
  );
  return { scripts };
}

/** Stop all active CDP instruments and return collected profiles/coverage. */
export async function stopInstruments(
  cdp: CDPSession,
  opts: { alloc: boolean; timeSample: boolean; callCounts: boolean },
): Promise<{
  heapProfile?: HeapProfile;
  timeProfile?: TimeProfile;
  coverage?: CoverageData;
}> {
  let heapProfile: HeapProfile | undefined;
  if (opts.alloc) {
    const result = await cdp.send("HeapProfiler.stopSampling");
    heapProfile = result.profile as unknown as HeapProfile;
  }
  let timeProfile: TimeProfile | undefined;
  if (opts.timeSample) timeProfile = await stopTimeProfiling(cdp);
  let coverage: CoverageData | undefined;
  if (opts.callCounts) coverage = await collectCoverage(cdp);
  const needsProfiler = opts.timeSample || opts.callCounts;
  if (needsProfiler) await cdp.send("Profiler.disable");
  return { heapProfile, timeProfile, coverage };
}

/** Start all requested CDP instruments. */
export async function startInstruments(
  cdp: CDPSession,
  opts: {
    alloc: boolean;
    timeSample: boolean;
    callCounts: boolean;
    samplingInterval: number;
    timeInterval?: number;
  },
): Promise<void> {
  if (opts.alloc) {
    await cdp.send(
      "HeapProfiler.startSampling",
      heapSamplingParams(opts.samplingInterval),
    );
  }
  const needsProfiler = opts.timeSample || opts.callCounts;
  if (needsProfiler) await cdp.send("Profiler.enable");
  if (opts.timeSample) await startTimeProfiling(cdp, opts.timeInterval);
  if (opts.callCounts) await startCoverageCollection(cdp);
}
