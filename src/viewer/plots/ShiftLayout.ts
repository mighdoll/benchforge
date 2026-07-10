import { median } from "../../stats/CoreStats.ts";
import type { ShiftPercentile } from "../ReportData.ts";

/** Maps a diff-percent value to a vertical pixel position. */
export type Scale = (v: number) => number;

export const margin = { top: 14, right: 16, bottom: 34, left: 44 };

const maxCiWidthRatio = 3;

/** Points that set the vertical scale: reliable points whose CI is in line
 *  with their peers'. Unreliable percentiles (sparse tails) and wide-CI
 *  outliers (see wideCiPoints) would stretch the axis and crush the
 *  informative percentiles; their violins clip at the plot edge instead.
 *  Falls back to all reliable points, then all points, so the scale never
 *  collapses. */
export function scalePoints(points: ShiftPercentile[]): ShiftPercentile[] {
  const reliable = points.filter(p => p.reliable);
  const candidates = reliable.length ? reliable : points;
  const wide = wideCiPoints(points);
  const bounded = candidates.filter(p => !wide.has(p));
  return bounded.length ? bounded : candidates;
}

/** Points whose CI is far wider than their peers' (more than maxCiWidthRatio
 *  times the median width of the reliable points). However it leans, such a
 *  percentile's magnitude is too fuzzy to earn axis room, so it never keys the
 *  y-axis; the violin clips at the plot edge with a caption instead. When
 *  every CI is similarly wide the median grows with them and nothing is an
 *  outlier, so the axis still covers everything. */
export function wideCiPoints(points: ShiftPercentile[]): Set<ShiftPercentile> {
  const reliable = points.filter(p => p.reliable);
  const peers = reliable.length ? reliable : points;
  const medianWidth = median(peers.map(ciWidth));
  return new Set(
    points.filter(p => ciWidth(p) > maxCiWidthRatio * medianWidth),
  );
}

/** Width of a point's 95% CI in diff-percent. */
export function ciWidth(p: ShiftPercentile): number {
  return p.diff.ci[1] - p.diff.ci[0];
}

/** Slot centers across the plot. A leading mean point gets its own slot, set off
 *  from the percentiles by an extra half-slot gap with a divider line between.
 *  Shared by the diff and absolute shift plots (keyed only on isMean); the
 *  absolute plot passes a wider `left` to fit its value-domain axis labels. */
export function slotCenters(
  points: { isMean?: boolean }[],
  plotWidth: number,
  left: number = margin.left,
): { cx: number[]; slotWidth: number; dividerX: number | null } {
  const hasMean = points[0]?.isMean ?? false;
  // the gap before p1 costs one extra half-slot of width
  const slots = points.length + (hasMean ? 0.5 : 0);
  const slotWidth = plotWidth / slots;
  const gap = hasMean ? slotWidth * 0.5 : 0;
  const cx = points.map((_, i) => {
    const lead = i === 0 || !hasMean ? 0 : gap;
    return left + lead + slotWidth * (i + 0.5);
  });
  const dividerX = hasMean ? left + slotWidth + gap * 0.5 : null;
  return { cx, slotWidth, dividerX };
}
