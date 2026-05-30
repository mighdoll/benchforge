import type { MeasuredResults } from "../runners/MeasuredResults.ts";
import { diffCIs } from "../stats/BootstrapDifference.ts";
import {
  type BootstrapResult,
  bootstrapCIs,
  type DifferenceCI,
  flipCI,
  percentile,
  type StatKind,
  splitByOffsets,
} from "../stats/StatisticalUtils.ts";
import type {
  ShiftFunction,
  ShiftPercentile,
  ShiftRun,
} from "../viewer/ReportData.ts";
import type {
  ComparisonOptions,
  ReportColumn,
  UnknownRecord,
} from "./BenchmarkReport.ts";
import {
  annotateCI,
  formatBootstrapCI,
  hasLowBatchCount,
} from "./ViewerSections.ts";

interface PointArgs {
  p: number;
  diff: DifferenceCI | undefined;
  curResult: BootstrapResult | undefined;
  baseResult: BootstrapResult | undefined;
  col: ReportColumn;
  current: MeasuredResults;
  baseline: MeasuredResults;
  currentMeta: UnknownRecord | undefined;
  baselineMeta: UnknownRecord | undefined;
  lowBatches: boolean;
}

/** Timing-domain percentiles sampled for the shift function: symmetric and
 *  log-spaced toward both tails (dense where regressions and noise live, sparse
 *  in the middle). Same set regardless of metric direction; for higherIsBetter
 *  metrics the displayed percentile is the mirror (1 - p). */
const shiftPercentiles = [0.01, 0.05, 0.1, 0.25, 0.5, 0.75, 0.9, 0.95, 0.99];

/** A percentile estimate is reliable when enough samples lie beyond it and
 *  those samples span enough distinct batches. Block bootstrap resamples whole
 *  batches, so a tail living in 1-2 batches swings on which batches are drawn. */
const minTailSamples = 10;
const minTailBatches = 5;

/** Build the per-percentile shift function for a section's primary comparable
 *  column. Computes diff CIs and per-run absolute distributions across the
 *  distribution from raw timing samples. Returns undefined when there is no
 *  baseline or too little batch structure for a meaningful comparison. */
export function buildShiftFunction(
  col: ReportColumn,
  current: MeasuredResults,
  baseline: MeasuredResults | undefined,
  currentMeta: UnknownRecord | undefined,
  baselineMeta: UnknownRecord | undefined,
  comparison: ComparisonOptions | undefined,
): ShiftFunction | undefined {
  if (!baseline?.samples?.length || !current.samples?.length) return undefined;

  const stats: StatKind[] = shiftPercentiles.map(p => ({ percentile: p }));
  const noBatchTrim = comparison?.noBatchTrim;
  const opts = { equivMargin: comparison?.equivMargin, noBatchTrim };
  const diffs = diffCIs(
    baseline.samples,
    baseline.batchOffsets,
    current.samples,
    current.batchOffsets,
    stats,
    opts,
  );
  const curAbs = bootstrapCIs(current.samples, current.batchOffsets, stats, {
    noTrim: noBatchTrim,
  });
  const baseAbs = bootstrapCIs(baseline.samples, baseline.batchOffsets, stats, {
    noTrim: noBatchTrim,
  });
  const lowBatches = hasLowBatchCount(baseline, current, noBatchTrim);

  const points = shiftPercentiles.flatMap((p, i) => {
    const point = buildPoint({
      p,
      diff: diffs[i],
      curResult: curAbs[i],
      baseResult: baseAbs[i],
      col,
      current,
      baseline,
      currentMeta,
      baselineMeta,
      lowBatches,
    });
    return point ? [point] : [];
  });
  if (!points.length) return undefined;

  // higherIsBetter metrics read low==>high in displayed percentile, which is the
  // reverse of the timing percentile order; sort by displayed percentile.
  points.sort((a, b) => a.percentile - b.percentile);
  return { metric: col.title, equivMargin: comparison?.equivMargin, points };
}

/** Build one shift-function point: flip + annotate the diff, format per-run
 *  absolute distributions, and gate reliability by tail coverage. */
function buildPoint(args: PointArgs): ShiftPercentile | undefined {
  const { p, diff, curResult, baseResult, col, lowBatches } = args;
  if (!diff || !curResult || !baseResult) return undefined;

  const flipped = col.higherIsBetter ? flipCI(diff) : diff;
  const annotated = annotateCI(flipped, col.title, lowBatches);

  const { current, baseline, currentMeta, baselineMeta } = args;
  const runCI = (
    r: BootstrapResult,
    m: MeasuredResults,
    meta?: UnknownRecord,
  ) => formatBootstrapCI(col, r, m.batchOffsets, meta);
  const runs: ShiftRun[] = [
    {
      runName: current.name,
      bootstrapCI: runCI(curResult, current, currentMeta),
    },
    {
      runName: "baseline",
      bootstrapCI: runCI(baseResult, baseline, baselineMeta),
    },
  ];

  const curCoverage = tailCoverage(current, p);
  const baseCoverage = tailCoverage(baseline, p);
  const tailCount = Math.min(curCoverage.count, baseCoverage.count);
  const tailBatches = Math.min(curCoverage.batches, baseCoverage.batches);
  const reliable =
    !lowBatches && tailCount >= minTailSamples && tailBatches >= minTailBatches;

  // displayed percentile mirrors for higherIsBetter (timing p99 == loc/sec p1)
  const displayed = col.higherIsBetter ? 1 - p : p;
  return {
    percentile: displayed,
    label: percentileLabel(displayed),
    diff: annotated,
    runs,
    reliable,
    tailCount,
    tailBatches,
  };
}

/** @return how many samples lie on the sparse side of the p-th percentile and
 *  how many distinct batches contribute them. The sparse side is whichever end
 *  is closer (lower tail for p<=0.5, upper tail for p>0.5); that count is what
 *  pins the quantile down, so an extreme percentile has a tiny count even with
 *  many samples. */
function tailCoverage(
  m: MeasuredResults,
  p: number,
): { count: number; batches: number } {
  const { samples, batchOffsets } = m;
  const threshold = percentile(samples, p);
  const inTail =
    p > 0.5 ? (v: number) => v >= threshold : (v: number) => v <= threshold;
  const blocks = batchOffsets
    ? splitByOffsets(samples, batchOffsets)
    : [samples];
  let count = 0;
  let batches = 0;
  for (const block of blocks) {
    const n = block.filter(inTail).length;
    if (n > 0) batches++;
    count += n;
  }
  return { count, batches };
}

/** @return a short percentile label, e.g. "p50", "p99", "p0.1". */
function percentileLabel(p: number): string {
  const pct = p * 100;
  const rounded = Math.round(pct * 10) / 10;
  return `p${Number.isInteger(rounded) ? rounded : rounded.toFixed(1)}`;
}
