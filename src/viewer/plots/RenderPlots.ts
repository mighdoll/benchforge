import {
  average,
  percentile,
  splitByOffsets,
  tukeyFences,
} from "../../stats/StatisticalUtils.ts";
import type { BenchmarkEntry, ReportData } from "../ReportData.ts";
import type {
  FlatGcEvent,
  FlatPausePoint,
  HeapPoint,
  Sample,
  TimeSeriesPoint,
} from "./PlotTypes.ts";

export interface PreparedBenchmark extends BenchmarkEntry {
  isBaseline: boolean;
}

export interface FlattenedData {
  allSamples: Sample[];
  timeSeries: TimeSeriesPoint[];
  heapSeries: HeapPoint[];
  baselineHeapSeries: HeapPoint[];
  allGcEvents: FlatGcEvent[];
  allPausePoints: FlatPausePoint[];
}

/** Combine baseline and benchmarks into a single list with display names */
export function prepareBenchmarks(
  group: ReportData["groups"][0],
): PreparedBenchmark[] {
  const base = group.baseline;
  const current = group.benchmarks.map(b => ({ ...b, isBaseline: false }));
  if (!base) return current;

  const baseName = base.name.endsWith("(baseline)")
    ? base.name
    : base.name + " (baseline)";
  return [{ ...base, name: baseName, isBaseline: true }, ...current];
}

/** Collect all sample data across benchmarks into flat arrays for plotting */
export function flattenSamples(benchmarks: PreparedBenchmark[]): FlattenedData {
  const out: FlattenedData = {
    allSamples: [],
    timeSeries: [],
    heapSeries: [],
    baselineHeapSeries: [],
    allGcEvents: [],
    allPausePoints: [],
  };
  for (const b of benchmarks) {
    if (b.samples?.length) flattenBenchmark(b, out);
  }
  return out;
}

/** Extract time series, heap, GC, and pause data from one benchmark */
function flattenBenchmark(b: PreparedBenchmark, out: FlattenedData): void {
  const name = b.name;
  const warmupCount = b.warmupSamples?.length || 0;
  b.warmupSamples?.forEach((value, i) => {
    const iteration = i - warmupCount;
    out.timeSeries.push({ benchmark: name, iteration, value, isWarmup: true });
  });

  const rejected = rejectedIndices(b);
  const endTimes = cumulativeSum(b.samples);
  b.samples.forEach((value, i) => {
    const isRejected = rejected?.has(i) || undefined;
    if (!isRejected)
      out.allSamples.push({ benchmark: name, value, iteration: i });
    out.timeSeries.push({
      benchmark: name,
      iteration: i,
      value,
      isWarmup: false,
      isBaseline: b.isBaseline || undefined,
      isRejected,
      optStatus: b.optSamples?.[i],
    });
    if (b.heapSamples?.[i] !== undefined) {
      const target = b.isBaseline ? out.baselineHeapSeries : out.heapSeries;
      target.push({ benchmark: name, iteration: i, value: b.heapSamples[i] });
    }
  });

  b.gcEvents?.forEach(gc => {
    const idx = endTimes.findIndex(t => t >= gc.offset);
    const sampleIndex = idx >= 0 ? idx : b.samples.length - 1;
    out.allGcEvents.push({
      benchmark: name,
      sampleIndex,
      duration: gc.duration,
    });
  });
  if (b.pausePoints) {
    out.allPausePoints.push(
      ...b.pausePoints.map(p => ({
        benchmark: name,
        sampleIndex: p.sampleIndex,
        durationMs: p.durationMs,
      })),
    );
  }
}

/** @return sample indices in Tukey-rejected batches, or undefined if none */
function rejectedIndices(b: PreparedBenchmark): Set<number> | undefined {
  const offsets = b.batchOffsets;
  if (!offsets || offsets.length < 4) return undefined;

  const means = splitByOffsets(b.samples, offsets).map(s => average(s));
  const [lo, hi] = tukeyFences(means, 3, percentile(means, 0.5) * 0.02);

  const rejected = new Set<number>();
  for (let bi = 0; bi < means.length; bi++) {
    if (means[bi] < lo || means[bi] > hi) {
      const start = offsets[bi];
      const end = bi + 1 < offsets.length ? offsets[bi + 1] : b.samples.length;
      for (let j = start; j < end; j++) rejected.add(j);
    }
  }
  return rejected.size > 0 ? rejected : undefined;
}

/** @return batch count from the first benchmark with batchOffsets, or 0 */
export function batchCount(benchmarks: PreparedBenchmark[]): number {
  return (
    benchmarks.find(b => b.batchOffsets?.length)?.batchOffsets?.length ?? 0
  );
}

/** Filter flattened data to a single batch, re-indexing iterations from 0 */
export function filterToBatch(
  flat: FlattenedData,
  benchmarks: PreparedBenchmark[],
  batchIndex: number,
): FlattenedData {
  const ranges = new Map<string, [number, number]>();
  for (const b of benchmarks) {
    const offsets = b.batchOffsets;
    if (!offsets?.length) continue;
    const start = offsets[batchIndex];
    const end =
      batchIndex + 1 < offsets.length
        ? offsets[batchIndex + 1]
        : b.samples.length;
    ranges.set(b.name, [start, end]);
  }

  const inBatch = (name: string, iter: number) => {
    const r = ranges.get(name);
    return r ? iter >= r[0] && iter < r[1] : true;
  };
  const reindex = (name: string, iter: number) => {
    const r = ranges.get(name);
    return r ? iter - r[0] : iter;
  };
  const sliceIter = <T extends { benchmark: string; iteration: number }>(
    arr: T[],
  ) =>
    arr
      .filter(d => inBatch(d.benchmark, d.iteration))
      .map(d => ({ ...d, iteration: reindex(d.benchmark, d.iteration) }));

  return {
    allSamples: sliceIter(flat.allSamples),
    timeSeries: sliceIter(flat.timeSeries.filter(d => !d.isWarmup)),
    heapSeries: sliceIter(flat.heapSeries),
    baselineHeapSeries: sliceIter(flat.baselineHeapSeries),
    allGcEvents: flat.allGcEvents.filter(d =>
      inBatch(d.benchmark, d.sampleIndex),
    ),
    allPausePoints: flat.allPausePoints.filter(d =>
      inBatch(d.benchmark, d.sampleIndex),
    ),
  };
}

/** Running total array, used to map GC event offsets to sample indices */
function cumulativeSum(arr: number[]): number[] {
  const result: number[] = [];
  let sum = 0;
  for (const v of arr) {
    sum += v;
    result.push(sum);
  }
  return result;
}
