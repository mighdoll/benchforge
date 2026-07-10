import { formatSignedPercent } from "../../report/Formatters.ts";
import { verdictWord } from "../../report/Verdict.ts";
import type { ShiftPercentile } from "../ReportData.ts";
import { directionColors, gaussianSmooth } from "./PlotTypes.ts";
import { ciWidth, margin, type Scale } from "./ShiftLayout.ts";
import { path, svgNS, text } from "./SvgHelpers.ts";

/** Options shared by {@link drawViolin} and {@link drawMarker}. */
export interface ShiftMarkOptions {
  yScale: Scale;
  wideCi: boolean;
  onSelect?: (point: ShiftPercentile) => void;
}

const weakColor = "#9ca3af";
// Untrusted points read as a lighter grey, paired with a dashed outline, so
// they stay distinct from the medium grey of a reliable-but-uncertain
// percentile (directionColors.uncertain shares weakColor).
const untrustedColor = "#cbd5e1";

/** A point earns its direction color unless its tail is too sparse
 *  (unreliable) or it is inconclusive with an outlier-wide CI (see
 *  wideCiPoints in ShiftLayout): then nothing about it is known. A conclusive
 *  point keeps its color however wide its CI: only the magnitude is fuzzy. */
const trusted = (p: ShiftPercentile, wideCi: boolean) =>
  p.reliable && !(wideCi && p.diff.direction === "uncertain");

/** Per-percentile stroke: direction color when trusted, light grey otherwise
 *  (paired with a dashed outline). */
const strokeFor = (p: ShiftPercentile, wideCi: boolean) =>
  trusted(p, wideCi)
    ? directionColors[p.diff.direction].stroke
    : untrustedColor;

/** A vertical violin: the smoothed diff distribution mirrored around cx. */
export function drawViolin(
  parent: SVGElement,
  point: ShiftPercentile,
  cx: number,
  halfMax: number,
  maxCount: number,
  options: ShiftMarkOptions,
): void {
  if (!point.diff.histogram?.length) return;
  const { yScale, wideCi, onSelect } = options;
  const stroke = strokeFor(point, wideCi);
  const outlinePath = violinPath(point, cx, halfMax, maxCount, yScale);

  const group = document.createElementNS(svgNS, "g");
  group.classList.add("shift-violin");
  if (!trusted(point, wideCi)) group.classList.add("shift-weak");
  group.appendChild(violinTitle(point, wideCi));
  if (onSelect) {
    group.style.cursor = "pointer";
    group.addEventListener("click", () => onSelect(point));
  }
  const body = path(outlinePath, { fill: stroke });
  body.classList.add("shift-violin-fill");
  group.appendChild(body);
  const outlineAttrs: Record<string, string> = {
    stroke,
    fill: "none",
    strokeWidth: "1.5",
  };
  if (!trusted(point, wideCi)) outlineAttrs.strokeDasharray = "3 2";
  group.appendChild(path(outlinePath, outlineAttrs));
  parent.appendChild(group);
}

/** Point-estimate marker: hollow circle, grey when untrusted. When the
 *  estimate sits past the axis range (points that don't key the y-axis), an
 *  arrowhead at the plot edge points off-scale instead; it takes over the
 *  violin's click target since the violin may be fully clipped. */
export function drawMarker(
  parent: SVGElement,
  point: ShiftPercentile,
  cx: number,
  plotHeight: number,
  options: ShiftMarkOptions,
): void {
  const { yScale, wideCi, onSelect } = options;
  const stroke = strokeFor(point, wideCi);
  const cy = yScale(point.diff.percent);
  const top = margin.top;
  const bottom = margin.top + plotHeight;
  if (cy < top || cy > bottom) {
    const down = cy > bottom;
    const edge = down ? bottom : top;
    const arrow = offScaleArrow(point, cx, edge, down, stroke, wideCi);
    if (onSelect) {
      arrow.style.cursor = "pointer";
      arrow.addEventListener("click", () => onSelect(point));
    }
    parent.appendChild(arrow);
    return;
  }
  const dot = document.createElementNS(svgNS, "circle");
  dot.setAttribute("cx", String(cx));
  dot.setAttribute("cy", String(cy));
  dot.setAttribute("r", "3");
  dot.setAttribute("fill", "#fff");
  dot.setAttribute("stroke", stroke);
  dot.setAttribute("stroke-width", "1.5");
  dot.style.pointerEvents = "none";
  parent.appendChild(dot);
}

