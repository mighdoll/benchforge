import { formatSignedPercent } from "../../report/Formatters.ts";
import type { DistributionPlotOptions, Layout, Scales } from "./CIPlot.ts";
import { text } from "./SvgHelpers.ts";

export function drawTitles(
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

export function drawCILabels(
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
