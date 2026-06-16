import { formatSignedPercent } from "../../report/Formatters.ts";
import type { ShiftPercentile } from "../ReportData.ts";
import { margin, type Scale, scalePoints } from "./ShiftLayout.ts";
import { ensureHatchPattern, line, rect, text } from "./SvgHelpers.ts";

/** Horizontal +/- equivalence band: diffs landing inside it are treated as
 *  practically equivalent, so it spans the full plot width as a reference zone. */
export function drawMarginBand(
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
export function drawZeroLine(
  svg: SVGSVGElement,
  yScale: Scale,
  width: number,
): void {
  const y = yScale(0);
  svg.appendChild(
    line(margin.left, y, width - margin.right, y, {
      stroke: "#000",
      strokeWidth: "1",
    }),
  );
}

/** y-axis ticks at a nice step across the diff-percent range. */
export function drawYAxis(
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
      text(
        margin.left - 7,
        y + 3.5,
        formatSignedPercent(tick, decimals),
        "end",
        "10",
      ),
    );
  }
}

/** Faint vertical divider separating the mean slot from the percentile slots. */
export function drawDivider(
  svg: SVGSVGElement,
  x: number,
  plotHeight: number,
): void {
  svg.appendChild(
    line(x, margin.top, x, margin.top + plotHeight, {
      stroke: "#e0e0e0",
      strokeWidth: "1",
    }),
  );
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
  for (const p of scalePoints(points)) {
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
