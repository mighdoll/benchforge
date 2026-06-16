import { diffCIs } from "../stats/BootstrapDifference.ts";
import {
  type CalibrationSummary,
  summarizeCalibration,
} from "../stats/CalibrationSummary.ts";
import {
  type IntegerCount,
  integerCounts,
  mean,
  type StatKind,
} from "../stats/StatisticalUtils.ts";
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
  /** Distribution of full GCs per batch, pooled across all runs and sorted by
   *  count. A single bucket means every batch is on the same GC plateau; spread
   *  across buckets means batches straddle a collection-count step, where the
   *  per-batch mean jumps by a whole major GC. Undefined without --gc-stats. */
  gcHistogram?: IntegerCount[];
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
  const perBatchGcs: number[] = [];
  let runsWithGc = 0;

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
    const batchGcs = perBatchFullGcs(results[0]);
    if (batchGcs !== undefined) {
      perBatchGcs.push(...batchGcs);
      runsWithGc++;
    }
    onRun?.({ run: i + 1, runs, point, ciHalfWidth });
  }

  const summary = summarizeCalibration(pointEstimates, ciHalfWidths);
  const haveGc = runsWithGc === runs && perBatchGcs.length > 0;
  const fullGcsPerBatch = haveGc ? mean(perBatchGcs) : undefined;
  const gcHistogram = haveGc ? integerCounts(perBatchGcs) : undefined;
  return {
    runs,
    batches,
    pointEstimates,
    ciHalfWidths,
    summary,
    fullGcsPerBatch,
    gcHistogram,
  };
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

/** Per-batch full (major) GC counts for one run, or undefined without per-batch
 *  gc stats (no --gc-stats). One entry per batch. */
function perBatchFullGcs(r: MeasuredResults): number[] | undefined {
  return r.batchGcStats?.map(g => g.markCompacts);
}
