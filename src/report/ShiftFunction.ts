import type { MeasuredResults } from "../runners/MeasuredResults.ts";
import { bootstrapCIs } from "../stats/BlockBootstrap.ts";
import { diffCIs } from "../stats/BlockDifference.ts";
import type { BootstrapResult, DifferenceCI } from "../stats/Bootstrap.ts";
import type { StatKind } from "../stats/CoreStats.ts";
import type { ShiftFunction } from "../viewer/ReportData.ts";
import type {
  ComparisonOptions,
  MetricSection,
  UnknownRecord,
} from "./BenchmarkReport.ts";
import { metricStatKind } from "./BenchmarkReport.ts";
import { hasLowBatchCount } from "./CiFormatting.ts";
import { buildMeanPoint, buildPoint } from "./ShiftPoints.ts";

/** Timing-domain percentiles sampled for the shift function: symmetric and
 *  log-spaced toward both tails (dense where regressions and noise live, sparse
 *  in the middle). Same set regardless of metric direction; for higherIsBetter
 *  metrics the displayed percentile is the mirror (1 - p). */
const shiftPercentiles = [0.01, 0.05, 0.1, 0.25, 0.5, 0.75, 0.9, 0.95, 0.99];

/** Build the per-percentile shift function for a metric section. Computes diff
 *  CIs and per-run absolute distributions across the distribution from raw
 *  timing samples. Returns undefined when there is no baseline or too little
 *  batch structure for a meaningful comparison. */
export function buildShiftFunction(
  section: MetricSection,
  current: MeasuredResults,
  baseline: MeasuredResults | undefined,
  currentMeta: UnknownRecord | undefined,
  baselineMeta: UnknownRecord | undefined,
  comparison: ComparisonOptions | undefined,
  baselineName?: string,
): ShiftFunction | undefined {
  if (!baseline?.samples?.length || !current.samples?.length) return undefined;

  const noBatchTrim = comparison?.noBatchTrim;
  const { diffs, curAbs, baseAbs } = shiftStats(current, baseline, comparison);
  const lowBatches = hasLowBatchCount(baseline, current, noBatchTrim);
  const verdict = metricStatKind(section);
  const ctx = {
    section,
    current,
    baseline,
    currentMeta,
    baselineMeta,
    baselineName,
    lowBatches,
    noBatchTrim,
    verdict,
  };

  const percentiles = shiftPercentiles.flatMap((p, i) => {
    // +1 skips the leading mean entry in the result arrays.
    const point = buildPoint({
      p,
      diff: diffs[i + 1],
      curResult: curAbs[i + 1],
      baseResult: baseAbs[i + 1],
      ...ctx,
    });
    return point ? [point] : [];
  });
  // higherIsBetter metrics read low==>high in displayed percentile, which is the
  // reverse of the timing percentile order; sort by displayed percentile.
  percentiles.sort((a, b) => a.percentile - b.percentile);

  const mean = buildMeanPoint({
    p: 0,
    diff: diffs[0],
    curResult: curAbs[0],
    baseResult: baseAbs[0],
    ...ctx,
  });
  const points = mean ? [mean, ...percentiles] : percentiles;
  if (!points.length) return undefined;
  return {
    metric: section.title,
    equivMargin: comparison?.equivMargin,
    points,
  };
}

/** Compute the diff CIs and per-run absolute distributions for mean + every
 *  sampled percentile. "mean" leads the stat list so its results sit at index 0;
 *  percentiles follow in shiftPercentiles order. */
function shiftStats(
  current: MeasuredResults,
  baseline: MeasuredResults,
  comparison: ComparisonOptions | undefined,
): {
  diffs: (DifferenceCI | undefined)[];
  curAbs: (BootstrapResult | undefined)[];
  baseAbs: (BootstrapResult | undefined)[];
} {
  const stats: StatKind[] = [
    "mean",
    ...shiftPercentiles.map(p => ({ percentile: p })),
  ];
  const noBatchTrim = comparison?.noBatchTrim;
  const resamples = comparison?.resamples;
  const diffs = diffCIs(
    baseline.samples,
    baseline.batchOffsets,
    current.samples,
    current.batchOffsets,
    stats,
    { equivMargin: comparison?.equivMargin, noBatchTrim, resamples },
  );
  const absOpts = { noTrim: noBatchTrim, resamples };
  const curAbs = bootstrapCIs(
    current.samples,
    current.batchOffsets,
    stats,
    absOpts,
  );
  const baseAbs = bootstrapCIs(
    baseline.samples,
    baseline.batchOffsets,
    stats,
    absOpts,
  );
  return { diffs, curAbs, baseAbs };
}
