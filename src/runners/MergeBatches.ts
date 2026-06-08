import type { GcEvent, GcStats } from "./GcStats.ts";
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

/** Per-batch timeline data shifted onto the merged sample timeline. */
interface MergedTimelines {
  batchOffsets: number[];
  offsetPauses: NonNullable<MeasuredResults["pausePoints"]>;
  mergedGcEvents: GcEvent[];
}

/**
 * V8's `Array.prototype.flatMap` caps at 2^26 = ~67M elements for fast arrays,
 * and sort/percentile passes on large merged arrays push Node past its 4GB
 * heap. Sub-microsecond benchmarks across many batches can produce 100M+
 * samples and hit either limit. Cap the merged budget and subsample each
 * batch proportionally if exceeded. The bootstrap CI already subsamples to
 * 10K, so even an aggressive cap is statistically free.
 */
const maxMergedSamples = 5_000_000;

/** Merge multiple batch results, concatenating samples and tracking batch boundaries. */
export function mergeBatchResults(results: MeasuredResults[]): MeasuredResults {
  if (results.length === 0) throw new Error("Cannot merge empty results array");
  if (results.length === 1) return { ...results[0], batchOffsets: [0] };

  const totalLen = results.reduce((sum, r) => sum + r.samples.length, 0);
  const trimmed =
    totalLen > maxMergedSamples
      ? results.map(r => subsampleBatch(r, maxMergedSamples / totalLen))
      : results;

  const allSamples = trimmed.flatMap(r => r.samples);
  const time = computeStats(allSamples);

  const { batchOffsets, offsetPauses, mergedGcEvents } =
    mergeTimelines(trimmed);
  const iterations = results.reduce(
    (sum, r) => sum + (r.iterations ?? r.samples.length),
    0,
  );
  const batchGcStats = results.flatMap(r =>
    r.gcStats ? [r.gcStats] : (r.batchGcStats ?? []),
  );

  // last batch as base ==> new MeasuredResults fields get "take last"
  // semantics by default instead of silently disappearing
  return {
    ...trimmed[trimmed.length - 1],
    name: trimmed[0].name,
    samples: allSamples,
    iterations,
    warmupSamples: concatOptional(trimmed, r => r.warmupSamples),
    allocationSamples: concatOptional(trimmed, r => r.allocationSamples),
    heapSamples: concatOptional(trimmed, r => r.heapSamples),
    time,
    startTime: trimmed[0].startTime,
    totalTime: results.reduce((sum, r) => sum + (r.totalTime || 0), 0),
    pausePoints: offsetPauses.length ? offsetPauses : undefined,
    batchOffsets,
    gcStats: mergeGcStats(results),
    batchGcStats: batchGcStats.length ? batchGcStats : undefined,
    gcEvents: mergedGcEvents.length ? mergedGcEvents : undefined,
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

/** Systematically subsample parallel sample arrays in a batch by `factor`.
 *  Stride sampling preserves time-order for time-series plots; the bootstrap
 *  doesn't care about ordering, so this is unbiased for stats too. */
function subsampleBatch(r: MeasuredResults, factor: number): MeasuredResults {
  const stride = (arr: number[]): number[] => {
    const targetLen = Math.max(1, Math.floor(arr.length * factor));
    const step = arr.length / targetLen;
    const out = new Array<number>(targetLen);
    for (let i = 0; i < targetLen; i++) out[i] = arr[Math.floor(i * step)];
    return out;
  };
  const opt = (arr: number[] | undefined) => (arr ? stride(arr) : undefined);
  return {
    ...r,
    samples: stride(r.samples),
    heapSamples: opt(r.heapSamples),
    allocationSamples: opt(r.allocationSamples),
    pausePoints: undefined, // sample indices no longer match after stride
    gcEvents: undefined, // time offsets no longer map to strided samples
  };
}

/** Walk the batches, shifting pause points (by sample index) and GC events (by
 *  cumulative loop time) onto the merged timeline, and record each batch's start
 *  offset. GC offsets are loop-relative per batch; adding the prior batches'
 *  total time lets the merged cumulative-sample mapping place them correctly. */
function mergeTimelines(batches: MeasuredResults[]): MergedTimelines {
  const batchOffsets: number[] = [];
  const offsetPauses: NonNullable<MeasuredResults["pausePoints"]> = [];
  const mergedGcEvents: GcEvent[] = [];
  let offset = 0;
  let prefixTime = 0;
  for (const r of batches) {
    batchOffsets.push(offset);
    for (const p of r.pausePoints ?? [])
      offsetPauses.push({
        sampleIndex: p.sampleIndex + offset,
        durationMs: p.durationMs,
      });
    for (const e of r.gcEvents ?? [])
      mergedGcEvents.push(
        e.offset === undefined ? e : { ...e, offset: e.offset + prefixTime },
      );
    offset += r.samples.length;
    prefixTime += r.samples.reduce((sum, s) => sum + s, 0);
  }
  return { batchOffsets, offsetPauses, mergedGcEvents };
}

/** Concat optional number arrays across batches. */
function concatOptional(results: MeasuredResults[], fn: SamplesFn) {
  const all = results.flatMap(r => fn(r) || []);
  return all.length ? all : undefined;
}
