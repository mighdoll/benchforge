import type { GcEvent } from "../runners/GcStats.ts";
import type { MeasuredResults } from "../runners/MeasuredResults.ts";
import { average, coefficientOfVariation } from "../stats/StatisticalUtils.ts";

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

  /** Post-full-GC cache-effect probe: mean iteration time in the K iterations
   *  immediately after each full GC vs the overall sample mean. Undefined when
   *  too few full GCs land mid-loop to measure. */
  cacheProbe?: CacheProbe;
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

/** Mean iteration time right after full GCs vs the loop mean (cache-penalty probe). */
export interface CacheProbe {
  /** Iterations sampled immediately after each full GC. */
  windowK: number;
  /** Number of full GCs that had a measurable post-GC window. */
  events: number;
  /** Mean iteration time (ms) in the post-GC windows. */
  postGcMean: number;
  /** Mean iteration time (ms) across all samples. */
  overallMean: number;
  /** postGcMean / overallMean - 1 (positive == post-GC iterations run slower). */
  penaltyRatio: number;
}

/** Iterations sampled after a full GC for the cache-effect probe. */
const cacheWindowK = 20;

/** Build a per-batch full-GC summary, or undefined when there is no per-event
 *  GC data with offsets and batch structure to analyze. */
export function gcByBatch(r: MeasuredResults): GcByBatchSummary | undefined {
  const { gcEvents, samples, batchOffsets } = r;
  if (!gcEvents?.length || !batchOffsets?.length) return undefined;

  const endTimes = cumulativeEndTimes(samples);
  const placed = gcEvents
    .filter(e => e.offset !== undefined && e.offset >= 0)
    .map(e => ({ event: e, sampleIndex: mapToSample(e.offset!, endTimes) }));
  if (!placed.length) return undefined;

  const full = placed.filter(p => p.event.type === "mark-compact");
  const scavenges = placed.filter(p => p.event.type === "scavenge").length;

  const perBatchCounts = countFullPerBatch(full, batchOffsets, samples.length);
  return {
    batches: batchOffsets.length,
    fullPerBatch: spread(perBatchCounts),
    fullPause: spread(full.map(p => p.event.pauseMs)),
    fullCollected: spread(full.map(p => p.event.collected)),
    scavenges,
    fullGCs: full.length,
    cacheProbe: cacheProbe(full, samples),
  };
}

/** Running total of sample durations (loop-relative end time of each sample). */
function cumulativeEndTimes(samples: number[]): number[] {
  const ends = new Array<number>(samples.length);
  let sum = 0;
  for (let i = 0; i < samples.length; i++) {
    sum += samples[i];
    ends[i] = sum;
  }
  return ends;
}

/** Map a loop-relative offset (ms) to the sample whose window contains it. */
function mapToSample(offset: number, endTimes: number[]): number {
  const idx = endTimes.findIndex(t => t >= offset);
  return idx >= 0 ? idx : endTimes.length - 1;
}

type PlacedEvent = { event: GcEvent; sampleIndex: number };

/** Count full GCs falling in each batch's sample range. */
function countFullPerBatch(
  full: PlacedEvent[],
  offsets: number[],
  total: number,
): number[] {
  const counts = new Array<number>(offsets.length).fill(0);
  for (const p of full) counts[batchOf(p.sampleIndex, offsets, total)]++;
  return counts;
}

/** @return the batch index whose sample range contains sampleIndex. */
function batchOf(
  sampleIndex: number,
  offsets: number[],
  total: number,
): number {
  for (let b = offsets.length - 1; b >= 0; b--) {
    const end = b + 1 < offsets.length ? offsets[b + 1] : total;
    if (sampleIndex >= offsets[b] && sampleIndex < end) return b;
  }
  return 0;
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

/** Probe whether iterations right after a full GC run slower than the loop
 *  mean (a cache/compaction penalty not captured by the pause time). */
function cacheProbe(
  full: PlacedEvent[],
  samples: number[],
): CacheProbe | undefined {
  const postGc: number[] = [];
  let events = 0;
  for (const p of full) {
    const start = p.sampleIndex + 1;
    const end = Math.min(start + cacheWindowK, samples.length);
    if (end <= start) continue;
    events++;
    for (let i = start; i < end; i++) postGc.push(samples[i]);
  }
  if (!postGc.length) return undefined;

  const overallMean = average(samples);
  const postGcMean = average(postGc);
  const penaltyRatio = overallMean > 0 ? postGcMean / overallMean - 1 : 0;
  return {
    windowK: cacheWindowK,
    events,
    postGcMean,
    overallMean,
    penaltyRatio,
  };
}
