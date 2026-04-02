import type {
  DifferenceCI,
  HistogramBin,
} from "../../stats/StatisticalUtils.ts";
import { formatPct } from "./PlotTypes.ts";

export interface DistributionPlotOptions {
  width?: number;
  height?: number;
  title?: string;
  smooth?: boolean;
  direction?: "faster" | "slower" | "uncertain";
  /** Pre-formatted CI bound labels (overrides default formatPct) */
  ciLabels?: [string, string];
}

type Scales = { x: (v: number) => number; y: (v: number) => number };
type Layout = {
  width: number;
  height: number;
  margin: typeof defaultMargin;
  plot: { w: number; h: number };
};
const defaultMargin = { top: 22, right: 12, bottom: 22, left: 12 };

const svgNS = "http://www.w3.org/2000/svg";

const defaultOpts = {
  width: 260,
  height: 85,
  title: "p50 Δ%",
  smooth: false,
  direction: "uncertain" as const,
};

const colors = {
  faster: { fill: "#dcfce7", stroke: "#22c55e" },
  slower: { fill: "#fee2e2", stroke: "#ef4444" },
  uncertain: { fill: "#dbeafe", stroke: "#3b82f6" },
};

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
  const { margin, plot } = layout;
  const add = (el: SVGElement) => svg.appendChild(el);

  if (opts.title)
    add(text(margin.left, 14, opts.title, "start", "13", "#333", "600"));
  const ciX = scales.x(ci[0]);
  const ciW = scales.x(ci[1]) - ciX;
  add(rect(ciX, margin.top, ciW, plot.h, { fill, opacity: "0.5" }));
  if (opts.smooth) drawSmoothedDist(svg, histogram, scales, stroke);
  else drawHistogramBars(svg, histogram, scales, layout, stroke);
  const zeroX = scales.x(0);
  const inRange = zeroX >= margin.left && zeroX <= layout.width - margin.right;
  if (inRange) {
    const zeroAttrs = {
      stroke: "#666",
      strokeWidth: "1",
      strokeDasharray: "3,2",
    };
    add(line(zeroX, margin.top, zeroX, margin.top + plot.h, zeroAttrs));
  }
  const ptX = scales.x(pointEstimate);
  add(
    line(ptX, margin.top, ptX, margin.top + plot.h, {
      stroke,
      strokeWidth: "2",
    }),
  );
  if (layout.margin.bottom >= 15) {
    const labelY = layout.height - 4;
    const loLabel = opts.ciLabels?.[0] ?? formatPct(ci[0], 0);
    const hiLabel = opts.ciLabels?.[1] ?? formatPct(ci[1], 0);
    const loX = scales.x(ci[0]);
    const hiX = scales.x(ci[1]);
    const estCharW = 6;
    const loW = loLabel.length * estCharW;
    const hiW = hiLabel.length * estCharW;
    const gap = hiX - loX;
    if (gap >= (loW + hiW) / 2 + 4) {
      add(text(loX, labelY, loLabel, "middle", "11"));
      add(text(hiX, labelY, hiLabel, "middle", "11"));
    } else {
      // Push labels to left/right edges to avoid overlap
      const loEdge = Math.max(margin.left + loW / 2, loX);
      const hiEdge = Math.min(layout.width - margin.right - hiW / 2, hiX);
      add(text(loEdge, labelY, loLabel, "end", "11"));
      add(text(hiEdge, labelY, hiLabel, "start", "11"));
    }
  }
  return svg;
}

/** Convenience wrapper for DifferenceCI data */
export function createCIPlot(
  ci: DifferenceCI,
  options: Partial<DistributionPlotOptions> = {},
): SVGSVGElement {
  if (!ci.histogram) return createSvg(0, 0);
  return createDistributionPlot(ci.histogram, ci.ci, ci.percent, {
    direction: ci.direction,
    ...options,
  });
}

/** Compute plot layout dimensions, scaling margins for compact sizes */
function buildLayout(width: number, height: number): Layout {
  const compact = height < defaultMargin.top + defaultMargin.bottom + 10;
  const margin = compact
    ? { top: 4, right: 6, bottom: 4, left: 6 }
    : defaultMargin;
  const w = width - margin.left - margin.right;
  const h = height - margin.top - margin.bottom;
  return { width, height, margin, plot: { w, h } };
}

function createSvg(w: number, h: number): SVGSVGElement {
  const svg = document.createElementNS(svgNS, "svg");
  svg.setAttribute("width", String(w));
  svg.setAttribute("height", String(h));
  if (w && h) svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
  return svg;
}

/** Compute x/y scale functions mapping data values to SVG coordinates */
function buildScales(
  histogram: HistogramBin[],
  ci: [number, number],
  layout: Layout,
): Scales {
  const { margin, plot } = layout;
  const xs = histogram.map(b => b.x);
  const xMin = Math.min(...xs, ci[0], 0);
  const xMax = Math.max(...xs, ci[1], 0);
  const yMax = Math.max(...histogram.map(b => b.count));
  return {
    x: (v: number) => margin.left + ((v - xMin) / (xMax - xMin)) * plot.w,
    y: (v: number) => margin.top + plot.h - (v / yMax) * plot.h,
  };
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
  const el = document.createElementNS(svgNS, "text");
  el.setAttribute("x", String(x));
  el.setAttribute("y", String(y));
  el.setAttribute("text-anchor", anchor);
  el.setAttribute("font-size", size);
  el.setAttribute("font-weight", weight);
  el.setAttribute("fill", fill);
  el.textContent = content;
  return el;
}

function rect(
  x: number,
  y: number,
  w: number,
  h: number,
  attrs: Record<string, string>,
): SVGRectElement {
  const el = document.createElementNS(svgNS, "rect");
  el.setAttribute("x", String(x));
  el.setAttribute("y", String(y));
  el.setAttribute("width", String(w));
  el.setAttribute("height", String(h));
  setAttrs(el, attrs);
  return el;
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

/** Draw individual histogram bars centered on each bin position */
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
  const barW = (binW / xRange) * layout.plot.w * 0.9;
  const base = layout.margin.top + layout.plot.h;
  const attrs = { fill: stroke, opacity: "0.6" };
  for (const bin of sorted) {
    const barH = (bin.count / yMax) * layout.plot.h;
    const x = scales.x(bin.x) - barW / 2;
    svg.appendChild(rect(x, base - barH, barW, barH, attrs));
  }
}

function line(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  attrs: Record<string, string>,
): SVGLineElement {
  const el = document.createElementNS(svgNS, "line");
  el.setAttribute("x1", String(x1));
  el.setAttribute("y1", String(y1));
  el.setAttribute("x2", String(x2));
  el.setAttribute("y2", String(y2));
  setAttrs(el, attrs);
  return el;
}

/** Set SVG attributes, converting camelCase keys to kebab-case */
function setAttrs(el: SVGElement, attrs: Record<string, string>): void {
  const kebab = (k: string) => k.replace(/[A-Z]/g, c => "-" + c.toLowerCase());
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(kebab(k), v);
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

function path(d: string, attrs: Record<string, string>): SVGPathElement {
  const el = document.createElementNS(svgNS, "path");
  el.setAttribute("d", d);
  setAttrs(el, attrs);
  return el;
}
