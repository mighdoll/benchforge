import type { ShiftFunction, ShiftPercentile } from "../ReportData.ts";
import { directionColors, formatPct, gaussianSmooth } from "./PlotTypes.ts";
import {
  createSvg,
  ensureHatchPattern,
  line,
  path,
  rect,
  svgNS,
  text,
} from "./SvgHelpers.ts";

export interface ShiftPlotOptions {
  width?: number;
  height?: number;
  /** Called when a percentile's violin is clicked (for a detail popup). */
  onSelect?: (point: ShiftPercentile) => void;
}

type Scale = (v: number) => number;

const weakColor = "#9ca3af";

const defaults = { width: 760, height: 300 };
const margin = { top: 14, right: 16, bottom: 34, left: 44 };

/** Per-percentile stroke: direction color when reliable, grey otherwise. */
const strokeFor = (p: ShiftPercentile) =>
  p.reliable ? directionColors[p.diff.direction].stroke : weakColor;

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

  points.forEach((point, i) => {
    const cx = centers.cx[i];
    drawViolin(svg, point, cx, halfMax, maxCount, yScale, opts.onSelect);
    drawMarker(svg, point, cx, yScale);
    drawPercentileLabel(svg, point, cx, opts.height);
  });

  return svg;
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

/** Faint vertical divider separating the mean slot from the percentile slots. */
function drawDivider(svg: SVGSVGElement, x: number, plotHeight: number): void {
  svg.appendChild(
    line(x, margin.top, x, margin.top + plotHeight, {
      stroke: "#e0e0e0",
      strokeWidth: "1",
    }),
  );
}

