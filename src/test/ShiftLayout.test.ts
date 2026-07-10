import { expect, test } from "vitest";
import type { CIDirection } from "../stats/Bootstrap.ts";
import { scalePoints, wideCiPoints } from "../viewer/plots/ShiftLayout.ts";
import type { ShiftPercentile } from "../viewer/ReportData.ts";

/** Minimal shift point: only the fields the scale logic reads. */
function point(
  label: string,
  ci: [number, number],
  opts: { reliable?: boolean; direction?: CIDirection } = {},
): ShiftPercentile {
  const { reliable = true, direction = "uncertain" } = opts;
  return {
    percentile: 0.5,
    label,
    diff: { percent: (ci[0] + ci[1]) / 2, ci, direction },
    runs: [],
    reliable,
    tailCount: 20,
    tailBatches: 8,
  };
}

test("a CI far wider than its peers' drops from the scale", () => {
  const p1 = point("p1", [-88, 2]);
  const rest = [
    point("p5", [-6, -2]),
    point("p25", [-5, -2]),
    point("p50", [-8, -5]),
    point("p95", [-9, -6]),
  ];
  const points = [p1, ...rest];
  expect([...wideCiPoints(points)]).toEqual([p1]);
  expect(scalePoints(points)).toEqual(rest);
});

test("a wide CI drops from the scale even when conclusive", () => {
  // it keeps its direction color in the viewer, but doesn't earn axis room
  const slower = point("p99", [-70, -15], { direction: "slower" });
  const rest = [
    point("p25", [-5, -2]),
    point("p50", [-8, -5]),
    point("p75", [-9, -6]),
  ];
  const points = [...rest, slower];
  expect(wideCiPoints(points).has(slower)).toBe(true);
  expect(scalePoints(points)).toEqual(rest);
});

test("similar CI widths produce no outliers", () => {
  const points = [
    point("p5", [-6, -2]),
    point("p50", [-8, -3]),
    point("p95", [-9, -2]),
  ];
  expect(wideCiPoints(points).size).toBe(0);
  expect(scalePoints(points)).toEqual(points);
});

test("when every CI is wide, nothing is an outlier and all key the scale", () => {
  const points = [
    point("p5", [-50, 10]),
    point("p50", [-60, 20]),
    point("p95", [-45, 30]),
  ];
  expect(wideCiPoints(points).size).toBe(0);
  expect(scalePoints(points)).toEqual(points);
});

test("unreliable points don't key the scale even with narrow CIs", () => {
  const weak = point("p1", [-4, -1], { reliable: false });
  const ok = point("p50", [-5, -2]);
  expect(scalePoints([weak, ok])).toEqual([ok]);
});

test("all-unreliable falls back to all points", () => {
  const points = [
    point("p1", [-4, -1], { reliable: false }),
    point("p50", [-5, -2], { reliable: false }),
  ];
  expect(scalePoints(points)).toEqual(points);
});

test("median width comes from reliable peers, not unreliable tails", () => {
  // huge unreliable tails must not inflate the median and mask a wide outlier
  const wide = point("p99", [-40, 40]);
  const weakTails = [
    point("p0.1", [-90, 60], { reliable: false }),
    point("p1", [-80, 50], { reliable: false }),
  ];
  const tight = [
    point("p25", [-3, 0]),
    point("p50", [-4, -1]),
    point("p75", [-3, 0]),
  ];
  const points = [...weakTails, wide, ...tight];
  expect(wideCiPoints(points).has(wide)).toBe(true);
  expect(scalePoints(points)).toEqual(tight);
});
