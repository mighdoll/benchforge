/** Merge multiple batch results and run batched pairs with alternation. */
import { computeStats } from "./BasicRunner.ts";
import type { MeasuredResults } from "./MeasuredResults.ts";

/** Merge multiple batch results, concatenating samples and tracking batch boundaries. */
export function mergeBatchResults(
  results: MeasuredResults[],
): MeasuredResults {
  if (results.length === 0) {
    throw new Error("Cannot merge empty results array");
  }
  if (results.length === 1) return results[0];

  const allSamples = results.flatMap(r => r.samples);
  const allWarmup = results.flatMap(r => r.warmupSamples || []);
  const time = computeStats(allSamples);

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

  return {
    name: results[0].name,
    samples: allSamples,
    warmupSamples: allWarmup.length ? allWarmup : undefined,
    time,
    totalTime: results.reduce((sum, r) => sum + (r.totalTime || 0), 0),
    pausePoints: pauses.length ? pauses : undefined,
    batchOffsets,
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
