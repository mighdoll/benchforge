import {
  aggregateGcStats,
  type GcEvent,
  type GcStats,
} from "../../runners/GcStats.ts";
import type { TraceEvent } from "./ChromeTraceEvent.ts";

/** User-timing mark emitted at bench-loop start. Its trace timestamp anchors
 *  loop-relative time, letting GC trace events share the sample timeline. */
export const loopStartMark = "benchforge:loop-start";

/** Aggregate CDP GC trace events into GcStats. With the loop-start marker
 *  present (bench mode) only in-loop GCs are counted, matching the Node worker;
 *  without it (page-load mode) every captured GC is aggregated. */
export function browserGcStats(traceEvents: TraceEvent[]): GcStats {
  return aggregateGcStats(
    loopGcEvents(traceEvents) ?? parseGcTraceEvents(traceEvents),
  );
}

/** In-loop GC events with loop-relative offsets for the time-series plot, or []
 *  when no loop marker was captured (page-load mode has no sample axis). */
export function browserGcEvents(traceEvents: TraceEvent[]): GcEvent[] {
  return loopGcEvents(traceEvents) ?? [];
}

/** Convert MinorGC/MajorGC trace events into GcEvent[]. With `originUs` given,
 *  each event carries a loop-relative offset (ms); otherwise offsets are omitted. */
export function parseGcTraceEvents(
  traceEvents: TraceEvent[],
  originUs?: number,
): GcEvent[] {
  return traceEvents
    .filter(e => e.ph === "X" && gcType(e.name))
    .map(e => toGcEvent(e, originUs));
}

/** In-loop GC events rebased to loop-relative ms, or undefined if the loop-start
 *  marker is absent. Pre-loop (navigation/warmup) events are dropped. */
function loopGcEvents(traceEvents: TraceEvent[]): GcEvent[] | undefined {
  const originUs = traceEvents.find(e => e.name === loopStartMark)?.ts;
  if (originUs === undefined) return undefined;
  return parseGcTraceEvents(traceEvents, originUs).filter(e => e.offset! >= 0);
}

/** Build a GcEvent from a trace event, adding a loop-relative offset when an
 *  origin timestamp is supplied. */
function toGcEvent(e: TraceEvent, originUs?: number): GcEvent {
  const before = Number(e.args?.usedHeapSizeBefore ?? 0);
  const after = Number(e.args?.usedHeapSizeAfter ?? 0);
  const event: GcEvent = {
    type: gcType(e.name)!,
    pauseMs: (e.dur ?? 0) / 1000,
    collected: Math.max(0, before - after),
  };
  if (originUs === undefined) return event;
  return { ...event, offset: (e.ts - originUs) / 1000 };
}

/** Map CDP event names (MinorGC/MajorGC) to GcEvent type. */
function gcType(name: string): GcEvent["type"] | undefined {
  if (name === "MinorGC") return "scavenge";
  if (name === "MajorGC") return "mark-compact";
  return undefined;
}
