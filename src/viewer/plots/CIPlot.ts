import { formatSignedPercent } from "../../report/Formatters.ts";
import type {
  CIDirection,
  CILevel,
  DifferenceCI,
  HistogramBin,
} from "../../stats/Bootstrap.ts";
import { directionColors, gaussianSmooth } from "./PlotTypes.ts";
import {
  createSvg,
  ensureHatchPattern,
  ensureSketchFilter,
  line,
  path,
  rect,
  text,
} from "./SvgHelpers.ts";

export interface DistributionPlotOptions {
  width?: number;
  height?: number;
  title?: string;
  smooth?: boolean;
  direction?: CIDirection;
  /** Pre-formatted CI bound labels (overrides the default signed-percent) */
  ciLabels?: [string, string];
  /** Include zero in x scale (default true, set false for absolute-value plots) */
  includeZero?: boolean;
  /** Centered label above chart (e.g., the formatted point estimate) */
  pointLabel?: string;
  /** Equivalence margin in percent (draws shaded band at +/- margin) */
  equivMargin?: number;
  /** Block-level or sample-level CI */
  ciLevel?: CILevel;
  /** false ==> dashed border (insufficient batches for reliable CI) */
  ciReliable?: boolean;
  /** Explicit x-domain [min, max] to share a scale across stacked charts;
   *  defaults to this chart's own data extent. */
  domain?: [number, number];
}

type Scales = { x: (v: number) => number; y: (v: number) => number };
type Layout = {
  width: number;
  height: number;
  margin: { top: number; right: number; bottom: number; left: number };
  plot: { w: number; h: number };
};
const defaultMargin = { top: 22, right: 12, bottom: 22, left: 12 };

const defaultOpts = {
  width: 260,
  height: 85,
  title: "Δ%",
  smooth: true,
  direction: "uncertain" as const,
  includeZero: true,
};

/** Create a small distribution plot showing histogram with CI shading */
export function createDistributionPlot(
  histogram: HistogramBin[],
  ci: [number, number],
  pointEstimate: number,
  options: DistributionPlotOptions = {},
): SVGSVGElement {
  const opts = { ...defaultOpts, ...options };
  const layout = buildLayout(
    opts.width,
    opts.height,
    !!opts.pointLabel,
    !!opts.title,
  );
  const svg = createSvg(layout.width, layout.height);
  if (!histogram?.length) return svg;

  const { fill, stroke } = directionColors[opts.direction];
  const { includeZero, equivMargin, domain } = opts;
  const scales = buildScales(
    histogram,
    ci,
    layout,
    includeZero,
    equivMargin,
    pointEstimate,
    domain,
  );
  const { margin, plot } = layout;
  const ptX = scales.x(pointEstimate);

  drawTitles(svg, opts, layout, ptX);

  if (equivMargin && includeZero)
    drawMarginZone(svg, equivMargin, scales, layout);

  drawCIRegion(svg, ci, scales, layout, opts, fill);

  if (opts.smooth) drawSmoothedDist(svg, histogram, scales, stroke);
  else drawHistogramBars(svg, histogram, scales, layout, stroke);

  drawReferenceLine(svg, scales, layout, includeZero);
  svg.appendChild(
    line(ptX, margin.top, ptX, margin.top + plot.h, {
      stroke,
      strokeWidth: "2",
    }),
  );

  drawCILabels(svg, ci, scales, layout, opts);
  return svg;
}

/** Plot a DifferenceCI: forwards its histogram, label, direction, and CI level
 *  to createDistributionPlot (caller opts override). */
export function createCIPlot(
  ci: DifferenceCI,
  options: Partial<DistributionPlotOptions> = {},
): SVGSVGElement {
  if (!ci.histogram) return createSvg(0, 0);
  return createDistributionPlot(ci.histogram, ci.ci, ci.percent, {
    title: ci.label,
    direction: ci.direction,
    ciLevel: ci.ciLevel,
    ciReliable: ci.ciReliable,
    ...options,
  });
}

/** Use minimal margins when the chart is too small for standard spacing.
 *  The top band holds the title and/or point-label; with neither, collapse it
 *  to a thin margin (just enough to clear the zero-line cap) so the chart isn't
 *  preceded by dead space. */
function buildLayout(
  width: number,
  height: number,
  hasPointLabel?: boolean,
  hasTitle?: boolean,
): Layout {
  const compact = height < defaultMargin.top + defaultMargin.bottom + 10;
  const margin = compact
    ? { top: 4, right: 6, bottom: 4, left: 6 }
    : { ...defaultMargin, top: layoutTop(hasPointLabel, hasTitle) };
  const plot = {
    w: width - margin.left - margin.right,
    h: height - margin.top - margin.bottom,
  };
  return { width, height, margin, plot };
}

