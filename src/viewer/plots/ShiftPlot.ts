import {
  type ShiftFunction,
  type ShiftPercentile,
  shiftMarginBand,
} from "../ReportData.ts";
import {
  drawDivider,
  drawMarginBand,
  drawYAxis,
  drawZeroLine,
} from "./ShiftAxis.ts";
import {
  margin,
  type Scale,
  scalePoints,
  slotCenters,
  wideCiPoints,
} from "./ShiftLayout.ts";
import { drawMarker, drawPercentileLabel, drawViolin } from "./ShiftViolins.ts";
import { clipLayer, createSvg } from "./SvgHelpers.ts";

export interface ShiftPlotOptions {
  width?: number;
  height?: number;
  /** Called when a percentile's violin is clicked (for a detail popup). */
  onSelect?: (point: ShiftPercentile) => void;
}

const defaults = { width: 760, height: 300 };

/** Create a shift-function plot: one violin per percentile showing the diff
 *  distribution across the whole sample distribution. Violins are colored by
 *  per-percentile direction. A CI far wider than its peers' never sets the
 *  y-axis: the violin clips at the plot edge with a caption instead, greyed
 *  and dashed when the point is also inconclusive (nothing about it is
 *  known). A +/- equivalence band and zero line span the plot. */
export function createShiftPlot(
  shift: ShiftFunction,
  options: ShiftPlotOptions = {},
): SVGSVGElement {
  const opts = { ...defaults, ...options };
  const svg = createSvg(opts.width, opts.height);
  const points = shift.points;
  if (!points.length) return svg;

  const plotWidth = opts.width - margin.left - margin.right;
  const plotHeight = opts.height - margin.top - margin.bottom;
  const band = shiftMarginBand(shift);
  const yScale = buildYScale(points, band, plotHeight);
  const centers = slotCenters(points, plotWidth);
  const halfMax = centers.slotWidth * 0.42;
  const maxCount = maxHistogramCount(points);
  const wide = wideCiPoints(points);

  if (band) drawMarginBand(svg, band, yScale, opts.width);
  drawZeroLine(svg, yScale, opts.width);
  drawYAxis(svg, yScale, points, band);
  if (centers.dividerX != null) drawDivider(svg, centers.dividerX, plotHeight);

  const layer = clipLayer(svg, margin.left, margin.top, plotWidth, plotHeight);

  points.forEach((point, i) => {
    const cx = centers.cx[i];
    const wideCi = wide.has(point);
    const markOpts = { yScale, wideCi, onSelect: opts.onSelect };
    drawViolin(layer, point, cx, halfMax, maxCount, markOpts);
    drawMarker(layer, point, cx, plotHeight, markOpts);
    drawPercentileLabel(svg, point, cx, opts.height, wideCi);
  });

  return svg;
}

/** y-scale mapping diff-percent to pixels, spanning the well-measured points' CI
 *  bounds (see scalePoints), the margin band, and zero. Keyed to CI bounds, not
 *  the violin histograms: those span the full bootstrap range (binValues), so
 *  extreme outlier resamples would otherwise stretch the axis. Violin tails past
 *  the CI are clipped to the plot rect instead. */
function buildYScale(
  points: ShiftPercentile[],
  band: [number, number] | undefined,
  plotH: number,
): Scale {
  let min = 0;
  let max = 0;
  const consider = (v: number) => {
    if (v < min) min = v;
    if (v > max) max = v;
  };
  if (band) {
    consider(band[0]);
    consider(band[1]);
  }
  for (const p of scalePoints(points)) {
    consider(p.diff.ci[0]);
    consider(p.diff.ci[1]);
  }
  const pad = (max - min) * 0.05 || 1;
  min -= pad;
  max += pad;
  const range = max - min || 1;
  return (v: number) => margin.top + plotH - ((v - min) / range) * plotH;
}

/** @return the largest histogram bin count across all percentiles, for a
 *  shared violin-width scale (fatter == more concentrated, not just rescaled). */
function maxHistogramCount(points: ShiftPercentile[]): number {
  let max = 1;
  for (const p of points)
    for (const b of p.diff.histogram ?? []) if (b.count > max) max = b.count;
  return max;
}
