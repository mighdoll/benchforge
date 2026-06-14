import type { GcEvent } from "../runners/GcStats.ts";
import type { MeasuredResults } from "../runners/MeasuredResults.ts";
import {
  average,
  coefficientOfVariation,
  cumulativeSum,
  sampleIndexAtOffset,
} from "../stats/StatisticalUtils.ts";

/** Per-batch full-collection (mark-compact) GC summary, computed from raw
 *  per-event GC data + samples + batch boundaries. Agent-facing diagnostic:
 *  does full-GC cost/placement vary batch-to-batch enough to inflate the
 *  interior-percentile spread? Full GCs only; scavenge/minor counts are summary
 *  context. Present only for worker-mode --gc-stats runs with batch offsets. */
export interface GcByBatchSummary {
  /** Number of batches the events were bucketed into. */
  batches: number;

  /** Full GCs per batch across all batches. */
  fullPerBatch: Spread;

  /** Full-GC pause (ms) per event, pooled across batches. */
  fullPause: Spread;

  /** Bytes collected per full-GC event, pooled across batches. */
  fullCollected: Spread;

  /** Total scavenges and full GCs (context for "is GC even happening"). */
  scavenges: number;

  fullGCs: number;
}

/** min / max / mean / coefficient-of-variation for a value across observations. */
export interface Spread {
  count: number;
  min: number;
  max: number;
  mean: number;
  /** Coefficient of variation (stdev/mean); 0 when fewer than 2 observations. */
  cv: number;
}

type PlacedEvent = { event: GcEvent; sampleIndex: number };

/** Build a per-batch full-GC summary, or undefined when there is no per-event
 *  GC data with offsets and batch structure to analyze. */
export function gcByBatch(
  results: MeasuredResults,
): GcByBatchSummary | undefined {
  const { gcEvents, samples, batchOffsets } = results;
  if (!gcEvents?.length || !batchOffsets?.length) return undefined;

  const endTimes = cumulativeSum(samples);
  const placed = gcEvents
    .filter(e => e.offset !== undefined && e.offset >= 0)
    .map(e => ({
      event: e,
      sampleIndex: sampleIndexAtOffset(e.offset!, endTimes),
    }));
  if (!placed.length) return undefined;

  const full = placed.filter(p => p.event.type === "mark-compact");
  const scavenges = placed.filter(p => p.event.type === "scavenge").length;

  const perBatchCounts = countFullPerBatch(full, batchOffsets);
  return {
    batches: batchOffsets.length,
    fullPerBatch: spread(perBatchCounts),
    fullPause: spread(full.map(p => p.event.pauseMs)),
    fullCollected: spread(full.map(p => p.event.collected)),
    scavenges,
    fullGCs: full.length,
  };
}

/** Count full GCs falling in each batch's sample range. */
function countFullPerBatch(full: PlacedEvent[], offsets: number[]): number[] {
  const counts = new Array<number>(offsets.length).fill(0);
  for (const p of full) counts[batchOf(p.sampleIndex, offsets)]++;
  return counts;
}

/** min/max/mean/cv over values; zero-filled when empty. */
function spread(values: number[]): Spread {
  if (!values.length) return { count: 0, min: 0, max: 0, mean: 0, cv: 0 };
  return {
    count: values.length,
    min: Math.min(...values),
    max: Math.max(...values),
    mean: average(values),
    cv: values.length > 1 ? coefficientOfVariation(values) : 0,
  };
}

/** @return the batch index whose sample range contains sampleIndex. Batches are
 *  contiguous ([offsets[b], offsets[b+1])), so the containing batch is the last
 *  one whose start is at or before sampleIndex. */
function batchOf(sampleIndex: number, offsets: number[]): number {
  const b = offsets.findLastIndex(start => sampleIndex >= start);
  return b >= 0 ? b : 0;
}
