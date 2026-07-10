import {
  resolveDisplayTracks,
  type TrackInput,
} from "../../report/TrackResolution.ts";
import { splitByOffsets, tukeyKeep } from "../../stats/BlockBootstrap.ts";
import {
  cumulativeSum,
  mean,
  sampleIndexAtOffset,
} from "../../stats/CoreStats.ts";
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

/** Resolve a group into the series to plot, using the same mode-aware resolver
 *  as the stat sections so plots and tables agree on a case's display tracks.
 *  Draws one series per track (the paired baselines the resolver attaches are
 *  for the tables' Δ%, not plotted), baselines first to preserve z-order/legend,
 *  de-duplicated by name (a version baseline shared across variants shows once). */
export function prepareBenchmarks(
  group: ReportData["groups"][0],
): PreparedBenchmark[] {
  const inputs = group.benchmarks.map(toTrackInput);
  const groupBaseline = group.baseline
    ? toTrackInput(group.baseline)
    : undefined;
  const tracks = resolveDisplayTracks(
    inputs,
    group.baselineVariantId,
    groupBaseline,
  );

  const ordered = [
    ...tracks.filter(t => t.isBaseline),
    ...tracks.filter(t => !t.isBaseline),
  ];
  const seen = new Set<string>();
  const series: PreparedBenchmark[] = [];
  for (const t of ordered) {
    if (seen.has(t.name)) continue;
    seen.add(t.name);
    series.push({ ...t.payload, name: t.name, isBaseline: t.isBaseline });
  }
  return series;
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
  const sliceSample = <T extends { benchmark: string; sampleIndex: number }>(
    arr: T[],
  ) =>
    arr
      .filter(d => inBatch(d.benchmark, d.sampleIndex))
      .map(d => ({ ...d, sampleIndex: reindex(d.benchmark, d.sampleIndex) }));

  return {
    allSamples: sliceIter(flat.allSamples),
    timeSeries: sliceIter(flat.timeSeries.filter(d => !d.isWarmup)),
    heapSeries: sliceIter(flat.heapSeries),
    baselineHeapSeries: sliceIter(flat.baselineHeapSeries),
    allGcEvents: sliceSample(flat.allGcEvents),
    allPausePoints: sliceSample(flat.allPausePoints),
  };
}

/** Remap x from per-series sample index to batch fraction so interleaved
 *  baseline and current batches align on a shared "Batch" axis. Each point's x
 *  becomes batchIndex + (sampleIndex - batchStart) / batchLength, computed per
 *  benchmark from its own batchOffsets. Warmup samples (negative index) map into
 *  the first batch's fraction so they stay just left of 0. Used for the "All"
 *  view; the per-batch drill-down keeps the raw per-iteration axis. */
export function batchAlignX(
  flat: FlattenedData,
  benchmarks: PreparedBenchmark[],
): FlattenedData {
  const mappers = new Map<string, (i: number) => number>();
  for (const b of benchmarks) {
    if (b.batchOffsets?.length)
      mappers.set(
        b.name,
        batchFractionMapper(b.batchOffsets, b.samples.length),
      );
  }
  const mapX = (name: string, x: number) => mappers.get(name)?.(x) ?? x;
  const mapIter = <T extends { benchmark: string; iteration: number }>(
    arr: T[],
  ) => arr.map(d => ({ ...d, iteration: mapX(d.benchmark, d.iteration) }));
  const mapSample = <T extends { benchmark: string; sampleIndex: number }>(
    arr: T[],
  ) => arr.map(d => ({ ...d, sampleIndex: mapX(d.benchmark, d.sampleIndex) }));
  return {
    allSamples: mapIter(flat.allSamples),
    timeSeries: mapIter(flat.timeSeries),
    heapSeries: mapIter(flat.heapSeries),
    baselineHeapSeries: mapIter(flat.baselineHeapSeries),
    allGcEvents: mapSample(flat.allGcEvents),
    allPausePoints: mapSample(flat.allPausePoints),
  };
}

/** Adapt a viewer benchmark entry into a resolver input (payload is the entry
 *  itself, so its sample series ride along to the flattening step). */
function toTrackInput(entry: BenchmarkEntry): TrackInput<BenchmarkEntry> {
  return {
    name: entry.name,
    payload: entry,
    meta: entry.metadata,
    baseline: entry.baseline
      ? {
          name: entry.baseline.name,
          payload: entry.baseline,
          meta: entry.baseline.metadata,
        }
      : undefined,
  };
}

/** Extract time series, heap, GC, and pause data from one benchmark */
function flattenBenchmark(b: PreparedBenchmark, out: FlattenedData): void {
  flattenWarmup(b, b.name, out);
  flattenSamplesAndHeap(b, b.name, out);
  flattenGcEvents(b, b.name, out);
  flattenPausePoints(b, b.name, out);
}

/** Build a function mapping a sample index (or negative warmup index) to a batch
 *  fraction, given a benchmark's batch start offsets and total sample count. */
function batchFractionMapper(
  offsets: number[],
  total: number,
): (i: number) => number {
  const end = (k: number) => (k + 1 < offsets.length ? offsets[k + 1] : total);
  return (i: number) => {
    if (i < 0) return i / (end(0) - offsets[0] || 1);
    for (let k = offsets.length - 1; k >= 0; k--) {
      if (i >= offsets[k])
        return k + (i - offsets[k]) / (end(k) - offsets[k] || 1);
    }
    return 0;
  };
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
    out.timeSeries.push({
      benchmark: name,
      iteration: i,
      value,
      isWarmup: false,
      isBaseline: isBase,
      isRejected,
    });
    if (b.heapSamples?.[i] !== undefined) {
      const target = b.isBaseline ? out.baselineHeapSeries : out.heapSeries;
      target.push({ benchmark: name, iteration: i, value: b.heapSamples[i] });
    }
  });
}

/** Map full GCs (mark-compact) to sample indices using cumulative sample
 *  durations. Scavenges are skipped: they're periodic texture, not the
 *  locatable spikes we mark individually. */
function flattenGcEvents(
  b: PreparedBenchmark,
  name: string,
  out: FlattenedData,
): void {
  if (!b.gcEvents?.length) return;
  const endTimes = cumulativeSum(b.samples);
  for (const gc of b.gcEvents) {
    if (gc.type !== "mark-compact") continue;
    const sampleIndex = sampleIndexAtOffset(gc.offset, endTimes);
    out.allGcEvents.push({
      benchmark: name,
      sampleIndex,
      duration: gc.duration,
      bytes: gc.collected,
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

  const means = splitByOffsets(b.samples, offsets).map(s => mean(s));
  const kept = new Set(tukeyKeep(means));

  const rejected = new Set<number>();
  for (let bi = 0; bi < means.length; bi++) {
    if (kept.has(bi)) continue;
    const start = offsets[bi];
    const end = bi + 1 < offsets.length ? offsets[bi + 1] : b.samples.length;
    for (let j = start; j < end; j++) rejected.add(j);
  }
  return rejected.size > 0 ? rejected : undefined;
}
