import type { ComparisonCI, HistogramBin } from "./Types.ts";

export interface DistributionPlotOptions {
  width?: number;
  height?: number;
  title?: string;
  smooth?: boolean;
  direction?: "faster" | "slower" | "uncertain";
}

const defaultOpts: Required<DistributionPlotOptions> = {
  width: 260,
  height: 85,
  title: "p50 Δ%",
  smooth: false,
  direction: "uncertain",
};

const colors = {
  faster: { fill: "#dcfce7", stroke: "#22c55e" },
  slower: { fill: "#fee2e2", stroke: "#ef4444" },
  uncertain: { fill: "#dbeafe", stroke: "#3b82f6" },
};

type Scales = { x: (v: number) => number; y: (v: number) => number };
type Layout = {
  width: number;
  height: number;
  margin: typeof defaultMargin;
  plot: { w: number; h: number };
};
const defaultMargin = { top: 22, right: 12, bottom: 22, left: 12 };

/** Create a small distribution plot showing histogram with CI shading */
export function createDistributionPlot(
  histogram: HistogramBin[],
  ci: [number, number],
  pointEstimate: number,
  options: DistributionPlotOptions = {},
): SVGSVGElement {
  const opts = { ...defaultOpts, ...options };
  const layout = buildLayout(opts.width, opts.height);
  const svg = createSvg(layout.width, layout.height);
  if (!histogram?.length) return svg;

  const { fill, stroke } = colors[opts.direction];
  const scales = buildScales(histogram, ci, layout);

  drawTitle(svg, opts.title, layout.margin.left);
  drawCIRegion(svg, ci, scales, layout, fill);
  opts.smooth
    ? drawSmoothedDist(svg, histogram, scales, stroke)
    : drawHistogramBars(svg, histogram, scales, layout, stroke);
  drawZeroLine(svg, scales, layout);
  drawPointEstimate(svg, pointEstimate, scales, layout, stroke);
  drawCILabels(svg, ci, scales, layout.height);
  return svg;
}

/** Convenience wrapper for ComparisonCI data */
export function createCIPlot(
  ci: ComparisonCI,
  options: Partial<DistributionPlotOptions> = {},
): SVGSVGElement {
  if (!ci.histogram) return createSvg(0, 0);
  return createDistributionPlot(ci.histogram, ci.ci, ci.percent, {
    direction: ci.direction,
    ...options,
  });
}

function buildLayout(width: number, height: number): Layout {
  const margin = defaultMargin;
  const w = width - margin.left - margin.right;
  const h = height - margin.top - margin.bottom;
  return { width, height, margin, plot: { w, h } };
}

/** Compute x/y scale functions mapping data values to SVG coordinates */
function buildScales(
  histogram: HistogramBin[],
  ci: [number, number],
  layout: Layout,
): Scales {
  const { margin, plot } = layout;
  const xMin = Math.min(...histogram.map(b => b.x), ci[0], 0);
  const xMax = Math.max(...histogram.map(b => b.x), ci[1], 0);
  const yMax = Math.max(...histogram.map(b => b.count));
  return {
    x: (v: number) => margin.left + ((v - xMin) / (xMax - xMin)) * plot.w,
    y: (v: number) => margin.top + plot.h - (v / yMax) * plot.h,
  };
}

function drawTitle(svg: SVGSVGElement, title: string, x: number): void {
  svg.appendChild(text(x, 14, title, "start", "13", "#333", "600"));
}

function drawCIRegion(
  svg: SVGSVGElement,
  ci: [number, number],
  scales: Scales,
  layout: Layout,
  fill: string,
) {
  const x = scales.x(ci[0]);
  const w = scales.x(ci[1]) - x;
  svg.appendChild(
    rect(x, layout.margin.top, w, layout.plot.h, { fill, opacity: "0.5" }),
  );
}

function drawSmoothedDist(
  svg: SVGSVGElement,
  histogram: HistogramBin[],
  scales: Scales,
  stroke: string,
): void {
  const sorted = [...histogram].sort((a, b) => a.x - b.x);
  const smoothed = gaussianSmooth(sorted, 2);
  const pts = smoothed.map(b => `${scales.x(b.x)},${scales.y(b.count)}`);
  const baseline = scales.y(0);
  svg.appendChild(
    path(
      `M${scales.x(smoothed[0].x)},${baseline}L${pts.join("L")}L${scales.x(smoothed.at(-1)!.x)},${baseline}Z`,
      { fill: stroke, opacity: "0.3" },
    ),
  );
  svg.appendChild(
    path(`M${pts.join("L")}`, { stroke, fill: "none", strokeWidth: "1.5" }),
  );
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
  const yMax = Math.max(...histogram.map(b => b.count));
  const xRange = scales.x(sorted.at(-1)!.x) - scales.x(sorted[0].x) + binW;
  for (const bin of sorted) {
    const barW = (binW / xRange) * layout.plot.w * 0.9;
    const barH = (bin.count / yMax) * layout.plot.h;
    svg.appendChild(
      rect(
        scales.x(bin.x) - barW / 2,
        layout.margin.top + layout.plot.h - barH,
        barW,
        barH,
        { fill: stroke, opacity: "0.6" },
      ),
    );
  }
}

