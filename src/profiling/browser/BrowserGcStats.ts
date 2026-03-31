import {
  aggregateGcStats,
  type GcEvent,
  type GcStats,
} from "../../runners/GcStats.ts";

/** CDP trace event from Tracing.dataCollected */
export interface TraceEvent {
  cat: string;
  name: string;
  ph: string;
  dur?: number; // microseconds
  args?: Record<string, any>;
}

/** Parse CDP trace events (MinorGC/MajorGC) into GcEvent[] */
export function parseGcTraceEvents(traceEvents: TraceEvent[]): GcEvent[] {
  return traceEvents
    .filter(e => e.ph === "X" && gcType(e.name))
    .map(e => ({
      type: gcType(e.name)!,
      pauseMs: (e.dur ?? 0) / 1000,
      collected: Math.max(
        0,
        (e.args?.usedHeapSizeBefore ?? 0) - (e.args?.usedHeapSizeAfter ?? 0),
      ),
    }));
}

/** Parse CDP trace events and aggregate into GcStats */
export function browserGcStats(traceEvents: TraceEvent[]): GcStats {
  return aggregateGcStats(parseGcTraceEvents(traceEvents));
}

/** Map CDP trace event names to GcEvent types. */
function gcType(name: string): GcEvent["type"] | undefined {
  if (name === "MinorGC") return "scavenge";
  if (name === "MajorGC") return "mark-compact";
  return undefined;
}
