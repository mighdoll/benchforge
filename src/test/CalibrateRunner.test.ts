import { expect, test } from "vitest";
import { formatCalibration } from "../cli/CalibrateRunner.ts";
import type { CalibrationResult } from "../runners/Calibration.ts";
import { summarizeCalibration } from "../stats/CalibrationSummary.ts";

/** A clean calibration result (scatter within CI, ample GCs) with the GC fields
 *  overridable per test. */
function calibrationResult(
  over: Partial<CalibrationResult> = {},
): CalibrationResult {
  const points = [0.1, -0.1, 0.0, 0.05, -0.05];
  const halfWidths = [0.5, 0.5, 0.5, 0.5, 0.5];
  return {
    runs: 5,
    batches: 100,
    pointEstimates: points,
    ciHalfWidths: halfWidths,
    summary: summarizeCalibration(points, halfWidths),
    ...over,
  };
}

test("renders a single-plateau GC histogram with no straddle warning", () => {
  const out = formatCalibration(
    calibrationResult({
      fullGcsPerBatch: 2,
      gcHistogram: [{ value: 2, count: 100 }],
    }),
  );
  expect(out).toContain("full GCs/batch           2x100   (mean 2.0)");
  expect(out).not.toContain("varies across batches");
});

test("renders a multi-bucket histogram tally", () => {
  const out = formatCalibration(
    calibrationResult({
      fullGcsPerBatch: 2.03,
      gcHistogram: [
        { value: 2, count: 97 },
        { value: 3, count: 3 },
      ],
    }),
  );
  expect(out).toContain("2x97  3x3");
});

test("warns when batches straddle a GC-count step", () => {
  const out = formatCalibration(
    calibrationResult({
      fullGcsPerBatch: 2.4,
      gcHistogram: [
        { value: 2, count: 60 },
        { value: 3, count: 40 },
      ],
    }),
  );
  expect(out).toContain(
    "warning: full GCs/batch varies across batches (2x60  3x40)",
  );
  expect(out).toContain("same plateau");
});

test("a few stray batches do not trip the straddle warning", () => {
  const out = formatCalibration(
    calibrationResult({
      fullGcsPerBatch: 2.05,
      gcHistogram: [
        { value: 2, count: 95 },
        { value: 3, count: 5 },
      ],
    }),
  );
  expect(out).not.toContain("varies across batches");
});

test("too-few-GCs warning takes priority over the straddle warning", () => {
  // Mean below 2 and also split across buckets: show the more fundamental
  // floor warning, not both.
  const out = formatCalibration(
    calibrationResult({
      fullGcsPerBatch: 1.4,
      gcHistogram: [
        { value: 1, count: 60 },
        { value: 2, count: 40 },
      ],
    }),
  );
  expect(out).toContain("only 1.4 full GCs per batch");
  expect(out).not.toContain("varies across batches");
});

test("omits the GC line entirely without gc stats", () => {
  const out = formatCalibration(calibrationResult());
  expect(out).not.toContain("full GCs/batch");
});
