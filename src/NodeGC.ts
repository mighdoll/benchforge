import type { PerformanceEntry } from "node:perf_hooks";

/** Individual GC event for visualization */
export interface GcEvent {
  /** Offset from collection start (ms) - can be negative for warmup GCs */
  offset: number;
  /** Duration of GC pause (ms) */
  duration: number;
}

/** GC time measured by Node's performance hooks */
export interface NodeGCTime {
  inRun: number;
  before: number;
  after: number;
  total: number;
  collects: number;
  /** Individual GC events during sample collection (for visualization) */
  events: GcEvent[];
}

/** Correlate GC events with benchmark timing */
export function analyzeGCEntries(
  gcRecords: PerformanceEntry[],
  benchTime: [number, number],
): NodeGCTime {
  const [start, end] = benchTime;
  let inRun = 0;
  let before = 0;
  let after = 0;
  let collects = 0;
  const events: GcEvent[] = [];

  gcRecords.forEach(record => {
    const { duration, startTime } = record;
    if (startTime < start) {
      before += duration;
    } else if (startTime > end) {
      after += duration;
    } else {
      inRun += duration;
      collects++;
      events.push({ offset: startTime - start, duration });
    }
  });
  const total = inRun + before + after;
  return { inRun, before, after, total, collects, events };
}
