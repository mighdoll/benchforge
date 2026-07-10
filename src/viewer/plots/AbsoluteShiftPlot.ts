import type { AbsolutePercentile, AbsoluteShift } from "../ReportData.ts";
import { drawDivider } from "./ShiftAxis.ts";
import { margin, type Scale, slotCenters } from "./ShiftLayout.ts";
import { drawViolinBody, type ViolinVisual } from "./ShiftViolins.ts";
import {
  arrowheadPath,
  circle,
  clipLayer,
  createSvg,
  line,
  path,
  svgNS,
  text,
} from "./SvgHelpers.ts";

export interface AbsoluteShiftPlotOptions {
  width?: number;
  height?: number;
  /** Called when a percentile's violin/marker is clicked (for a detail popup). */
  onSelect?: (point: AbsolutePercentile) => void;
}

const defaults = { width: 760, height: 300 };

// One neutral accent: with no baseline there's no better/worse direction to
// encode. Unreliable percentiles read as light grey with a dashed outline,
// matching the diff plot's weak treatment.
const accent = "#3b82f6";
const weakColor = "#cbd5e1";

/** Create an absolute-distribution fan: one violin per percentile of a single
 *  variant's own values (no comparison), for runs with no baseline. Mirrors the
 *  shift plot's layout (leading mean slot, per-percentile violins) but the
 *  y-axis is in the metric's own units and violins carry no direction. */
export function createAbsoluteShiftPlot(
  shift: AbsoluteShift,
  options: AbsoluteShiftPlotOptions = {},
): SVGSVGElement {
  const opts = { ...defaults, ...options };
  const svg = createSvg(opts.width, opts.height);
  const points = shift.points;
  if (!points.length) return svg;

  // value-domain labels (e.g. "600,000") are wider than the diff plot's "+5%";
  // size the left gutter to the longest tick so they aren't clipped.
  const left = leftMargin(shift.axisTicks);
  const plotWidth = opts.width - left - margin.right;
  const plotHeight = opts.height - margin.top - margin.bottom;
  const yScale = buildYScale(shift.domain, plotHeight);
  const centers = slotCenters(points, plotWidth, left);
  const halfMax = centers.slotWidth * 0.42;
  const maxCount = maxHistogramCount(points);

  drawYAxis(svg, shift.axisTicks, yScale, left, plotWidth);
  if (centers.dividerX != null) drawDivider(svg, centers.dividerX, plotHeight);

  const layer = clipLayer(svg, left, margin.top, plotWidth, plotHeight);
  points.forEach((point, i) => {
    const cx = centers.cx[i];
    drawViolin(layer, point, cx, halfMax, maxCount, yScale, opts.onSelect);
    drawMarker(layer, point, cx, plotHeight, yScale, opts.onSelect);
    drawLabel(svg, point, cx, opts.height);
  });
  return svg;
}

/** Left gutter width: enough for the longest tick label at 10px (~6px/char),
 *  but never narrower than the shared diff-plot margin. */
function leftMargin(ticks: { label: string }[]): number {
  const maxChars = ticks.reduce((n, t) => Math.max(n, t.label.length), 0);
  return Math.max(margin.left, maxChars * 6 + 12);
}

/** Linear y-scale mapping a display-domain value to pixels over the given
 *  [min, max] domain (top == max). */
function buildYScale(domain: [number, number], plotH: number): Scale {
  const [min, max] = domain;
  const range = max - min || 1;
  return (v: number) => margin.top + plotH - ((v - min) / range) * plotH;
}

/** @return the largest histogram bin count across all percentiles, for a shared
 *  violin-width scale (fatter == more concentrated). */
function maxHistogramCount(points: AbsolutePercentile[]): number {
  let max = 1;
  for (const p of points)
    for (const b of p.ci.histogram ?? []) if (b.count > max) max = b.count;
  return max;
}