/** y-scale mapping diff-percent to pixels, spanning all violins + CI bounds,
 *  the margin band, and zero. */
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
  for (const p of points) {
    consider(p.diff.ci[0]);
    consider(p.diff.ci[1]);
    for (const b of p.diff.histogram ?? []) consider(b.x);
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

/** Horizontal +/- equivalence band: diffs landing inside it are treated as
 *  practically equivalent, so it spans the full plot width as a reference zone. */
function drawMarginBand(
  svg: SVGSVGElement,
  equivMargin: number,
  yScale: Scale,
  width: number,
): void {
  const yTop = yScale(equivMargin);
  const yBottom = yScale(-equivMargin);
  const bandWidth = width - margin.left - margin.right;
  const fill = `url(#${ensureHatchPattern(svg)})`;
  const band = rect(margin.left, yTop, bandWidth, yBottom - yTop, { fill });
  band.classList.add("margin-zone");
  svg.appendChild(band);
  for (const y of [yTop, yBottom])
    svg.appendChild(
      line(margin.left, y, margin.left + bandWidth, y, {
        stroke: "#d1d5db",
        strokeWidth: "1",
      }),
    );
}

/** Zero reference line spanning the plot width. */
function drawZeroLine(svg: SVGSVGElement, yScale: Scale, width: number): void {
  const y = yScale(0);
  svg.appendChild(
    line(margin.left, y, width - margin.right, y, {
      stroke: "#000",
      strokeWidth: "1",
    }),
  );
}

/** y-axis ticks at a nice step across the diff-percent range. */
function drawYAxis(
  svg: SVGSVGElement,
  yScale: Scale,
  points: ShiftPercentile[],
  equivMargin: number | undefined,
): void {
  const [spanMin, spanMax] = axisSpan(points, equivMargin);
  const step = niceStep((spanMax - spanMin) / 5);
  for (
    let tick = Math.ceil(spanMin / step) * step;
    tick <= spanMax;
    tick += step
  ) {
    const y = yScale(tick);
    svg.appendChild(
      line(margin.left - 4, y, margin.left, y, {
        stroke: "#9ca3af",
        strokeWidth: "1",
      }),
    );
    const decimals = tick % 1 ? 1 : 0;
    svg.appendChild(
      text(margin.left - 7, y + 3.5, formatPct(tick, decimals), "end", "10"),
    );
  }
}

/** A vertical violin: the smoothed diff distribution mirrored around cx. */
function drawViolin(
  svg: SVGSVGElement,
  point: ShiftPercentile,
  cx: number,
  halfMax: number,
  maxCount: number,
  yScale: Scale,
  onSelect?: (point: ShiftPercentile) => void,
): void {
  const histogram = point.diff.histogram;
  if (!histogram?.length) return;
  const stroke = strokeFor(point);
  const sorted = [...histogram].sort((a, b) => a.x - b.x);
  // light smoothing (small sigma) rounds jagged bins without merging modes,
  // since violin width here encodes uncertainty
  const smoothed = gaussianSmooth(sorted, 0.8);
  const widthOf = (count: number) => (count / maxCount) * halfMax;
  const rightEdge = smoothed.map(
    b => `${cx + widthOf(b.count)},${yScale(b.x)}`,
  );
  const leftEdge = smoothed
    .slice()
    .reverse()
    .map(b => `${cx - widthOf(b.count)},${yScale(b.x)}`);
  const outlinePath = `M${rightEdge.join("L")}L${leftEdge.join("L")}Z`;

  const group = document.createElementNS(svgNS, "g");
  group.classList.add("shift-violin");
  if (!point.reliable) group.classList.add("shift-weak");
  if (onSelect) {
    group.style.cursor = "pointer";
    group.addEventListener("click", () => onSelect(point));
  }
  const body = path(outlinePath, { fill: stroke });
  body.classList.add("shift-violin-fill");
  group.appendChild(body);
  const outline = path(outlinePath, {
    stroke,
    fill: "none",
    strokeWidth: "1.5",
  });
  group.appendChild(outline);
  svg.appendChild(group);
}

/** Point-estimate marker: hollow circle, grey when unreliable. */
function drawMarker(
  svg: SVGSVGElement,
  point: ShiftPercentile,
  cx: number,
  yScale: Scale,
): void {
  const stroke = strokeFor(point);
  const dot = document.createElementNS(svgNS, "circle");
  dot.setAttribute("cx", String(cx));
  dot.setAttribute("cy", String(yScale(point.diff.percent)));
  dot.setAttribute("r", "3");
  dot.setAttribute("fill", "#fff");
  dot.setAttribute("stroke", stroke);
  dot.setAttribute("stroke-width", "1.5");
  dot.style.pointerEvents = "none";
  svg.appendChild(dot);
}

/** Percentile label (and tail-count caption for unreliable percentiles). The
 *  mean label is drawn darker since it is the primary metric. */
function drawPercentileLabel(
  svg: SVGSVGElement,
  point: ShiftPercentile,
  cx: number,
  height: number,
): void {
  const color = labelColor(point);
  svg.appendChild(
    text(
      cx,
      height - margin.bottom + 16,
      point.label,
      "middle",
      "11",
      color,
      point.isMean ? "700" : "600",
    ),
  );
  if (!point.reliable)
    svg.appendChild(
      text(
        cx,
        height - margin.bottom + 28,
        `n=${point.tailCount}`,
        "middle",
        "9",
        weakColor,
      ),
    );
}

/** Label color: dark for the primary mean, mid-grey when reliable, weak otherwise. */
function labelColor(point: ShiftPercentile): string {
  if (point.isMean) return "#111827";
  return point.reliable ? "#374151" : weakColor;
}

/** @return [min, max] of the diff-percent axis. */
function axisSpan(
  points: ShiftPercentile[],
  equivMargin: number | undefined,
): [number, number] {
  let min = 0;
  let max = 0;
  if (equivMargin) {
    min = -equivMargin;
    max = equivMargin;
  }
  for (const p of points) {
    if (p.diff.ci[0] < min) min = p.diff.ci[0];
    if (p.diff.ci[1] > max) max = p.diff.ci[1];
  }
  return [min, max];
}

/** @return a "nice" axis step (1, 2, or 5 times a power of ten) near raw. */
function niceStep(raw: number): number {
  const mag = 10 ** Math.floor(Math.log10(raw || 1));
  const mantissa = raw / mag;
  if (mantissa < 1.5) return mag;
  if (mantissa < 3) return 2 * mag;
  if (mantissa < 7) return 5 * mag;
  return 10 * mag;
}
