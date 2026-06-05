import type { MeasuredResults } from "../runners/MeasuredResults.ts";
import { median } from "../stats/StatisticalUtils.ts";

/** Per-batch time-by-position summary: how much the early iterations of each
 *  batch run above the plateau (last 50%). Agent-facing diagnostic for the JIT/
 *  heap warmup ramp, which is otherwise invisible in order-agnostic percentiles.
 *  Each batch ramps independently (heap resets per batch), so regions are taken
 *  within each batch and summarized across batches. Descriptive only: it names
 *  the warmup region, it does not recommend trimming it (the default includes
 *  warmup on purpose -- the ramp is real first-call cost). */
export interface WarmupShape {
  /** Batches contributing (those with enough samples to bucket). */
  batches: number;
  /** Position regions, plateau (last 50%) last and used as the reference. */
  regions: WarmupRegion[];
}

export interface WarmupRegion {
  label: string;
  /** Median ms for this region, summarized across batches. */
  medianMs: number;
  /** Region median relative to the batch's plateau median, as a fraction
   *  (0.26 = +26%), summarized (median) across batches. 0 for the plateau. */
  pctVsPlateau: number;
}

/** Position regions as [lo, hi) fractions of a batch; the last is the plateau. */
const regionBounds = [
  { label: "first 5%", lo: 0, hi: 0.05 },
  { label: "5-20%", lo: 0.05, hi: 0.2 },
  { label: "20-50%", lo: 0.2, hi: 0.5 },
  { label: "last 50%", lo: 0.5, hi: 1 },
];

/** Below this many samples a batch can't be split into meaningful regions. */
const minBatchSamples = 20;

/** Build a per-batch warmup-shape summary, or undefined when there aren't enough
 *  samples in any batch to bucket. */
export function warmupShape(r: MeasuredResults): WarmupShape | undefined {
  const { samples, batchOffsets } = r;
  if (!samples?.length) return undefined;

  const batches = splitBatches(samples, batchOffsets).filter(
    b => b.length >= minBatchSamples,
  );
  if (!batches.length) return undefined;

  const plateau = regionBounds.length - 1;
  const perBatch = batches.map(regionMedians);
  const regions = regionBounds.map((bound, i) => ({
    label: bound.label,
    medianMs: median(perBatch.map(b => b[i])),
    pctVsPlateau: i === plateau ? 0 : median(perBatch.map(b => b[i] / b[plateau] - 1)),
  }));
  return { batches: batches.length, regions };
}

/** Split samples into per-batch slices (the whole array when unbatched). */
function splitBatches(samples: number[], offsets?: number[]): number[][] {
  if (!offsets?.length) return [samples];
  const bounds = [...offsets, samples.length];
  return offsets.map((_, b) => samples.slice(bounds[b], bounds[b + 1]));
}

/** Median sample time within each position region of one batch. */
function regionMedians(batch: number[]): number[] {
  const n = batch.length;
  return regionBounds.map(({ lo, hi }) =>
    median(batch.slice(Math.floor(lo * n), Math.floor(hi * n))),
  );
}
