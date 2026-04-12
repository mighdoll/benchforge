import {
  average,
  splitByOffsets,
  tukeyKeep,
} from "../../stats/StatisticalUtils.ts";
import type { BenchmarkEntry, ReportData } from "../ReportData.ts";
import type {
  FlatGcEvent,
  FlatPausePoint,
  HeapPoint,
  Sample,
  TimeSeriesPoint,
} from "./PlotTypes.ts";

/** Benchmark entry tagged with whether it's the baseline for comparison */
export interface PreparedBenchmark extends BenchmarkEntry {
  isBaseline: boolean;
}

/** All sample data flattened across benchmarks into arrays for plotting */
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

/** Extract time series, heap, GC, and pause data from one benchmark */
function flattenBenchmark(b: PreparedBenchmark, out: FlattenedData): void {
  flattenWarmup(b, b.name, out);
  flattenSamplesAndHeap(b, b.name, out);
  flattenGcEvents(b, b.name, out);
  flattenPausePoints(b, b.name, out);
}

/** Warmup samples get negative iteration indices so they appear left of zero */
function flattenWarmup(
  b: PreparedBenchmark,
  name: string,
  out: FlattenedData,
): void {
  const warmupCount = b.warmupSamples?.length || 0;
  b.warmupSamples?.forEach((value, i) => {
    out.timeSeries.push({
      benchmark: name,
      iteration: i - warmupCount,
      value,
      isWarmup: true,
    });
  });
}

/** Populate timeSeries, allSamples (excluding rejected), and heap data */
function flattenSamplesAndHeap(
  b: PreparedBenchmark,
  name: string,
  out: FlattenedData,
): void {
  const rejected = rejectedIndices(b);
  const isBase = b.isBaseline || undefined;
  b.samples.forEach((value, i) => {
    const isRejected = rejected?.has(i) || undefined;
    if (!isRejected)
      out.allSamples.push({ benchmark: name, value, iteration: i });
    const optStatus = b.optSamples?.[i];
    out.timeSeries.push({
      benchmark: name,
      iteration: i,
      value,
      isWarmup: false,
      isBaseline: isBase,
      isRejected,
      optStatus,
    });
    if (b.heapSamples?.[i] !== undefined) {
      const target = b.isBaseline ? out.baselineHeapSeries : out.heapSeries;
      target.push({ benchmark: name, iteration: i, value: b.heapSamples[i] });
    }
  });
}

/** Map GC events to sample indices using cumulative sample durations */
function flattenGcEvents(
  b: PreparedBenchmark,
  name: string,
  out: FlattenedData,
): void {
  if (!b.gcEvents?.length) return;
  const endTimes = cumulativeSum(b.samples);
  for (const gc of b.gcEvents) {
    const idx = endTimes.findIndex(t => t >= gc.offset);
    const sampleIndex = idx >= 0 ? idx : b.samples.length - 1;
    out.allGcEvents.push({
      benchmark: name,
      sampleIndex,
      duration: gc.duration,
    });
  }
}

/** Flatten benchmark pause points into the shared output arrays */
function flattenPausePoints(
  b: PreparedBenchmark,
  name: string,
  out: FlattenedData,
): void {
  if (!b.pausePoints) return;
  for (const p of b.pausePoints)
    out.allPausePoints.push({
      benchmark: name,
      sampleIndex: p.sampleIndex,
      durationMs: p.durationMs,
    });
}

/** @return sample indices in Tukey-rejected batches, or undefined if none */
function rejectedIndices(b: PreparedBenchmark): Set<number> | undefined {
  const offsets = b.batchOffsets;
  if (!offsets || offsets.length < 4) return undefined;

  const means = splitByOffsets(b.samples, offsets).map(s => average(s));
  const kept = new Set(tukeyKeep(means));

  const rejected = new Set<number>();
  for (let bi = 0; bi < means.length; bi++) {
    if (!kept.has(bi)) {
      const start = offsets[bi];
      const end = bi + 1 < offsets.length ? offsets[bi + 1] : b.samples.length;
      for (let j = start; j < end; j++) rejected.add(j);
    }
  }
  return rejected.size > 0 ? rejected : undefined;
}

/** Running total of sample durations, used to map GC offsets to sample indices */
function cumulativeSum(arr: number[]): number[] {
  const result: number[] = [];
  let sum = 0;
  for (const v of arr) {
    sum += v;
    result.push(sum);
  }
  return result;
}
