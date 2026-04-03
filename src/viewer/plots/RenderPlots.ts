import {
  average,
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
  allGcEvents: FlatGcEvent[];
  allPausePoints: FlatPausePoint[];
}

/** Combine baseline and benchmarks into a single list with display names */
export function prepareBenchmarks(
  group: ReportData["groups"][0],
): PreparedBenchmark[] {
  const base = group.baseline;
  const baseName = base?.name.endsWith("(baseline)")
    ? base.name
    : base?.name + " (baseline)";
  const baseline: PreparedBenchmark[] = base
    ? [{ ...base, name: baseName, isBaseline: true }]
    : [];
  const current = group.benchmarks.map(b => ({
    ...b,
    isBaseline: false,
  }));
  return [...baseline, ...current];
}

/** Collect all sample data across benchmarks into flat arrays for plotting */
export function flattenSamples(benchmarks: PreparedBenchmark[]): FlattenedData {
  const out: FlattenedData = {
    allSamples: [],
    timeSeries: [],
    heapSeries: [],
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

  const endTimes = cumulativeSum(b.samples);
  b.samples.forEach((value, i) => {
    out.allSamples.push({ benchmark: name, value, iteration: i });
    out.timeSeries.push({
      benchmark: name,
      iteration: i,
      value,
      isWarmup: false,
      isBaseline: b.isBaseline || undefined,
      optStatus: b.optSamples?.[i],
    });
    if (!b.isBaseline && b.heapSamples?.[i] !== undefined) {
      out.heapSeries.push({
        benchmark: name,
        iteration: i,
        value: b.heapSamples[i],
      });
    }
  });

  markRejectedBlocks(b, out.timeSeries);

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

/** Flag timeSeries entries in Tukey-rejected blocks (3x IQR on block means) */
function markRejectedBlocks(
  b: PreparedBenchmark,
  timeSeries: TimeSeriesPoint[],
): void {
  const offsets = b.batchOffsets;
  if (!offsets || offsets.length < 4) return;

  const blocks = splitByOffsets(b.samples, offsets);
  const means = blocks.map(s => average(s));
  const [lo, hi] = tukeyFences(means, 3);

  const rejected = new Set<number>();
  for (let bi = 0; bi < blocks.length; bi++) {
    if (means[bi] < lo || means[bi] > hi) {
      const start = offsets[bi];
      const end = bi + 1 < offsets.length ? offsets[bi + 1] : b.samples.length;
      for (let j = start; j < end; j++) rejected.add(j);
    }
  }
  if (rejected.size === 0) return;

  // Flag the entries we just added (last b.samples.length entries for this benchmark)
  const startIdx = timeSeries.length - b.samples.length;
  for (let i = 0; i < b.samples.length; i++) {
    if (rejected.has(i)) timeSeries[startIdx + i].isRejected = true;
  }
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