/** Percentile label, with the verdict point enlarged and its Δ% value captioned
 *  below (the same number shown elsewhere as the headline delta), and a caption
 *  for percentiles whose violin can't speak for itself (see captionFor). */
export function drawPercentileLabel(
  svg: SVGSVGElement,
  point: ShiftPercentile,
  cx: number,
  height: number,
  wideCi: boolean,
): void {
  const color = labelColor(point, wideCi);
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
  if (point.isPrimary && trusted(point, wideCi)) {
    svg.appendChild(
      text(
        cx,
        height - margin.bottom + 29,
        formatSignedPercent(point.diff.percent),
        "middle",
        "11",
        directionColors[point.diff.direction].stroke,
        "700",
      ),
    );
    return;
  }
  const caption = captionFor(point, wideCi);
  if (caption)
    svg.appendChild(
      text(
        cx,
        height - margin.bottom + 28,
        caption.text,
        "middle",
        "9",
        caption.color,
      ),
    );
}

/** SVG path for a smoothed violin mirrored around cx (width encodes density). */
function violinPath(
  point: ShiftPercentile,
  cx: number,
  halfMax: number,
  maxCount: number,
  yScale: Scale,
): string {
  const sorted = [...point.diff.histogram!].sort((a, b) => a.x - b.x);
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
  return `M${rightEdge.join("L")}L${leftEdge.join("L")}Z`;
}

/** Native hover tooltip: verdict word + diff for a trusted percentile, or why
 *  the point can't be trusted (too few tail samples / CI too wide). */
function violinTitle(point: ShiftPercentile, wideCi: boolean): SVGTitleElement {
  const node = document.createElementNS(svgNS, "title");
  if (!point.reliable)
    node.textContent = `${point.label} - insufficient data (n=${point.tailCount})`;
  else if (!trusted(point, wideCi))
    node.textContent = `${point.label} - too noisy to bound (${ciHalfLabel(point)}); needs a longer run`;
  else
    node.textContent = `${point.label} - ${verdictWord(point.diff.direction)} - ${formatSignedPercent(point.diff.percent)}`;
  return node;
}

/** Small solid arrowhead at the plot edge pointing toward an off-scale point
 *  estimate; carries the violin tooltip (and, via drawMarker, its click
 *  target) since the violin may be fully clipped. */
function offScaleArrow(
  point: ShiftPercentile,
  cx: number,
  edge: number,
  down: boolean,
  fill: string,
  wideCi: boolean,
): SVGElement {
  const dir = down ? 1 : -1;
  const tipY = edge - dir * 2;
  const baseY = tipY - dir * 7;
  const d = `M${cx - 4},${baseY}L${cx + 4},${baseY}L${cx},${tipY}Z`;
  const arrow = path(d, { fill });
  arrow.appendChild(violinTitle(point, wideCi));
  return arrow;
}

/** Label color: dark for the primary mean, mid-grey when trusted, weak otherwise. */
function labelColor(point: ShiftPercentile, wideCi: boolean): string {
  if (point.isMean) return "#111827";
  return trusted(point, wideCi) ? "#374151" : weakColor;
}

/** Caption under a percentile label when its violin can't speak for itself:
 *  the tail count when unreliable, the CI half-width when inconclusive with a
 *  wide CI, or the off-scale Δ% when conclusive but too wide to key the axis
 *  (its marker may sit past the plot edge). Equivalent points never need one:
 *  the margin band always spans their CI. */
function captionFor(
  point: ShiftPercentile,
  wideCi: boolean,
): { text: string; color: string } | undefined {
  if (!point.reliable)
    return { text: `n=${point.tailCount}`, color: weakColor };
  if (!wideCi) return undefined;
  const { direction } = point.diff;
  if (direction === "uncertain")
    return { text: ciHalfLabel(point), color: weakColor };
  if (direction === "equivalent") return undefined;
  return {
    text: formatSignedPercent(point.diff.percent),
    color: directionColors[direction].stroke,
  };
}

/** Half the CI width, e.g. "±44%": how far the estimate could plausibly be off. */
function ciHalfLabel(point: ShiftPercentile): string {
  const half = ciWidth(point) / 2;
  return `±${half.toFixed(half >= 10 ? 0 : 1)}%`;
}
