/** Merge multiple batch results and run batched pairs with alternation. */
import { computeStats } from "./BasicRunner.ts";
import type { GcStats } from "./GcStats.ts";
import type { MeasuredResults } from "./MeasuredResults.ts";

/** Merge multiple batch results, concatenating samples and tracking batch boundaries.
 *  Unhandled fields fall through from the last batch (reasonable default). */
export function mergeBatchResults(results: MeasuredResults[]): MeasuredResults {
  if (results.length === 0) {
    throw new Error("Cannot merge empty results array");
  }
  if (results.length === 1) return results[0];

  const allSamples = results.flatMap(r => r.samples);
  const time = computeStats(allSamples);

  // concat per-sample arrays, tracking batch boundaries
  let offset = 0;
  const batchOffsets: number[] = [];
  const pauses = results.flatMap(r => {
    batchOffsets.push(offset);
    const shifted = (r.pausePoints ?? []).map(p => ({
      sampleIndex: p.sampleIndex + offset,
      durationMs: p.durationMs,
    }));
    offset += r.samples.length;
    return shifted;
  });

  // last batch as base ==> new MeasuredResults fields get "take last"
  // semantics by default instead of silently disappearing
  return {
    ...results[results.length - 1],
    name: results[0].name,
    samples: allSamples,
    warmupSamples: concatOptional(results, r => r.warmupSamples),
    allocationSamples: concatOptional(results, r => r.allocationSamples),
    heapSamples: concatOptional(results, r => r.heapSamples),
    timestamps: concatOptional(results, r => r.timestamps),
    optSamples: concatOptional(results, r => r.optSamples),
    time,
    totalTime: results.reduce((sum, r) => sum + (r.totalTime || 0), 0),
    pausePoints: pauses.length ? pauses : undefined,
    batchOffsets,
    gcStats: mergeGcStats(results),
  };
}

/** Concat optional number arrays across batches. */
function concatOptional(
  results: MeasuredResults[],
  fn: (r: MeasuredResults) => number[] | undefined,
): number[] | undefined {
  const all = results.flatMap(r => fn(r) || []);
  return all.length ? all : undefined;
}

/** Sum GcStats across batches, or undefined if none collected. */
function mergeGcStats(results: MeasuredResults[]): GcStats | undefined {
  const stats = results.map(r => r.gcStats).filter(Boolean) as GcStats[];
  if (!stats.length) return undefined;
  const sum = (fn: (s: GcStats) => number | undefined) =>
    stats.reduce((acc, s) => acc + (fn(s) ?? 0), 0);
  return {
    scavenges: sum(s => s.scavenges),
    markCompacts: sum(s => s.markCompacts),
    totalCollected: sum(s => s.totalCollected),
    gcPauseTime: sum(s => s.gcPauseTime),
    totalAllocated: sum(s => s.totalAllocated) || undefined,
    totalPromoted: sum(s => s.totalPromoted) || undefined,
    totalSurvived: sum(s => s.totalSurvived) || undefined,
  };
}

/** Run a benchmark+baseline pair in batched alternation, merge results. */
export async function runBatchedPair(
  runCurrent: () => Promise<MeasuredResults>,
  runBaseline: (() => Promise<MeasuredResults>) | undefined,
  batches: number,
  warmupBatch = false,
): Promise<{ current: MeasuredResults; baseline?: MeasuredResults }> {
  const currentBatches: MeasuredResults[] = [];
  const baselineBatches: MeasuredResults[] = [];

  for (let i = 0; i < batches; i++) {
    const reverse = i % 2 === 1;
    if (reverse) {
      currentBatches.push(await runCurrent());
      if (runBaseline) baselineBatches.push(await runBaseline());
    } else {
      if (runBaseline) baselineBatches.push(await runBaseline());
      currentBatches.push(await runCurrent());
    }
  }

  if (!warmupBatch && batches > 1) {
    currentBatches.shift();
    baselineBatches.shift();
  }

  return {
    current: mergeBatchResults(currentBatches),
    baseline: baselineBatches.length
      ? mergeBatchResults(baselineBatches)
      : undefined,
  };
}
