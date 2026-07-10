import { expect, test } from "vitest";
import {
  type MetricSection,
  metricSection,
} from "../report/BenchmarkReport.ts";
import { displayDiffCI, displayMarginBand } from "../report/CiFormatting.ts";
import { timeMs } from "../report/Formatters.ts";
import type { DifferenceCI } from "../stats/Bootstrap.ts";

const locMetric: MetricSection = metricSection({
  title: "lines / sec",
  higherIsBetter: true,
  toDisplay: (ms: number) => 1000 / ms,
  formatter: timeMs,
});

const timeMetric: MetricSection = metricSection({
  title: "time",
  formatter: timeMs,
});

const flipMetric: MetricSection = metricSection({
  title: "ops / sec",
  higherIsBetter: true,
  formatter: timeMs,
});

/** A time-domain diff: current 71.2% faster than baseline. */
function fasterDiff(): DifferenceCI {
  return {
    percent: -71.2,
    ci: [-71.4, -70.8],
    direction: "faster",
    histogram: [
      { x: -71.4, count: 3 },
      { x: -71.2, count: 8 },
      { x: -70.8, count: 4 },
    ],
  };
}

/** Reciprocal display-percent of a time-percent delta (anchor cancels). */
function reciprocalPct(t: number): number {
  return (1 / (1 + t / 100) - 1) * 100;
}

test("reciprocal toDisplay maps a -71.2% time delta to ~+247% loc/sec", () => {
  const out = displayDiffCI(locMetric, fasterDiff(), 1);
  expect(out.percent).toBeCloseTo(247.2, 1);
});

test("the anchor cancels under a reciprocal transform", () => {
  const a1 = displayDiffCI(locMetric, fasterDiff(), 1);
  const a2 = displayDiffCI(locMetric, fasterDiff(), 4.13);
  expect(a2.percent).toBeCloseTo(a1.percent, 6);
  expect(a2.ci[0]).toBeCloseTo(a1.ci[0], 6);
  expect(a2.ci[1]).toBeCloseTo(a1.ci[1], 6);
});

test("CI endpoints are re-sorted after a decreasing transform", () => {
  const out = displayDiffCI(locMetric, fasterDiff(), 1);
  // time CI [-71.4, -70.8] ==> throughput [+242.5, +249.7] (order flips, sorted)
  expect(out.ci[0]).toBeLessThan(out.ci[1]);
  expect(out.ci[0]).toBeCloseTo(242.5, 0);
  expect(out.ci[1]).toBeCloseTo(249.7, 0);
});

test("histogram bins are transformed into the display domain", () => {
  const out = displayDiffCI(locMetric, fasterDiff(), 1);
  const xs = out.histogram!.map(b => b.x);
  expect(xs).toEqual(
    fasterDiff()
      .histogram!.map(b => b.x)
      .map(reciprocalPct),
  );
  // counts pass through untouched
  expect(out.histogram!.map(b => b.count)).toEqual([3, 8, 4]);
});

test("direction, trimmed, and ciLevel pass through untouched", () => {
  const diff: DifferenceCI = {
    ...fasterDiff(),
    trimmed: [1, 2],
    ciLevel: "block",
  };
  const out = displayDiffCI(locMetric, diff, 1);
  expect(out.direction).toBe("faster");
  expect(out.trimmed).toEqual([1, 2]);
  expect(out.ciLevel).toBe("block");
});

test("a time metric (no toDisplay) is identity", () => {
  const diff = fasterDiff();
  const out = displayDiffCI(timeMetric, diff, 1);
  expect(out.percent).toBe(-71.2);
  expect(out.ci).toEqual([-71.4, -70.8]);
});

test("no-toDisplay + higherIsBetter falls back to the sign flip", () => {
  const out = displayDiffCI(flipMetric, fasterDiff(), 1);
  expect(out.percent).toBe(71.2);
  expect(out.ci).toEqual([70.8, 71.4]);
  expect(out.histogram!.map(b => b.x)).toEqual([71.4, 71.2, 70.8]);
});

test("a degenerate anchor falls back rather than dividing by zero", () => {
  const linear = metricSection({
    title: "x2",
    higherIsBetter: true,
    toDisplay: (v: number) => v * 2,
    formatter: timeMs,
  });
  // toDisplay(0) == 0 ==> no usable transform, fall back to the flip.
  const out = displayDiffCI(linear, fasterDiff(), 0);
  expect(out.percent).toBe(71.2);
});

test("linear toDisplay preserves the percent delta", () => {
  const linear = metricSection({
    title: "x3",
    toDisplay: (v: number) => v * 3,
    formatter: timeMs,
  });
  const out = displayDiffCI(linear, fasterDiff(), 5);
  // c*x scaling leaves the percentage change unchanged.
  expect(out.percent).toBeCloseTo(-71.2, 6);
  expect(out.ci[0]).toBeCloseTo(-71.4, 6);
  expect(out.ci[1]).toBeCloseTo(-70.8, 6);
});

test("margin band is asymmetric and sorted under a reciprocal", () => {
  const band = displayMarginBand(locMetric, 5, 1);
  expect(band[0]).toBeLessThan(band[1]);
  // +/-5% time ==> [-4.76%, +5.26%] throughput
  expect(band[0]).toBeCloseTo(-4.762, 2);
  expect(band[1]).toBeCloseTo(5.263, 2);
});

test("margin band without a transform stays symmetric", () => {
  expect(displayMarginBand(timeMetric, 3, 1)).toEqual([-3, 3]);
  expect(displayMarginBand(flipMetric, 3, 1)).toEqual([-3, 3]);
});
