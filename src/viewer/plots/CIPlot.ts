import type {
  CIDirection,
  CILevel,
  DifferenceCI,
  HistogramBin,
} from "../../stats/Bootstrap.ts";
import { drawCILabels, drawTitles } from "./CILabels.ts";
import {
  drawCIRegion,
  drawHistogramBars,
  drawMarginZone,
  drawReferenceLine,
  drawSmoothedDist,
} from "./CIRegions.ts";
import { directionColors } from "./PlotTypes.ts";
import { createSvg, line } from "./SvgHelpers.ts";

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

export type Scales = { x: (v: number) => number; y: (v: number) => number };
export type Layout = {
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

/** Top margin: room for the point-label, else the title, else a thin band. */
function layoutTop(hasPointLabel?: boolean, hasTitle?: boolean): number {
  if (hasPointLabel) return 30;
  if (hasTitle) return defaultMargin.top;
  return 6;
}
