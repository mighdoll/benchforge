import { formatSignedPercent } from "../../report/Formatters.ts";
import { verdictWord } from "../../report/Verdict.ts";
import type { ShiftPercentile } from "../ReportData.ts";
import { directionColors, gaussianSmooth } from "./PlotTypes.ts";
import { margin, type Scale } from "./ShiftLayout.ts";
import { path, svgNS, text } from "./SvgHelpers.ts";

const weakColor = "#9ca3af";
// Unreliable (too few tail samples) reads as a lighter grey, paired with a
// dashed outline, so it stays distinct from the medium grey of a reliable-but-
// uncertain percentile (directionColors.uncertain shares weakColor).
const unreliableColor = "#cbd5e1";

/** Per-percentile stroke: direction color when reliable, light grey when there
 *  are too few tail samples to trust it (paired with a dashed outline). */
const strokeFor = (p: ShiftPercentile) =>
  p.reliable ? directionColors[p.diff.direction].stroke : unreliableColor;

/** A vertical violin: the smoothed diff distribution mirrored around cx. */
export function drawViolin(
  parent: SVGElement,
  point: ShiftPercentile,
  cx: number,
  halfMax: number,
  maxCount: number,
  yScale: Scale,
  onSelect?: (point: ShiftPercentile) => void,
): void {
  if (!point.diff.histogram?.length) return;
  const stroke = strokeFor(point);
  const outlinePath = violinPath(point, cx, halfMax, maxCount, yScale);

  const group = document.createElementNS(svgNS, "g");
  group.classList.add("shift-violin");
  if (!point.reliable) group.classList.add("shift-weak");
  group.appendChild(violinTitle(point));
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
  if (!point.reliable) outlineAttrs.strokeDasharray = "3 2";
  group.appendChild(path(outlinePath, outlineAttrs));
  parent.appendChild(group);
}

/** Point-estimate marker: hollow circle, grey when unreliable. */
export function drawMarker(
  parent: SVGElement,
  point: ShiftPercentile,
  cx: number,
  yScale: Scale,
): void {
  const stroke = strokeFor(point);
  const dot = document.createElementNS(svgNS, "circle");
  dot.setAttribute("cx", String(cx));
  dot.setAttribute("cy", String(yScale(point.diff.percent)));
  dot.setAttribute("r", "3");
  dot.setAttribute("fill", "#fff");
  dot.setAttribute("stroke", stroke);
  dot.setAttribute("stroke-width", "1.5");
  dot.style.pointerEvents = "none";
  parent.appendChild(dot);
}

/** Percentile label, with the verdict point enlarged and its Δ% value captioned
 *  below (the same number shown elsewhere as the headline delta), and a
 *  tail-count caption for unreliable percentiles. */
export function drawPercentileLabel(
  svg: SVGSVGElement,
  point: ShiftPercentile,
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
  if (point.isPrimary && point.reliable)
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

/** Native hover tooltip: verdict word + diff for a reliable percentile, or the
 *  tail-sample count when there is too little data to trust it. */
function violinTitle(point: ShiftPercentile): SVGTitleElement {
  const node = document.createElementNS(svgNS, "title");
  node.textContent = point.reliable
    ? `${point.label} - ${verdictWord(point.diff.direction)} - ${formatSignedPercent(point.diff.percent)}`
    : `${point.label} - insufficient data (n=${point.tailCount})`;
  return node;
}

/** Label color: dark for the primary mean, mid-grey when reliable, weak otherwise. */
function labelColor(point: ShiftPercentile): string {
  if (point.isMean) return "#111827";
  return point.reliable ? "#374151" : weakColor;
}