function drawZeroLine(svg: SVGSVGElement, scales: Scales, layout: Layout) {
  const zeroX = scales.x(0);
  if (zeroX < layout.margin.left || zeroX > layout.width - layout.margin.right)
    return;
  const top = layout.margin.top;
  const attrs = { stroke: "#666", strokeWidth: "1", strokeDasharray: "3,2" };
  svg.appendChild(line(zeroX, top, zeroX, top + layout.plot.h, attrs));
}

function drawPointEstimate(
  svg: SVGSVGElement,
  pt: number,
  scales: Scales,
  layout: Layout,
  stroke: string,
) {
  const x = scales.x(pt);
  const top = layout.margin.top;
  svg.appendChild(
    line(x, top, x, top + layout.plot.h, { stroke, strokeWidth: "2" }),
  );
}

function drawCILabels(
  svg: SVGSVGElement,
  ci: [number, number],
  scales: Scales,
  height: number,
): void {
  svg.appendChild(
    text(scales.x(ci[0]), height - 4, formatPct(ci[0]), "middle", "12"),
  );
  svg.appendChild(
    text(scales.x(ci[1]), height - 4, formatPct(ci[1]), "middle", "12"),
  );
}

/** Apply gaussian kernel smoothing to histogram bins */
function gaussianSmooth(bins: HistogramBin[], sigma: number): HistogramBin[] {
  return bins.map((bin, i) => {
    let sum = 0;
    let wt = 0;
    for (let j = 0; j < bins.length; j++) {
      const w = Math.exp(-((i - j) ** 2) / (2 * sigma ** 2));
      sum += bins[j].count * w;
      wt += w;
    }
    return { x: bin.x, count: sum / wt };
  });
}

const formatPct = (v: number) => (v >= 0 ? "+" : "") + v.toFixed(0) + "%";

function createSvg(w: number, h: number): SVGSVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("width", String(w));
  svg.setAttribute("height", String(h));
  if (w && h) svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
  return svg;
}

function rect(
  x: number,
  y: number,
  w: number,
  h: number,
  attrs: Record<string, string>,
): SVGRectElement {
  const el = document.createElementNS("http://www.w3.org/2000/svg", "rect");
  el.setAttribute("x", String(x));
  el.setAttribute("y", String(y));
  el.setAttribute("width", String(w));
  el.setAttribute("height", String(h));
  setAttrs(el, attrs);
  return el;
}

function path(d: string, attrs: Record<string, string>): SVGPathElement {
  const el = document.createElementNS("http://www.w3.org/2000/svg", "path");
  el.setAttribute("d", d);
  setAttrs(el, attrs);
  return el;
}

function line(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  attrs: Record<string, string>,
): SVGLineElement {
  const el = document.createElementNS("http://www.w3.org/2000/svg", "line");
  el.setAttribute("x1", String(x1));
  el.setAttribute("y1", String(y1));
  el.setAttribute("x2", String(x2));
  el.setAttribute("y2", String(y2));
  setAttrs(el, attrs);
  return el;
}

function text(
  x: number,
  y: number,
  content: string,
  anchor = "start",
  size = "9",
  fill = "#666",
  weight = "400",
): SVGTextElement {
  const el = document.createElementNS("http://www.w3.org/2000/svg", "text");
  el.setAttribute("x", String(x));
  el.setAttribute("y", String(y));
  el.setAttribute("text-anchor", anchor);
  el.setAttribute("font-size", size);
  el.setAttribute("font-weight", weight);
  el.setAttribute("fill", fill);
  el.textContent = content;
  return el;
}

/** Set SVG attributes, converting camelCase keys to kebab-case */
function setAttrs(el: SVGElement, attrs: Record<string, string>): void {
  for (const [k, v] of Object.entries(attrs))
    el.setAttribute(
      k.replace(/[A-Z]/g, c => "-" + c.toLowerCase()),
      v,
    );
}
