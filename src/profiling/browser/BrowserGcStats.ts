import {
  aggregateGcStats,
  type GcEvent,
  type GcStats,
} from "../../runners/GcStats.ts";
import type { TraceEvent } from "./ChromeTraceEvent.ts";

/** Convert MinorGC/MajorGC trace events into GcEvent[]. */
export function parseGcTraceEvents(traceEvents: TraceEvent[]): GcEvent[] {
  return traceEvents
    .filter(e => e.ph === "X" && gcType(e.name))
    .map(e => ({
      type: gcType(e.name)!,
      pauseMs: (e.dur ?? 0) / 1000,
      collected: Math.max(
        0,
        Number(e.args?.usedHeapSizeBefore ?? 0) -
          Number(e.args?.usedHeapSizeAfter ?? 0),
      ),
    }));
}

/** Parse and aggregate CDP trace events into GcStats. */
export function browserGcStats(traceEvents: TraceEvent[]): GcStats {
  return aggregateGcStats(parseGcTraceEvents(traceEvents));
}

/** Map CDP event names (MinorGC/MajorGC) to GcEvent type. */
function gcType(name: string): GcEvent["type"] | undefined {
  if (name === "MinorGC") return "scavenge";
  if (name === "MajorGC") return "mark-compact";
  return undefined;
}
