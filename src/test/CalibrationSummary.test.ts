import { expect, test } from "vitest";
import { summarizeCalibration } from "../stats/CalibrationSummary.ts";

test("well-calibrated: scatter within CI, margin from the CI half-width", () => {
  // Tight scatter (within +/-0.2%) vs a wider within-run CI of 0.5%.
  const points = [0.1, -0.1, 0.15, -0.05, 0.0];
  const halfWidths = [0.5, 0.5, 0.5, 0.5, 0.5];
  const s = summarizeCalibration(points, halfWidths);
  expect(s.overconfident).toBe(false);
  expect(s.meanPoint).toBeCloseTo(0.02, 6);
  // margin = CI half-width (0.5), an exact multiple that must not round up.
  expect(s.suggestedMargin).toBeCloseTo(0.5, 6);
});

test("overconfident: scatter exceeds CI, margin from the scatter", () => {
  // Wide run-to-run scatter (up to +/-0.9%) but an optimistic CI of 0.3%.
  const points = [0.9, -0.8, 0.7, -0.6, 0.85];
  const halfWidths = [0.3, 0.3, 0.3, 0.3, 0.3];
  const s = summarizeCalibration(points, halfWidths);
  expect(s.overconfident).toBe(true);
  // margin comes from the scatter (p95 = 0.9%), not the within-run CI (0.3%).
  expect(s.suggestedMargin).toBeCloseTo(0.9, 6);
});