/** y-axis ticks in the metric's own units, from the pre-formatted tick labels. */
function drawYAxis(
  svg: SVGSVGElement,
  ticks: { value: number; label: string }[],
  yScale: Scale,
  left: number,
  plotWidth: number,
): void {
  for (const tick of ticks) {
    const y = yScale(tick.value);
    svg.appendChild(
      line(left - 4, y, left + plotWidth, y, {
        stroke: "#eceff3",
        strokeWidth: "1",
      }),
    );
    svg.appendChild(text(left - 7, y + 3.5, tick.label, "end", "10"));
  }
}

/** A vertical violin of the variant's absolute distribution at one percentile,
 *  neutral-colored (grey and dashed when the tail is too sparse to trust). */
function drawViolin(
  parent: SVGElement,
  point: AbsolutePercentile,
  cx: number,
  halfMax: number,
  maxCount: number,
  yScale: Scale,
  onSelect?: (point: AbsolutePercentile) => void,
): void {
  const visual: ViolinVisual = {
    histogram: point.ci.histogram,
    trusted: point.reliable,
    stroke: point.reliable ? accent : weakColor,
  };
  drawViolinBody(
    parent,
    visual,
    cx,
    halfMax,
    maxCount,
    yScale,
    violinTitle(point),
    onSelect && (() => onSelect(point)),
  );
}

/** Point-estimate marker: hollow circle, or an edge arrow when the estimate
 *  sits past the axis range (a wide tail percentile the axis doesn't key). */
function drawMarker(
  parent: SVGElement,
  point: AbsolutePercentile,
  cx: number,
  plotHeight: number,
  yScale: Scale,
  onSelect?: (point: AbsolutePercentile) => void,
): void {
  const stroke = point.reliable ? accent : weakColor;
  const cy = yScale(point.ci.estimate);
  const top = margin.top;
  const bottom = margin.top + plotHeight;
  if (cy < top || cy > bottom) {
    const down = cy > bottom;
    const edge = down ? bottom : top;
    const arrow = offScaleArrow(point, cx, edge, down, stroke);
    if (onSelect) {
      arrow.style.cursor = "pointer";
      arrow.addEventListener("click", () => onSelect(point));
    }
    parent.appendChild(arrow);
    return;
  }
  parent.appendChild(
    circle(cx, cy, 3, {
      fill: "#fff",
      stroke,
      strokeWidth: "1.5",
      pointerEvents: "none",
    }),
  );
}

/** Percentile label under the axis; the verdict point is enlarged and captions
 *  its value, and unreliable points caption their sample count. */
function drawLabel(
  svg: SVGSVGElement,
  point: AbsolutePercentile,
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
      point.isPrimary ? "13" : "11",
      color,
      point.isPrimary ? "700" : "600",
    ),
  );
  if (point.isPrimary && point.reliable) {
    svg.appendChild(
      text(
        cx,
        height - margin.bottom + 29,
        point.ci.estimateLabel ?? "",
        "middle",
        "11",
        accent,
        "700",
      ),
    );
    return;
  }
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

/** Native hover tooltip: the percentile's value and CI, or why it can't be
 *  trusted (too few tail samples). */
function violinTitle(point: AbsolutePercentile): SVGTitleElement {
  const node = document.createElementNS(svgNS, "title");
  const { estimateLabel, ciLabels } = point.ci;
  const range = ciLabels ? ` (${ciLabels[0]} .. ${ciLabels[1]})` : "";
  if (!point.reliable)
    node.textContent = `${point.label} - ${estimateLabel ?? ""}${range} - insufficient data (n=${point.tailCount})`;
  else node.textContent = `${point.label} - ${estimateLabel ?? ""}${range}`;
  return node;
}

/** Small solid arrowhead at the plot edge pointing toward an off-scale estimate. */
function offScaleArrow(
  point: AbsolutePercentile,
  cx: number,
  edge: number,
  down: boolean,
  fill: string,
): SVGElement {
  const arrow = path(arrowheadPath(cx, edge, down), { fill });
  arrow.appendChild(violinTitle(point));
  return arrow;
}

/** Label color: dark for the primary mean, mid accent when reliable, weak otherwise. */
function labelColor(point: AbsolutePercentile): string {
  if (point.isMean) return "#111827";
  return point.reliable ? "#374151" : weakColor;
}
