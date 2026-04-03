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
  direction?: "faster" | "slower" | "uncertain" | "equivalent";
  /** Pre-formatted CI bound labels (overrides default formatPct) */
  ciLabels?: [string, string];
  /** Include zero in x scale (default true, set false for absolute-value plots) */
  includeZero?: boolean;
  /** Centered label above chart (e.g., the formatted point estimate) */
  pointLabel?: string;
  /** Equivalence margin in percent (draws shaded band at +/- margin) */
  equivMargin?: number;
}

type Scales = { x: (v: number) => number; y: (v: number) => number };
type Layout = {
  width: number;
  height: number;
  margin: { top: number; right: number; bottom: number; left: number };
  plot: { w: number; h: number };
};
const defaultMargin = { top: 22, right: 12, bottom: 22, left: 12 };

const svgNS = "http://www.w3.org/2000/svg";

const defaultOpts = {
  width: 260,
  height: 85,
  title: "Δ%",
  smooth: true,
  direction: "uncertain" as const,
  includeZero: true,
};

const colors = {
  faster: { fill: "#bbf7d0", stroke: "#22c55e" },
  slower: { fill: "#fee2e2", stroke: "#ef4444" },
  uncertain: { fill: "#dbeafe", stroke: "#3b82f6" },
  equivalent: { fill: "#dcfce7", stroke: "#86efac" },
};

/** Create a small distribution plot showing histogram with CI shading */
export function createDistributionPlot(
  histogram: HistogramBin[],
  ci: [number, number],
  pointEstimate: number,
  options: DistributionPlotOptions = {},
): SVGSVGElement {
  const opts = { ...defaultOpts, ...options };
  const layout = buildLayout(opts.width, opts.height, !!opts.pointLabel);
  const svg = createSvg(layout.width, layout.height);
  if (!histogram?.length) return svg;

  const { fill, stroke } = colors[opts.direction];
  const scales = buildScales(
    histogram,
    ci,
    layout,
    opts.includeZero,
    opts.equivMargin,
  );
  const { margin, plot } = layout;

  drawTitles(svg, opts, margin, scales.x(pointEstimate));

  if (opts.equivMargin && opts.includeZero)
    drawMarginZone(svg, opts.equivMargin, scales, layout);

  const ciX = scales.x(ci[0]);
  const ciW = scales.x(ci[1]) - ciX;
  const ciRect = rect(ciX, margin.top, ciW, plot.h, { fill });
  const strength = opts.includeZero ? "ci-region-strong" : "ci-region";
  ciRect.classList.add(strength, `ci-${opts.direction}`);
  svg.appendChild(ciRect);

  if (opts.smooth) drawSmoothedDist(svg, histogram, scales, stroke);
  else drawHistogramBars(svg, histogram, scales, layout, stroke);

  drawReferenceLine(svg, scales, layout, opts.includeZero);

  const ptX = scales.x(pointEstimate);
  svg.appendChild(
    line(ptX, margin.top, ptX, margin.top + plot.h, {
      stroke,
      strokeWidth: "2",
    }),
  );

  drawCILabels(svg, ci, scales, layout, opts);
  return svg;
}

/** Draw title and point label text above the chart */
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

/** Draw equivalence margin zone: shaded band + dashed boundary lines */
function drawMarginZone(
  svg: SVGSVGElement,
  equivMargin: number,
  scales: Scales,
  layout: Layout,
): void {
  const { margin, plot } = layout;
  const x1 = scales.x(-equivMargin);
  const x2 = scales.x(equivMargin);
  const bandH = plot.h / 3;
  const bandY = margin.top + (plot.h - bandH) / 2;
  const zone = rect(x1, bandY, x2 - x1, bandH, { fill: "currentColor" });
  zone.classList.add("margin-zone");
  svg.appendChild(zone);
  const attrs = {
    stroke: "currentColor",
    strokeWidth: "1",
    strokeDasharray: "3,3",
  };
  for (const x of [x1, x2]) {
    const l = line(x, margin.top, x, margin.top + plot.h, attrs);
    l.classList.add("margin-line");
    svg.appendChild(l);
  }
}

/** Draw zero reference line extending past plot area (comparison CIs only) */
function drawReferenceLine(
  svg: SVGSVGElement,
  scales: Scales,
  layout: Layout,
  includeZero: boolean,
): void {
  if (!includeZero) return;
  const zeroX = scales.x(0);
  const { margin, plot } = layout;
  if (zeroX < margin.left || zeroX > layout.width - margin.right) return;

  const attrs = { stroke: "#000", strokeWidth: "1" };
  svg.appendChild(
    line(zeroX, margin.top - 4, zeroX, margin.top + plot.h + 4, attrs),
  );
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
    ...options,
  });
}

/** Compute plot layout dimensions, scaling margins for compact sizes */
function buildLayout(
  width: number,
  height: number,
  hasPointLabel?: boolean,
): Layout {
  const compact = height < defaultMargin.top + defaultMargin.bottom + 10;
  const margin = compact
    ? { top: 4, right: 6, bottom: 4, left: 6 }
    : { ...defaultMargin, top: hasPointLabel ? 30 : defaultMargin.top };
  const plot = {
    w: width - margin.left - margin.right,
    h: height - margin.top - margin.bottom,
  };
  return { width, height, margin, plot };
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
  includeZero: boolean,
  equivMargin?: number,
): Scales {
  const { margin, plot } = layout;
  const xs = histogram.map(b => b.x);
  const extra = includeZero ? [0] : [];
  const marginBounds = equivMargin ? [-equivMargin, equivMargin] : [];
  const xMin = Math.min(...xs, ci[0], ...extra, ...marginBounds);
  const xMax = Math.max(...xs, ci[1], ...extra, ...marginBounds);
  const yMax = Math.max(...histogram.map(b => b.count));
  const xRange = xMax - xMin || 1;
  return {
    x: (v: number) => margin.left + ((v - xMin) / xRange) * plot.w,
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

/** Draw CI bound labels below the plot */
function drawCILabels(
  svg: SVGSVGElement,
  ci: [number, number],
  scales: Scales,
  layout: Layout,
  opts: DistributionPlotOptions & { includeZero: boolean },
): void {
  if (layout.margin.bottom < 15) return;
  const labelY = layout.height - 4;
  const loLabel = opts.ciLabels?.[0] ?? formatPct(ci[0], 0);
  const hiLabel = opts.ciLabels?.[1] ?? formatPct(ci[1], 0);
  const loX = scales.x(ci[0]);
  const hiX = scales.x(ci[1]);
  const minGap = Math.max(loLabel.length, hiLabel.length) * 6;
  if (!opts.includeZero || hiX - loX >= minGap) {
    svg.appendChild(text(loX, labelY, loLabel, "middle", "11"));
    svg.appendChild(text(hiX, labelY, hiLabel, "middle", "11"));
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

const toKebab = (k: string) => k.replace(/[A-Z]/g, c => "-" + c.toLowerCase());

/** Set SVG attributes, converting camelCase keys to kebab-case */
function setAttrs(el: SVGElement, attrs: Record<string, string>): void {
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(toKebab(k), v);
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
