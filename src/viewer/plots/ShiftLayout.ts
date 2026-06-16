import type { ShiftPercentile } from "../ReportData.ts";

/** Maps a diff-percent value to a vertical pixel position. */
export type Scale = (v: number) => number;

export const margin = { top: 14, right: 16, bottom: 34, left: 44 };

/** Points that set the vertical scale: reliable ones only, so a sparse,
 *  unreliable tail percentile (huge noisy CI) can't dominate the axis and crush
 *  the informative percentiles. Falls back to all points when none are reliable,
 *  so the scale never collapses. */
export function scalePoints(points: ShiftPercentile[]): ShiftPercentile[] {
  const reliable = points.filter(p => p.reliable);
  return reliable.length ? reliable : points;
}
