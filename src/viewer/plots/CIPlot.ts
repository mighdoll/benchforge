import type {
  CILevel,
  DifferenceCI,
  HistogramBin,
} from "../../stats/StatisticalUtils.ts";
import {
  type Direction,
  directionColors,
  formatPct,
  gaussianSmooth,
} from "./PlotTypes.ts";
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
  direction?: Direction;
  /** Pre-formatted CI bound labels (overrides default formatPct) */
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

  drawTitles(svg, opts, margin, ptX);

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

/** Convenience wrapper for DifferenceCI data */
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

/** Top margin: room for the point-label, else the title, else a thin band. */
function layoutTop(hasPointLabel?: boolean, hasTitle?: boolean): number {
  if (hasPointLabel) return 30;
  if (hasTitle) return defaultMargin.top;
  return 6;
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
  margin: Layout["margin"],
  pointX: number,
): void {
  if (opts.title)
    svg.appendChild(
      text(margin.left, 14, opts.title, "start", "13", "currentColor", "600"),
    );
  if (opts.pointLabel)
    svg.appendChild(
      text(
        pointX,
        margin.top - 6,
        opts.pointLabel,
        "middle",
        "15",
        "currentColor",
        "700",
      ),
    );
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
    direction: Direction;
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
  const loLabel = opts.ciLabels?.[0] ?? formatPct(ci[0]);
  const hiLabel = opts.ciLabels?.[1] ?? formatPct(ci[1]);
  const loX = scales.x(ci[0]);
  const hiX = scales.x(ci[1]);
  const minGap = Math.max(loLabel.length, hiLabel.length) * 6;
  if (!opts.includeZero || hiX - loX >= minGap) {
    svg.appendChild(text(loX, labelY, loLabel, "middle", "11"));
    svg.appendChild(text(hiX, labelY, hiLabel, "middle", "11"));
  }
}
