import * as d3 from "d3";
import { lttb } from "./Downsampling.ts";
import type { HeapPoint, TimeSeriesPoint } from "./PlotTypes.ts";
import type { HeapScale, SampleData } from "./TimeSeriesMarks.ts";

/** A heap value mapped onto the time-series Y scale for one benchmark. */
export type HeapPlotPoint = { benchmark: string; sample: number; y: number };

/** Convert TimeSeriesPoint data to SampleData */
export function buildSampleData(
  timeSeries: TimeSeriesPoint[],
): Omit<SampleData, "displayValue">[] {
  return timeSeries.map(d => ({
    benchmark: d.benchmark,
    sample: d.iteration,
    value: d.value,
    isBaseline: d.isBaseline || false,
    isWarmup: d.isWarmup || false,
    isRejected: d.isRejected || false,
  }));
}

/** Pad Y range and snap yMin to a round number for clean axis ticks */
export function computeYRange(values: number[]) {
  const dataMin = d3.min(values)!;
  const dataMax = d3.max(values)!;
  const range = dataMax - dataMin;
  let yMin = dataMin - range * 0.15;
  const mag = 10 ** Math.floor(Math.log10(Math.abs(yMin)));
  yMin = Math.floor(yMin / mag) * mag;
  if (dataMin > 0 && yMin < 0) yMin = 0;
  return { yMin, yMax: dataMax + range * 0.05 };
}

/** Compute scale to map heap byte values into the bottom 25% of the Y axis */
export function computeHeapScale(
  allHeap: HeapPoint[],
  yMin: number,
  yMax: number,
): HeapScale | undefined {
  if (allHeap.length === 0) return undefined;
  const heapMinBytes = d3.min(allHeap, d => d.value)!;
  const heapRangeBytes = d3.max(allHeap, d => d.value)! - heapMinBytes || 1;
  return {
    heapMinBytes,
    heapRangeBytes,
    scale: ((yMax - yMin) * 0.25) / heapRangeBytes,
    yMin,
  };
}

/** Map heap byte values to the time-series Y scale and downsample via LTTB,
 *  per benchmark so the area mark never connects across series boundaries. */
export function prepareHeapData(
  heapSeries: HeapPoint[],
  hs: HeapScale,
): HeapPlotPoint[] {
  if (heapSeries.length === 0) return [];
  const byBench = d3.group(heapSeries, d => d.benchmark);
  return [...byBench.values()].flatMap(points => {
    const mapped = points.map(d => ({
      benchmark: d.benchmark,
      sample: d.iteration,
      y: hs.yMin + (d.value - hs.heapMinBytes) * hs.scale,
    }));
    return lttb(
      mapped,
      500,
      d => d.sample,
      d => d.y,
    );
  });
}