function buildScales(
  histogram: HistogramBin[],
  ci: [number, number],
  layout: Layout,
  includeZero: boolean,
  equivMargin?: number,
  pointEstimate?: number,
  domain?: [number, number],
): Scales {
  const { margin, plot } = layout;
  const bounds = histogram.map(b => b.x);
  bounds.push(ci[0], ci[1]);
  if (includeZero) bounds.push(0);
  if (equivMargin) bounds.push(-equivMargin, equivMargin);
  if (pointEstimate != null) bounds.push(pointEstimate);
  if (domain) bounds.push(domain[0], domain[1]);
  const xMin = Math.min(...bounds);
  const xMax = Math.max(...bounds);
  const yMax = Math.max(...histogram.map(b => b.count));
  const xRange = xMax - xMin || 1;
  return {
    x: (v: number) => margin.left + ((v - xMin) / xRange) * plot.w,
    y: (v: number) => margin.top + plot.h - (v / yMax) * plot.h,
  };
}

function drawTitles(
  svg: SVGSVGElement,
  opts: DistributionPlotOptions,
  layout: Layout,
  pointX: number,
): void {
  const { margin, width } = layout;
  if (opts.title)
    svg.appendChild(
      text(margin.left, 14, opts.title, "start", "13", "currentColor", "600"),
    );
  if (opts.pointLabel) {
    const x = clampLabelX(pointX, opts.pointLabel, "middle", width, 10);
    svg.appendChild(
      text(
        x,
        margin.top - 6,
        opts.pointLabel,
        "middle",
        "15",
        "currentColor",
        "700",
      ),
    );
  }
}

/** Draw equivalence margin zone: hatched band centered vertically */
function drawMarginZone(
  svg: SVGSVGElement,
  equivMargin: number,
  scales: Scales,
  layout: Layout,
): void {
  const { margin, plot } = layout;
  const x1 = scales.x(-equivMargin);
  const x2 = scales.x(equivMargin);
  const fill = `url(#${ensureHatchPattern(svg)})`;
  const bandH = plot.h / 3;
  const bandY = margin.top + (plot.h - bandH) / 2;
  const zone = rect(x1, bandY, x2 - x1, bandH, { fill, strokeWidth: "1.5" });
  zone.classList.add("margin-zone");
  svg.appendChild(zone);
}

/** Draw the shaded CI band; an unreliable CI gets a sketchy (dashed) filter. */
function drawCIRegion(
  svg: SVGSVGElement,
  ci: [number, number],
  scales: Scales,
  layout: Layout,
  opts: DistributionPlotOptions & {
    direction: CIDirection;
    includeZero: boolean;
  },
  fill: string,
): void {
  const { margin, plot } = layout;
  const ciX = scales.x(ci[0]);
  const ciRect = rect(ciX, margin.top, scales.x(ci[1]) - ciX, plot.h, { fill });
  const strength = opts.includeZero ? "ci-region-strong" : "ci-region";
  ciRect.classList.add(strength, `ci-${opts.direction}`);
  if (opts.ciReliable === false) {
    ciRect.classList.add("ci-unreliable");
    ciRect.setAttribute("filter", `url(#${ensureSketchFilter(svg)})`);
  }
  svg.appendChild(ciRect);
}

/** Draw a filled area + stroke path using gaussian-smoothed histogram data */
function drawSmoothedDist(
  svg: SVGSVGElement,
  histogram: HistogramBin[],
  scales: Scales,
  stroke: string,
): void {
  const sorted = [...histogram].sort((a, b) => a.x - b.x);
  const smoothed = gaussianSmooth(sorted, 2);
  const pts = smoothed.map(b => `${scales.x(b.x)},${scales.y(b.count)}`);
  const base = scales.y(0);
  const startX = scales.x(smoothed[0].x);
  const endX = scales.x(smoothed.at(-1)!.x);
  const fillD = `M${startX},${base}L${pts.join("L")}L${endX},${base}Z`;
  const fillPath = path(fillD, { fill: stroke });
  fillPath.classList.add("dist-fill");
  svg.appendChild(fillPath);
  const strokePath = path(`M${pts.join("L")}`, {
    stroke,
    fill: "none",
    strokeWidth: "1.5",
  });
  strokePath.classList.add("dist-stroke");
  svg.appendChild(strokePath);
}

