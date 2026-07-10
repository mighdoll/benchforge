import type { MeasuredResults } from "../runners/MeasuredResults.ts";
import { bootstrapCIs } from "../stats/BlockBootstrap.ts";
import {
  type BlockDiffOptions,
  diffCIs,
  type PreparedPairedBlocks,
  pairedBlockBootstrap,
  pairedBlockDifference,
  preparePairedBlocks,
} from "../stats/BlockDifference.ts";
import type { BootstrapResult, DifferenceCI } from "../stats/Bootstrap.ts";
import { type StatKind, statKindToFn } from "../stats/CoreStats.ts";
import type { ShiftFunction } from "../viewer/ReportData.ts";
import type {
  ComparisonOptions,
  MetricSection,
  UnknownRecord,
} from "./BenchmarkReport.ts";
import { metricStatKind } from "./BenchmarkReport.ts";
import { hasBatchBlocks, hasLowBatchCount } from "./CiFormatting.ts";
import { buildMeanPoint, buildPoint } from "./ShiftPoints.ts";

type ShiftStats = {
  diffs: (DifferenceCI | undefined)[];
  curAbs: (BootstrapResult | undefined)[];
  baseAbs: (BootstrapResult | undefined)[];
  paired?: PreparedPairedBlocks;
};

/** Timing-domain percentiles sampled for the shift function: symmetric and
 *  log-spaced toward both tails (dense where regressions and noise live, sparse
 *  in the middle). Same set regardless of metric direction; for higherIsBetter
 *  metrics the displayed percentile is the mirror (1 - p). */
const shiftPercentiles = [0.01, 0.05, 0.1, 0.25, 0.5, 0.75, 0.9, 0.95, 0.99];

/** Options for {@link buildShiftFunction} beyond the two measured results. */
export interface ShiftFunctionOptions {
  currentMeta?: UnknownRecord;
  baselineMeta?: UnknownRecord;
  comparison?: ComparisonOptions;
  baselineName?: string;
  prepared?: PreparedPairedBlocks;
}

/** Build the per-percentile shift function for a metric section. Computes diff
 *  CIs and per-run absolute distributions across the distribution from raw
 *  timing samples. Returns undefined when there is no baseline or too little
 *  batch structure for a meaningful comparison. */
export function buildShiftFunction(
  section: MetricSection,
  current: MeasuredResults,
  baseline: MeasuredResults | undefined,
  options: ShiftFunctionOptions = {},
): ShiftFunction | undefined {
  if (!baseline?.samples?.length || !current.samples?.length) return undefined;
  const { currentMeta, baselineMeta, comparison, baselineName, prepared } =
    options;

  const noBatchTrim = comparison?.noBatchTrim;
  const stats = shiftStats(current, baseline, comparison, prepared);
  const { diffs, curAbs, baseAbs, paired } = stats;
  const nPairs = paired?.pairCount;
  const lowBatches = hasLowBatchCount(baseline, current, noBatchTrim, nPairs);
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
    currentBlocks: paired?.current.fullSplits,
    baselineBlocks: paired?.baseline.fullSplits,
    currentOffsets: paired?.current.batchOffsets,
    baselineOffsets: paired?.baseline.batchOffsets,
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

/** Prepare paired batch blocks from two results, throwing if either lacks the
 *  batch offsets a paired comparison requires. Shared by the metric row and the
 *  shift function so a case prepares each comparison's pairing only once. */
export function preparePairedResults(
  baseline: MeasuredResults,
  current: MeasuredResults,
  noTrim: boolean | undefined,
): PreparedPairedBlocks {
  if (!baseline.batchOffsets || !current.batchOffsets) {
    throw new Error(
      "Batched comparison requires batch offsets on both baseline and current",
    );
  }
  return preparePairedBlocks(
    baseline.samples,
    baseline.batchOffsets,
    current.samples,
    current.batchOffsets,
    { noTrim, rand: Math.random },
  );
}

/** Compute the diff CIs and per-run absolute distributions for mean + every
 *  sampled percentile. "mean" leads the stat list so its results sit at index 0;
 *  percentiles follow in shiftPercentiles order. */
function shiftStats(
  current: MeasuredResults,
  baseline: MeasuredResults,
  comparison: ComparisonOptions | undefined,
  paired: PreparedPairedBlocks | undefined,
): ShiftStats {
  const stats: StatKind[] = [
    "mean",
    ...shiftPercentiles.map(p => ({ percentile: p })),
  ];
  const noBatchTrim = comparison?.noBatchTrim;
  if (hasBatchBlocks(baseline, current))
    return pairedShiftStats(stats, current, baseline, comparison, paired);
  return sampleShiftStats(stats, current, baseline, comparison, noBatchTrim);
}

/** Block-bootstrap path: diffs and absolute CIs from the shared batch pairing,
 *  reusing a prepared pairing when one was passed in. Takes current before
 *  baseline, matching shiftStats and sampleShiftStats. */
function pairedShiftStats(
  stats: StatKind[],
  current: MeasuredResults,
  baseline: MeasuredResults,
  comparison: ComparisonOptions | undefined,
  paired: PreparedPairedBlocks | undefined,
): ShiftStats {
  const noBatchTrim = comparison?.noBatchTrim;
  const pair = paired ?? preparePairedResults(baseline, current, noBatchTrim);
  const resamples = comparison?.resamples;
  const opts: BlockDiffOptions = {
    equivMargin: comparison?.equivMargin,
    noBatchTrim,
    resamples,
  };
  const diffs = stats.map(s =>
    pairedBlockDifference(pair, statKindToFn(s), opts),
  );
  const absOpts = { resamples };
  const curAbs = stats.map(s =>
    pairedBlockBootstrap(pair.current, statKindToFn(s), absOpts),
  );
  const baseAbs = stats.map(s =>
    pairedBlockBootstrap(pair.baseline, statKindToFn(s), absOpts),
  );
  return { diffs, curAbs, baseAbs, paired: pair };
}

/** Per-sample path for unbatched runs: diffs and absolute CIs straight from the
 *  flat sample arrays (no batch pairing). */
function sampleShiftStats(
  stats: StatKind[],
  current: MeasuredResults,
  baseline: MeasuredResults,
  comparison: ComparisonOptions | undefined,
  noBatchTrim: boolean | undefined,
): ShiftStats {
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
