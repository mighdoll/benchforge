import {
  aggregateGcStats,
  type GcEvent,
  type GcStats,
} from "../runners/GcStats.ts";

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
  return traceEvents.flatMap(e => {
    if (e.ph !== "X") return [];
    const type = gcType(e.name);
    if (!type) return [];
    const durUs = e.dur ?? 0;
    const heapBefore: number = e.args?.usedHeapSizeBefore ?? 0;
    const heapAfter: number = e.args?.usedHeapSizeAfter ?? 0;
    return [
      {
        type,
        pauseMs: durUs / 1000,
        collected: Math.max(0, heapBefore - heapAfter),
      },
    ];
  });
}

function gcType(name: string): GcEvent["type"] | undefined {
  if (name === "MinorGC") return "scavenge";
  if (name === "MajorGC") return "mark-compact";
  return undefined;
}

/** Parse CDP trace events and aggregate into GcStats */
export function browserGcStats(traceEvents: TraceEvent[]): GcStats {
  return aggregateGcStats(parseGcTraceEvents(traceEvents));
}