function drawHistogramBars(
  svg: SVGSVGElement,
  histogram: HistogramBin[],
  scales: Scales,
  layout: Layout,
  stroke: string,
): void {
  const sorted = [...histogram].sort((a, b) => a.x - b.x);
  const binW = sorted.length > 1 ? sorted[1].x - sorted[0].x : 1;
  const xRange = scales.x(sorted.at(-1)!.x) - scales.x(sorted[0].x) + binW;
  const barW = (binW / xRange) * layout.plot.w * 0.9;
  const base = scales.y(0);
  const attrs = { fill: stroke, opacity: "0.6" };
  for (const bin of sorted) {
    const top = scales.y(bin.count);
    svg.appendChild(
      rect(scales.x(bin.x) - barW / 2, top, barW, base - top, attrs),
    );
  }
}

/** Draw zero reference line extending past plot area (comparison CIs only) */
function drawReferenceLine(
  svg: SVGSVGElement,
  scales: Scales,
  layout: Layout,
  includeZero: boolean,
): void {
  const { margin, plot } = layout;
  const zeroX = scales.x(0);
  const inBounds = zeroX >= margin.left && zeroX <= layout.width - margin.right;
  if (!includeZero || !inBounds) return;

  svg.appendChild(
    line(zeroX, margin.top - 4, zeroX, margin.top + plot.h + 4, {
      stroke: "#000",
      strokeWidth: "1",
    }),
  );
}

function drawCILabels(
  svg: SVGSVGElement,
  ci: [number, number],
  scales: Scales,
  layout: Layout,
  opts: DistributionPlotOptions & { includeZero: boolean },
): void {
  if (layout.margin.bottom < 15) return;
  const labelY = layout.height - 4;
  const loLabel = opts.ciLabels?.[0] ?? formatSignedPercent(ci[0]);
  const hiLabel = opts.ciLabels?.[1] ?? formatSignedPercent(ci[1]);
  const loX = scales.x(ci[0]);
  const hiX = scales.x(ci[1]);
  const minGap = Math.max(loLabel.length, hiLabel.length) * 6;
  const { width } = layout;

  // Too tight to fit both bounds: merge into one clamped range label at the CI
  // midpoint so the bounds stay readable (same for diff and absolute plots).
  if (hiX - loX < minGap) {
    const merged = rangeLabel(loLabel, hiLabel);
    const x = clampLabelX((loX + hiX) / 2, merged, "middle", width, 6);
    svg.appendChild(text(x, labelY, merged, "middle", "11"));
    return;
  }

  // Diff plots (includeZero) center each bound label; absolute plots anchor each
  // label outward so the two never encroach on each other. Clamp either way so
  // edge labels aren't clipped.
  if (opts.includeZero) {
    drawBoundLabel(svg, loLabel, loX, labelY, "middle", width);
    drawBoundLabel(svg, hiLabel, hiX, labelY, "middle", width);
    return;
  }
  drawBoundLabel(svg, loLabel, loX, labelY, "end", width);
  drawBoundLabel(svg, hiLabel, hiX, labelY, "start", width);
}

/** Top margin: room for the point-label, else the title, else a thin band. */
function layoutTop(hasPointLabel?: boolean, hasTitle?: boolean): number {
  if (hasPointLabel) return 30;
  if (hasTitle) return defaultMargin.top;
  return 6;
}

/** Keep a text label inside [pad, width-pad] given its anchor, so labels at the
 *  data edges aren't clipped by the SVG viewport. Width is estimated from the
 *  character count (charW ~6px at the 11px label size, ~10px for the 15px point). */
function clampLabelX(
  x: number,
  label: string,
  anchor: "start" | "middle" | "end",
  width: number,
  charW: number,
): number {
  const w = label.length * charW;
  const { left, right } = labelOverhang(anchor, w);
  const lo = 2 + left;
  const hi = width - 2 - right;
  return Math.max(lo, Math.min(hi, x));
}

/** Merge two CI bound labels into a range, or one label when they're identical
 *  at display precision. */
function rangeLabel(loLabel: string, hiLabel: string): string {
  return loLabel === hiLabel ? loLabel : `${loLabel} - ${hiLabel}`;
}

/** Draw one clamped CI-bound label at the given anchor. */
function drawBoundLabel(
  svg: SVGSVGElement,
  label: string,
  x: number,
  labelY: number,
  anchor: "start" | "middle" | "end",
  width: number,
): void {
  const clampedX = clampLabelX(x, label, anchor, width, 6);
  svg.appendChild(text(clampedX, labelY, label, anchor, "11"));
}

/** Pixels a label extends left/right of its anchor point, by anchor type. */
function labelOverhang(
  anchor: "start" | "middle" | "end",
  w: number,
): { left: number; right: number } {
  if (anchor === "start") return { left: 0, right: w };
  if (anchor === "end") return { left: w, right: 0 };
  return { left: w / 2, right: w / 2 };
}
