import { diffCIs } from "../stats/BootstrapDifference.ts";
import {
  type CalibrationSummary,
  summarizeCalibration,
} from "../stats/CalibrationSummary.ts";
import { average, type StatKind } from "../stats/StatisticalUtils.ts";
import type { MeasuredResults } from "./MeasuredResults.ts";
import { runBatched } from "./MergeBatches.ts";

/** A single MeasuredResults producer (one full batched measurement of a case). */
export type SampleRunner = () => Promise<MeasuredResults>;

export interface CalibrateParams {
  /** Runs the current build once; used on both sides of each comparison. */
  current: SampleRunner;
  batches: number;
  runs: number;
  warmupBatch: boolean;
  /** Stat for the difference CI (default: mean). */
  statKind?: StatKind;
  /** Optional per-run progress callback. */
  onRun?: (run: RunProgress) => void;
}

/** Progress for one completed self-comparison run. */
export interface RunProgress {
  run: number;
  runs: number;
  point: number;
  ciHalfWidth: number;
}

export interface CalibrationResult {
  runs: number;
  batches: number;
  /** Per-run percentage point estimates (current vs identical current). */
  pointEstimates: number[];
  /** Per-run CI half-widths in percent. */
  ciHalfWidths: number[];
  summary: CalibrationSummary;
  /** Mean full (major) GCs per batch, or undefined when GC stats are absent
   *  (no --gc-stats). Below ~2, single-run CIs understate between-run GC
   *  timing variance: the batch mean is dominated by where the lone collection
   *  lands. Increase --duration so each batch averages over several GCs. */
  fullGcsPerBatch?: number;
}

/** Measure the harness noise floor by comparing the current build against an
 *  identical copy of itself, repeated `runs` times. The true difference is
 *  zero, so the spread of results is a pure readout of measurement noise. */
export async function runCalibration(
  params: CalibrateParams,
): Promise<CalibrationResult> {
  const { current, batches, runs, warmupBatch, onRun } = params;
  const statKind: StatKind = params.statKind ?? "mean";
  const pointEstimates: number[] = [];
  const ciHalfWidths: number[] = [];
  const fullGcs: number[] = [];

  for (let i = 0; i < runs; i++) {
    const { results, baseline } = await runBatched(
      [current],
      current,
      batches,
      warmupBatch,
    );
    const ci = currentVsCurrentCI(baseline!, results[0], statKind);
    const point = ci.percent;
    const ciHalfWidth = (ci.ci[1] - ci.ci[0]) / 2;
    pointEstimates.push(point);
    ciHalfWidths.push(ciHalfWidth);
    const fullGc = fullGcsForRun(results[0]);
    if (fullGc !== undefined) fullGcs.push(fullGc);
    onRun?.({ run: i + 1, runs, point, ciHalfWidth });
  }

  const summary = summarizeCalibration(pointEstimates, ciHalfWidths);
  const fullGcsPerBatch =
    fullGcs.length === runs ? average(fullGcs) / batches : undefined;
  return {
    runs,
    batches,
    pointEstimates,
    ciHalfWidths,
    summary,
    fullGcsPerBatch,
  };
}

/** Full (major) GCs in one run's merged results, or undefined without gc stats. */
function fullGcsForRun(r: MeasuredResults): number | undefined {
  if (r.batchGcStats)
    return r.batchGcStats.reduce((sum, g) => sum + g.markCompacts, 0);
  return r.gcStats?.markCompacts;
}

/** Difference CI between two independent runs of the same build. */
function currentVsCurrentCI(
  a: MeasuredResults,
  b: MeasuredResults,
  statKind: StatKind,
) {
  const [ci] = diffCIs(a.samples, a.batchOffsets, b.samples, b.batchOffsets, [
    statKind,
  ]);
  if (!ci)
    throw new Error(`Cannot compute calibration CI for stat ${statKind}`);
  return ci;
}
