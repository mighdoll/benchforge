import type { GcStats } from "../../runners/GcStats.ts";
import type { CoverageData, ScriptCoverage } from "../node/CoverageTypes.ts";
import type { HeapProfile } from "../node/HeapSampler.ts";
import type { TimeProfile } from "../node/TimeSampler.ts";
import { browserGcStats, type TraceEvent } from "./BrowserGcStats.ts";
import type { CdpClient } from "./CdpClient.ts";

/** Options for starting/stopping CDP instruments (heap, CPU, coverage). */
export interface InstrumentOpts {
  alloc: boolean;
  timeSample: boolean;
  callCounts: boolean;
  samplingInterval: number;
  timeInterval?: number;
}

/** Build instrument options from profile params with optional flag defaults. */
export function instrumentOpts(
  params: {
    alloc?: boolean;
    timeSample?: boolean;
    callCounts?: boolean;
    timeInterval?: number;
  },
  samplingInterval: number,
): InstrumentOpts {
  const { alloc = false, timeSample = false, callCounts = false } = params;
  return {
    alloc,
    timeSample,
    callCounts,
    samplingInterval,
    timeInterval: params.timeInterval,
  };
}

/** Start CDP GC tracing, returns the event collector array. */
export async function startGcTracing(cdp: CdpClient): Promise<TraceEvent[]> {
  const events: TraceEvent[] = [];
  cdp.on("Tracing.dataCollected", ({ value }) => {
    events.push(...(value as unknown as TraceEvent[]));
  });
  await cdp.send("Tracing.start", {
    traceConfig: { includedCategories: ["v8", "v8.gc"] },
  });
  return events;
}

/** Stop CDP tracing and parse GC events into GcStats. */
export async function collectTracing(
  cdp: CdpClient,
  traceEvents: TraceEvent[],
): Promise<GcStats> {
  const tracingDone = new Promise<void>(resolve =>
    cdp.once("Tracing.tracingComplete", () => resolve()),
  );
  await cdp.send("Tracing.end");
  await tracingDone;
  return browserGcStats(traceEvents);
}

/** Start CDP Profiler for CPU time sampling (caller manages Profiler.enable/disable) */
export async function startTimeProfiling(
  cdp: CdpClient,
  interval?: number,
): Promise<void> {
  if (interval) await cdp.send("Profiler.setSamplingInterval", { interval });
  await cdp.send("Profiler.start");
}

/** Stop CDP Profiler CPU sampling and return the profile */
export async function stopTimeProfiling(cdp: CdpClient): Promise<TimeProfile> {
  const { profile } = await cdp.send("Profiler.stop");
  return profile as unknown as TimeProfile;
}

/** Start CDP precise coverage (caller manages Profiler.enable/disable) */
export async function startCoverageCollection(cdp: CdpClient): Promise<void> {
  await cdp.send("Profiler.startPreciseCoverage", {
    callCount: true,
    detailed: true,
  });
}

/** Collect precise coverage and filter to page-relevant URLs */
export async function collectCoverage(cdp: CdpClient): Promise<CoverageData> {
  const { result } = await cdp.send("Profiler.takePreciseCoverage");
  await cdp.send("Profiler.stopPreciseCoverage");
  const scripts = (result as unknown as ScriptCoverage[]).filter(isPageScript);
  return { scripts };
}

/** True for user page scripts, excluding browser-internal URLs. */
function isPageScript(s: ScriptCoverage): boolean {
  return (
    !!s.url && !s.url.startsWith("chrome") && !s.url.startsWith("devtools")
  );
}

/** Stop all active CDP instruments and return collected profiles/coverage. */
export async function stopInstruments(
  cdp: CdpClient,
  opts: InstrumentOpts,
): Promise<{
  heapProfile?: HeapProfile;
  timeProfile?: TimeProfile;
  coverage?: CoverageData;
}> {
  const heapResult = opts.alloc
    ? await cdp.send("HeapProfiler.stopSampling")
    : undefined;
  const heapProfile = heapResult?.profile as HeapProfile | undefined;
  const timeProfile = opts.timeSample
    ? await stopTimeProfiling(cdp)
    : undefined;
  const coverage = opts.callCounts ? await collectCoverage(cdp) : undefined;
  if (opts.timeSample || opts.callCounts) await cdp.send("Profiler.disable");
  return { heapProfile, timeProfile, coverage };
}

/** Start all requested CDP instruments. */
export async function startInstruments(
  cdp: CdpClient,
  opts: InstrumentOpts,
): Promise<void> {
  if (opts.alloc) {
    await cdp.send("HeapProfiler.startSampling", {
      samplingInterval: opts.samplingInterval,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
  }
  if (opts.timeSample || opts.callCounts) await cdp.send("Profiler.enable");
  if (opts.timeSample) await startTimeProfiling(cdp, opts.timeInterval);
  if (opts.callCounts) await startCoverageCollection(cdp);
}
