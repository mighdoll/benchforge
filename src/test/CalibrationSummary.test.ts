import { expect, test } from "vitest";
import { runCalibration } from "../runners/Calibration.ts";
import type { MeasuredResults } from "../runners/MeasuredResults.ts";
import { computeStats } from "../runners/SampleStats.ts";
import { summarizeCalibration } from "../stats/CalibrationSummary.ts";
import { standardDeviation } from "../stats/CoreStats.ts";

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
  // Wide run-to-run scatter (std ~0.84%, so a 1.96-std band of ~1.64%) but an
  // optimistic CI of 0.3%.
  const points = [0.9, -0.8, 0.7, -0.6, 0.85];
  const halfWidths = [0.3, 0.3, 0.3, 0.3, 0.3];
  const s = summarizeCalibration(points, halfWidths);
  expect(s.overconfident).toBe(true);
  // margin = |mean| + 1.96*std (~1.85%), rounded up to 2%, not the CI (0.3%).
  expect(s.suggestedMargin).toBeCloseTo(2.0, 6);
});

test("scatter band reflects the whole distribution, not just the worst run", () => {
  // Same maximum |delta| (1.0%) in both samples, but very different spread.
  const oneSpike = [1.0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
  const allWide = [1.0, -1.0, 0.9, -0.9, 1.0, -1.0, 0.95, -0.95, 1.0, -1.0];
  const flat = oneSpike.map(() => 0.3);
  const spike = summarizeCalibration(oneSpike, flat);
  const wide = summarizeCalibration(allWide, flat);
  // The old max-based estimator returned 1.0 for both (blind to spread). The
  // parametric band tracks std, so the tight-but-spiky sample reads far
  // narrower than the genuinely wide one.
  expect(spike.scatterHalfWidth).toBeLessThan(wide.scatterHalfWidth / 2);
  // Pin the z95 * std formula against an independently computed std, not
  // spike.scatterStd (comparing two fields off the same result would only
  // check the function agrees with itself).
  expect(spike.scatterHalfWidth).toBeCloseTo(
    1.96 * standardDeviation(oneSpike),
    9,
  );
});

test("calibration uses paired batch comparison", async () => {
  // runCalibration calls current() twice per batch (baseline and current roles,
  // in alternating order); both see the same ramped value, so each paired A/A
  // delta is exactly 0.
  let call = 0;
  const current = async (): Promise<MeasuredResults> => {
    const round = Math.floor(call++ / 2);
    const samples = [100 + round * 50];
    return { name: "x", samples, time: computeStats(samples) };
  };

  const result = await runCalibration({
    current,
    batches: 24,
    runs: 1,
    warmupBatch: true,
  });
  expect(result.pointEstimates[0]).toBeCloseTo(0, 8);
  expect(result.ciHalfWidths[0]).toBeCloseTo(0, 8);
});
