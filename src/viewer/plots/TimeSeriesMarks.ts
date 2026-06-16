import * as Plot from "@observablehq/plot";
import * as d3 from "d3";
import { formatBytes } from "../../report/Formatters.ts";
import type { FlatGcEvent, FlatPausePoint } from "./PlotTypes.ts";

/** Internal sample representation with display values and metadata */
export interface SampleData {
  benchmark: string;
  sample: number;
  value: number;
  displayValue: number;
  isBaseline: boolean;
  isWarmup: boolean;
  isRejected: boolean;
}

/** Computed scales, ranges, and metadata for rendering the time series plot */
export interface PlotContext {
  convertedData: SampleData[];
  xMin: number;
  xMax: number;
  yMin: number;
  yMax: number;
  unitSuffix: string;
  formatValue: (d: number) => string;
  convertValue: (ms: number) => number;
  hasWarmup: boolean;
  hasRejected: boolean;
  baselineNames: Set<string>;
  benchmarks: string[];
}

/** Parameters for mapping heap byte values to the time series Y axis */
export interface HeapScale {
  heapMinBytes: number;
  heapRangeBytes: number;
  scale: number;
  yMin: number;
}

const gcViolet = "#7c3aed";

/** Area fill marks for heap usage overlay on the time series chart. `z` groups
 *  by benchmark so each series is its own area (no line across the gap between
 *  one benchmark's last iteration and the next benchmark's first). */
export function heapMarks(
  heapData: { benchmark: string; sample: number; y: number }[],
  yMin: number,
  color: string,
): any[] {
  if (heapData.length === 0) return [];
  return [
    Plot.areaY(heapData, {
      x: "sample",
      y: "y",
      y1: yMin,
      z: "benchmark",
      fill: color,
      fillOpacity: 0.15,
      stroke: color,
      strokeWidth: 1,
      strokeOpacity: 0.4,
    }),
  ];
}

/** Right-side Y axis for heap MB (overlaid on the time Y axis) */
export function heapAxisMarks(
  hs: HeapScale | undefined,
  xMax: number,
  xMin: number,
): any[] {
  if (!hs) return [];
  const xRange = xMax - xMin;
  // tick values sit clear of the chart; "MB" sits clear of the value text
  const tickX = xMax + xRange * 0.04;
  const labelX = xMax + xRange * 0.13;
  const minMB = hs.heapMinBytes / 1024 / 1024;
  const maxMB = (hs.heapMinBytes + hs.heapRangeBytes) / 1024 / 1024;
  const ticks = d3.ticks(minMB, maxMB, 3);
  const fmtMB = (mb: number) => {
    if (mb >= 100) return mb.toFixed(0);
    if (mb >= 10) return mb.toFixed(1);
    return mb.toFixed(2);
  };
  const tickData = ticks.map(mb => ({
    x: tickX,
    y: hs.yMin + (mb * 1024 * 1024 - hs.heapMinBytes) * hs.scale,
    label: fmtMB(mb),
  }));
  const textOpts = {
    x: "x",
    y: "y",
    fontSize: 10,
    textAnchor: "start" as const,
    fill: "#333",
    clip: false,
  };
  const mbY = hs.yMin + hs.heapRangeBytes * hs.scale * 0.5;
  const mbData = [{ x: labelX, y: mbY, text: "MB" }];
  return [
    Plot.text(tickData, { ...textOpts, text: "label" }),
    Plot.text(mbData, { ...textOpts, text: "text" }),
  ];
}

/** Full-height violet rules marking full GCs (mark-compact) across the Y range.
 *  Scavenges are filtered upstream; these are the locatable spikes. */
export function gcMark(
  gcEvents: FlatGcEvent[],
  yMin: number,
  yMax: number,
): any[] {
  return gcEvents.map(gc =>
    Plot.ruleX([gc.sampleIndex], {
      y1: yMin,
      y2: yMax,
      stroke: gcViolet,
      strokeWidth: 1,
      strokeOpacity: 0.25,
      title: gcTooltip(gc),
    }),
  );
}

/** Dashed vertical rules marking pause points across the full Y range */
export function pauseMarks(
  pausePoints: FlatPausePoint[],
  yMin: number,
  yMax: number,
): any[] {
  return pausePoints.map(p =>
    Plot.ruleX([p.sampleIndex], {
      y1: yMin,
      y2: yMax,
      stroke: "#888",
      strokeWidth: 1,
      strokeDasharray: "4,4",
      strokeOpacity: 0.7,
      title: `Pause: ${p.durationMs}ms`,
    }),
  );
}

/** Hover text for a full-GC rule: iteration, pause duration, bytes collected. */
function gcTooltip(gc: FlatGcEvent): string {
  const bytes = formatBytes(gc.bytes) ?? "0B";
  return `Full GC @ iter ${gc.sampleIndex}: ${gc.duration.toFixed(2)}ms, ${bytes} collected`;
}
