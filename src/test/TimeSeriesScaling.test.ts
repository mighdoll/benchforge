import { expect, test } from "vitest";
import type { HeapPoint } from "../viewer/plots/PlotTypes.ts";
import {
  computeHeapScale,
  plotDomains,
} from "../viewer/plots/TimeSeriesScaling.ts";

function heapPoint(iteration: number, value: number): HeapPoint {
  return { benchmark: "a", iteration, value };
}

test("computeHeapScale honors the fill fraction", () => {
  const heap = [heapPoint(0, 100), heapPoint(1, 300)];
  const quarter = computeHeapScale(heap, 0, 10)!;
  const most = computeHeapScale(heap, 0, 10, 0.85)!;
  expect(quarter.scale).toBeCloseTo((10 * 0.25) / 200);
  expect(most.scale).toBeCloseTo((10 * 0.85) / 200);
  expect(most.heapMinBytes).toBe(quarter.heapMinBytes);
  expect(most.heapRangeBytes).toBe(quarter.heapRangeBytes);
});

test("plotDomains derives finite domains from samples", () => {
  const d = plotDomains([0, 1, 2], [5, 7, 6], []);
  expect(d.xMin).toBe(0);
  expect(d.xMax).toBe(2);
  expect(Number.isFinite(d.yMin)).toBe(true);
  expect(Number.isFinite(d.yMax)).toBe(true);
  expect(d.yMax).toBeGreaterThan(d.yMin);
  expect(d.yMax).toBeGreaterThanOrEqual(7);
});

test("plotDomains falls back to heap positions when no samples", () => {
  const d = plotDomains([], [], [3, 10, 42]);
  expect(d.xMin).toBe(3);
  expect(d.xMax).toBe(42);
  expect(d.yMin).toBe(0);
  expect(d.yMax).toBe(1);
});

test("plotDomains pads a degenerate x extent", () => {
  const d = plotDomains([], [], [5]);
  expect(d.xMin).toBe(4.5);
  expect(d.xMax).toBe(5.5);
});

test("plotDomains returns a unit box when everything is empty", () => {
  const d = plotDomains([], [], []);
  expect(d).toEqual({ xMin: 0, xMax: 1, yMin: 0, yMax: 1 });
});
