import type { CIDirection, HistogramBin } from "../../stats/Bootstrap.ts";
import type { DistributionPlotOptions, Layout, Scales } from "./CIPlot.ts";
import { gaussianSmooth } from "./PlotTypes.ts";
import {
  ensureHatchPattern,
  ensureSketchFilter,
  line,
  path,
  rect,
} from "./SvgHelpers.ts";

/** Draw equivalence margin zone: hatched band centered vertically */
export function drawMarginZone(
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
export function drawCIRegion(
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
export function drawSmoothedDist(
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

export function drawHistogramBars(
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
export function drawReferenceLine(
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
