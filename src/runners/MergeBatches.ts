import type { GcStats } from "./GcStats.ts";
import type { MeasuredResults } from "./MeasuredResults.ts";
import { computeStats } from "./SampleStats.ts";

/** Progress update emitted after each batch run. */
export interface BatchProgress {
  batch: number;
  batches: number;
  label: "baseline" | "current";
  elapsed: number;
}

type SamplesFn = (r: MeasuredResults) => number[] | undefined;

/** Merge multiple batch results, concatenating samples and tracking batch boundaries. */
export function mergeBatchResults(results: MeasuredResults[]): MeasuredResults {
  if (results.length === 0) {
    throw new Error("Cannot merge empty results array");
  }
  if (results.length === 1) return { ...results[0], batchOffsets: [0] };

  const allSamples = results.flatMap(r => r.samples);
  const time = computeStats(allSamples);

  const batchOffsets: number[] = [];
  const offsetPauses: MeasuredResults["pausePoints"] = [];
  let offset = 0;
  for (const r of results) {
    batchOffsets.push(offset);
    for (const p of r.pausePoints ?? []) {
      const sampleIndex = p.sampleIndex + offset;
      offsetPauses.push({ sampleIndex, durationMs: p.durationMs });
    }
    offset += r.samples.length;
  }

  // last batch as base ==> new MeasuredResults fields get "take last"
  // semantics by default instead of silently disappearing
  return {
    ...results[results.length - 1],
    name: results[0].name,
    samples: allSamples,
    warmupSamples: concatOptional(results, r => r.warmupSamples),
    allocationSamples: concatOptional(results, r => r.allocationSamples),
    heapSamples: concatOptional(results, r => r.heapSamples),
    optSamples: concatOptional(results, r => r.optSamples),
    time,
    startTime: results[0].startTime,
    totalTime: results.reduce((sum, r) => sum + (r.totalTime || 0), 0),
    pausePoints: offsetPauses.length ? offsetPauses : undefined,
    batchOffsets,
    gcStats: mergeGcStats(results),
  };
}

/** Sum GcStats across batches, or undefined if none collected. */
export function mergeGcStats(
  results: { gcStats?: GcStats }[],
): GcStats | undefined {
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

/** Run N benchmarks + optional baseline in batched alternation, merge results. */
export async function runBatched(
  runners: (() => Promise<MeasuredResults>)[],
  baseline: (() => Promise<MeasuredResults>) | undefined,
  batches: number,
  warmupBatch = false,
  onProgress?: (p: BatchProgress) => void,
): Promise<{ results: MeasuredResults[]; baseline?: MeasuredResults }> {
  const runnerBatches: MeasuredResults[][] = runners.map(() => []);
  const baselineBatches: MeasuredResults[] = [];
  const start = performance.now();

  const report = (batch: number, label: BatchProgress["label"]) =>
    onProgress?.({ batch, batches, label, elapsed: performance.now() - start });

  for (let i = 0; i < batches; i++) {
    const reverse = i % 2 === 1;
    // baseline runs before benchmarks on even batches, after on odd (alternation)
    if (!reverse && baseline) {
      baselineBatches.push(await baseline());
      report(i, "baseline");
    }
    for (let j = 0; j < runners.length; j++) {
      runnerBatches[j].push(await runners[j]());
      report(i, "current");
    }
    if (reverse && baseline) {
      baselineBatches.push(await baseline());
      report(i, "baseline");
    }
  }

  if (!warmupBatch && batches > 1) {
    for (const b of runnerBatches) b.shift();
    baselineBatches.shift();
  }

  const results = runnerBatches.map(b => mergeBatchResults(b));
  const mergedBaseline = baselineBatches.length
    ? mergeBatchResults(baselineBatches)
    : undefined;
  return { results, baseline: mergedBaseline };
}

/** Concat optional number arrays across batches. */
function concatOptional(results: MeasuredResults[], fn: SamplesFn) {
  const all = results.flatMap(r => fn(r) || []);
  return all.length ? all : undefined;
}
