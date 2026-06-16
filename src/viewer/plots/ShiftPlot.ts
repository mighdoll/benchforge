import type { ShiftFunction, ShiftPercentile } from "../ReportData.ts";
import {
  drawDivider,
  drawMarginBand,
  drawYAxis,
  drawZeroLine,
} from "./ShiftAxis.ts";
import { margin, type Scale, scalePoints } from "./ShiftLayout.ts";
import { drawMarker, drawPercentileLabel, drawViolin } from "./ShiftViolins.ts";
import { createSvg, ensureClipRect, svgNS } from "./SvgHelpers.ts";

export interface ShiftPlotOptions {
  width?: number;
  height?: number;
  /** Called when a percentile's violin is clicked (for a detail popup). */
  onSelect?: (point: ShiftPercentile) => void;
}

const defaults = { width: 760, height: 300 };

/** Create a shift-function plot: one violin per percentile showing the diff
 *  distribution across the whole sample distribution. Violins are colored by
 *  per-percentile direction; unreliable percentiles (too few tail samples) are
 *  greyed and dashed to downweight them visually. A +/- equivalence band and
 *  zero line span the plot. */
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
  const yScale = buildYScale(points, shift.equivMargin, plotHeight);
  const centers = slotCenters(points, plotWidth);
  const halfMax = centers.slotWidth * 0.42;
  const maxCount = maxHistogramCount(points);

  if (shift.equivMargin)
    drawMarginBand(svg, shift.equivMargin, yScale, opts.width);
  drawZeroLine(svg, yScale, opts.width);
  drawYAxis(svg, yScale, points, shift.equivMargin);
  if (centers.dividerX != null) drawDivider(svg, centers.dividerX, plotHeight);

  const layer = clipLayer(svg, plotWidth, plotHeight);

  points.forEach((point, i) => {
    const cx = centers.cx[i];
    drawViolin(layer, point, cx, halfMax, maxCount, yScale, opts.onSelect);
    drawMarker(layer, point, cx, yScale);
    drawPercentileLabel(svg, point, cx, opts.height);
  });

  return svg;
}

/** y-scale mapping diff-percent to pixels, spanning the reliable points' CI
 *  bounds (see scalePoints), the margin band, and zero. Keyed to CI bounds, not
 *  the violin histograms: those span the full bootstrap range (binValues), so
 *  extreme outlier resamples would otherwise stretch the axis. Violin tails past
 *  the CI are clipped to the plot rect instead. */
function buildYScale(
  points: ShiftPercentile[],
  equivMargin: number | undefined,
  plotH: number,
): Scale {
  let min = 0;
  let max = 0;
  const consider = (v: number) => {
    if (v < min) min = v;
    if (v > max) max = v;
  };
  if (equivMargin) {
    consider(-equivMargin);
    consider(equivMargin);
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

/** Slot centers across the plot. A leading mean point gets its own slot, set off
 *  from the percentiles by an extra half-slot gap with a divider line between. */
function slotCenters(
  points: ShiftPercentile[],
  plotWidth: number,
): { cx: number[]; slotWidth: number; dividerX: number | null } {
  const hasMean = points[0]?.isMean ?? false;
  // the gap before p1 costs one extra half-slot of width
  const slots = points.length + (hasMean ? 0.5 : 0);
  const slotWidth = plotWidth / slots;
  const gap = hasMean ? slotWidth * 0.5 : 0;
  const cx = points.map((_, i) => {
    const lead = i === 0 || !hasMean ? 0 : gap;
    return margin.left + lead + slotWidth * (i + 0.5);
  });
  const dividerX = hasMean ? margin.left + slotWidth + gap * 0.5 : null;
  return { cx, slotWidth, dividerX };
}

/** @return the largest histogram bin count across all percentiles, for a
 *  shared violin-width scale (fatter == more concentrated, not just rescaled). */
function maxHistogramCount(points: ShiftPercentile[]): number {
  let max = 1;
  for (const p of points)
    for (const b of p.diff.histogram ?? []) if (b.count > max) max = b.count;
  return max;
}

/** A clipped <g> covering the plot rect: violins/markers drawn into it are cut
 *  at the axis bounds. The y-scale is set by reliable points only (buildYScale),
 *  so an unreliable tail percentile's huge spread can't overflow into the axis
 *  and labels. */
function clipLayer(
  svg: SVGSVGElement,
  plotWidth: number,
  plotHeight: number,
): SVGGElement {
  const clip = ensureClipRect(
    svg,
    "plot-clip",
    margin.left,
    margin.top,
    plotWidth,
    plotHeight,
  );
  const layer = document.createElementNS(svgNS, "g");
  layer.setAttribute("clip-path", `url(#${clip})`);
  svg.appendChild(layer);
  return layer;
}
