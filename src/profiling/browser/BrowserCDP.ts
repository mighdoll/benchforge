import type { GcStats } from "../../runners/GcStats.ts";
import type { CoverageData, ScriptCoverage } from "../node/CoverageTypes.ts";
import type { HeapProfile } from "../node/HeapSampler.ts";
import type { TimeProfile } from "../node/TimeSampler.ts";
import { browserGcStats } from "./BrowserGcStats.ts";
import type { CdpClient } from "./CdpClient.ts";
import type { TraceEvent } from "./ChromeTraceEvent.ts";

/** Options controlling which CDP instruments (heap, CPU, coverage) to enable. */
export interface InstrumentOpts {
  alloc: boolean;
  profile: boolean;
  callCounts: boolean;
  samplingInterval: number;
  profileInterval?: number;
}

/** Build InstrumentOpts from profile params and heap sampling interval. */
export function instrumentOpts(
  params: {
    alloc?: boolean;
    profile?: boolean;
    callCounts?: boolean;
    profileInterval?: number;
  },
  samplingInterval: number,
): InstrumentOpts {
  const {
    alloc = false,
    profile = false,
    callCounts = false,
    profileInterval,
  } = params;
  return { alloc, profile, callCounts, samplingInterval, profileInterval };
}

/** Start CDP GC tracing; returns the mutable array that collects trace events. */
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

/** End CDP tracing and aggregate collected events into GcStats. */
export async function collectTracing(
  cdp: CdpClient,
  traceEvents: TraceEvent[],
): Promise<GcStats> {
  const done = new Promise<void>(r =>
    cdp.once("Tracing.tracingComplete", () => r()),
  );
  await cdp.send("Tracing.end");
  await done;
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

/** Stop CDP CPU sampling and return the profile. */
export async function stopTimeProfiling(cdp: CdpClient): Promise<TimeProfile> {
  const { profile } = await cdp.send("Profiler.stop");
  return profile as unknown as TimeProfile;
}

/** Start precise coverage (caller manages Profiler.enable/disable). */
export async function startCoverageCollection(cdp: CdpClient): Promise<void> {
  await cdp.send("Profiler.startPreciseCoverage", {
    callCount: true,
    detailed: true,
  });
}

/** Collect precise coverage, filtering out browser-internal scripts. */
export async function collectCoverage(cdp: CdpClient): Promise<CoverageData> {
  const { result } = await cdp.send("Profiler.takePreciseCoverage");
  await cdp.send("Profiler.stopPreciseCoverage");
  const scripts = (result as unknown as ScriptCoverage[]).filter(isPageScript);
  return { scripts };
}

/** Stop active instruments and return collected profiles/coverage. */
export async function stopInstruments(
  cdp: CdpClient,
  opts: InstrumentOpts,
): Promise<{
  heapProfile?: HeapProfile;
  timeProfile?: TimeProfile;
  coverage?: CoverageData;
}> {
  const heapProfile = opts.alloc
    ? ((await cdp.send("HeapProfiler.stopSampling")).profile as HeapProfile)
    : undefined;
  const timeProfile = opts.profile ? await stopTimeProfiling(cdp) : undefined;
  const coverage = opts.callCounts ? await collectCoverage(cdp) : undefined;
  if (opts.profile || opts.callCounts) await cdp.send("Profiler.disable");
  return { heapProfile, timeProfile, coverage };
}

/** Start requested CDP instruments (heap, CPU, coverage). */
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
  if (opts.profile || opts.callCounts) await cdp.send("Profiler.enable");
  if (opts.profile) await startTimeProfiling(cdp, opts.profileInterval);
  if (opts.callCounts) await startCoverageCollection(cdp);
}

/** Exclude chrome:// and devtools:// internal scripts. */
function isPageScript(s: ScriptCoverage): boolean {
  return (
    !!s.url && !s.url.startsWith("chrome") && !s.url.startsWith("devtools")
  );
}
