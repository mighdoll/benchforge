import { expect, test } from "vitest";
import {
  calibrationMarkdown,
  type CalibrationMeta,
} from "../report/CalibrationReport.ts";
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

const meta: CalibrationMeta = {
  timestamp: "2026-06-22T10:30:45.123Z",
  cliArgs: { _: [], calibrate: true, batches: 100, "gc-stats": true },
  cliDefaults: { batches: 30 },
  environment: { node: "v22.0.0", platform: "darwin", arch: "arm64" },
};

test("header carries the title, invocation, timestamp, and machine", () => {
  const md = calibrationMarkdown(calibrationResult(), meta);
  expect(md).toContain("# Calibration report");
  expect(md).toContain("`benchforge --calibrate --batches 100 --gc-stats`");
  expect(md).toContain("2026-06-22T10:30:45.123Z -- node v22.0.0, darwin arm64");
});

test("noise floor table bolds the suggested margin", () => {
  const md = calibrationMarkdown(calibrationResult(), meta);
  expect(md).toContain("## Noise floor (5 runs x 100 batches, current vs current)");
  expect(md).toMatch(/\| \*\*suggested --equiv-margin\*\* \| \*\*[\d.]+%\*\* \|/);
});

test("scatter cell has no literal pipe that would break the table", () => {
  const md = calibrationMarkdown(calibrationResult(), meta);
  const scatterRow = md
    .split("\n")
    .find(l => l.includes("point-estimate scatter"));
  expect(scatterRow).toBeDefined();
  // exactly the two cell-boundary pipes plus the row's leading/trailing pipe
  expect(scatterRow!.match(/\|/g)).toHaveLength(3);
  expect(scatterRow).toContain("95th pct abs");
});

test("per-run table lists every run", () => {
  const md = calibrationMarkdown(calibrationResult(), meta);
  expect(md).toContain("## Per-run");
  expect(md).toContain("| run | Δ% | CI half-width |");
  expect(md).toContain("| 1 | +0.1% | 0.50% |");
  expect(md).toContain("| 5 | -0.1% | 0.50% |");
});

test("GC row appears only with gc stats", () => {
  const withGc = calibrationMarkdown(
    calibrationResult({
      fullGcsPerBatch: 2,
      gcHistogram: [{ value: 2, count: 100 }],
    }),
    meta,
  );
  expect(withGc).toContain("| full GCs/batch | 2x100 (mean 2.0) |");
  expect(calibrationMarkdown(calibrationResult(), meta)).not.toContain(
    "full GCs/batch",
  );
});

test("straddle warning renders as a blockquote", () => {
  const md = calibrationMarkdown(
    calibrationResult({
      fullGcsPerBatch: 2.4,
      gcHistogram: [
        { value: 2, count: 60 },
        { value: 3, count: 40 },
      ],
    }),
    meta,
  );
  expect(md).toContain(
    "> **warning:** full GCs/batch varies across batches (2x60  3x40)",
  );
  expect(md).toContain("> lands on the same plateau.");
});

test("too-few-GCs warning takes priority over the straddle warning", () => {
  const md = calibrationMarkdown(
    calibrationResult({
      fullGcsPerBatch: 1.4,
      gcHistogram: [
        { value: 1, count: 60 },
        { value: 2, count: 40 },
      ],
    }),
    meta,
  );
  expect(md).toContain("> **warning:** only 1.4 full GCs per batch");
  expect(md).not.toContain("varies across batches");
});

test("overconfident scatter warns as a blockquote", () => {
  const points = [2, -2, 1.5, -1.5, 0];
  const halfWidths = [0.2, 0.2, 0.2, 0.2, 0.2];
  const md = calibrationMarkdown(
    calibrationResult({
      pointEstimates: points,
      ciHalfWidths: halfWidths,
      summary: summarizeCalibration(points, halfWidths),
    }),
    meta,
  );
  expect(md).toContain("> **warning:** scatter (");
  expect(md).toContain("exceeds within-run CI");
});
