import { expect, test } from "vitest";
import { summarizeCalibration } from "../stats/CalibrationSummary.ts";

test("mean point estimate is the average of per-run deltas", () => {
  const points = [0.1, -0.2, 0.3, -0.1, 0.0];
  const halfWidths = [0.4, 0.4, 0.4, 0.4, 0.4];
  const s = summarizeCalibration(points, halfWidths);
  expect(s.meanPoint).toBeCloseTo(0.02, 6);
});

test("well-calibrated: scatter within CI, margin from CI half-width", () => {
  // Tight scatter (all within +/-0.2%) vs wider within-run CI of 0.5%.
  const points = [0.1, -0.1, 0.15, -0.05, 0.0];
  const halfWidths = [0.5, 0.5, 0.5, 0.5, 0.5];
  const s = summarizeCalibration(points, halfWidths);
  expect(s.overconfident).toBe(false);
  expect(s.meanCiHalfWidth).toBeCloseTo(0.5, 6);
  // suggested margin driven by the CI half-width (0.5), rounded to 0.5.
  expect(s.suggestedMargin).toBeCloseTo(0.5, 6);
});

test("overconfident: scatter exceeds CI, margin from scatter", () => {
  // Wide run-to-run scatter (up to +/-0.9%) but optimistic within-run CI 0.3%.
  const points = [0.9, -0.8, 0.7, -0.6, 0.85];
  const halfWidths = [0.3, 0.3, 0.3, 0.3, 0.3];
  const s = summarizeCalibration(points, halfWidths);
  expect(s.overconfident).toBe(true);
  expect(s.scatterP95).toBeGreaterThan(s.meanCiHalfWidth);
  // margin comes from the scatter (>0.3%), not the within-run CI.
  expect(s.suggestedMargin).toBeGreaterThan(0.3);
});

test("margin rounds up to a tidy step", () => {
  const points = [0.0, 0.0, 0.0, 0.0, 0.0];
  const halfWidths = [0.42, 0.42, 0.42, 0.42, 0.42];
  const s = summarizeCalibration(points, halfWidths);
  // 0.42 rounds up to 0.5 (nearest 0.1 step below 1%).
  expect(s.suggestedMargin).toBeCloseTo(0.5, 6);
});
