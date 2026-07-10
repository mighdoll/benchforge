import type { BrowserProfileResult } from "../profiling/browser/BrowserProfiler.ts";
import type { MeasuredResults } from "../runners/MeasuredResults.ts";
import { computeStats } from "../runners/SampleStats.ts";

/** Extract a short name from a URL for report labels. */
export function nameFromUrl(url: string): string {
  return new URL(url).pathname.split("/").pop() || "browser";
}

/** Convert a browser profile result into a MeasuredResults for the report pipeline. */
export function toBrowserMeasured(
  name: string,
  result: BrowserProfileResult,
): MeasuredResults {
  const { gcStats, gcEvents, heapProfile, timeProfile, coverage } = result;
  const { navTiming, samples } = result;
  const navTimings = navTiming ? [navTiming] : undefined;
  const base = {
    name,
    gcStats,
    gcEvents,
    heapProfile,
    timeProfile,
    coverage,
    navTimings,
  };

  if (samples?.length) {
    const totalTime = result.wallTimeMs ? result.wallTimeMs / 1000 : undefined;
    return { ...base, samples, time: computeStats(samples), totalTime };
  }
  const wallTime = result.wallTimeMs ?? 0;
  return { ...base, samples: [wallTime], time: computeStats([wallTime]) };
}
