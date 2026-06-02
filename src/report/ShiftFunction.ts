import type { MeasuredResults } from "../runners/MeasuredResults.ts";
import { diffCIs } from "../stats/BootstrapDifference.ts";
import {
  average,
  type BootstrapResult,
  bootstrapCIs,
  type DifferenceCI,
  flipCI,
  percentile,
  prepareBlocks,
  type StatKind,
} from "../stats/StatisticalUtils.ts";
import type {
  ShiftFunction,
  ShiftPercentile,
  ShiftRun,
} from "../viewer/ReportData.ts";
import type {
  ComparisonOptions,
  MetricSection,
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
  section: MetricSection;
  current: MeasuredResults;
  baseline: MeasuredResults;
  currentMeta: UnknownRecord | undefined;
  baselineMeta: UnknownRecord | undefined;
  lowBatches: boolean;
  noBatchTrim: boolean | undefined;
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
): ShiftFunction | undefined {
  if (!baseline?.samples?.length || !current.samples?.length) return undefined;

  const noBatchTrim = comparison?.noBatchTrim;
  const { diffs, curAbs, baseAbs } = shiftStats(current, baseline, comparison);
  const lowBatches = hasLowBatchCount(baseline, current, noBatchTrim);
  const ctx = {
    section,
    current,
    baseline,
    currentMeta,
    baselineMeta,
    lowBatches,
    noBatchTrim,
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

/** @return a short percentile label, e.g. "p50", "p99", "p0.1". */
export function percentileLabel(p: number): string {
  const pct = p * 100;
  const rounded = Math.round(pct * 10) / 10;
  return `p${Number.isInteger(rounded) ? rounded : rounded.toFixed(1)}`;
}

/** @return a short stat label for headlines, e.g. "mean", "p50", "min". */
export function statLabel(kind: StatKind): string {
  if (typeof kind === "string") return kind;
  return percentileLabel(kind.percentile);
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
  const diffs = diffCIs(
    baseline.samples,
    baseline.batchOffsets,
    current.samples,
    current.batchOffsets,
    stats,
    { equivMargin: comparison?.equivMargin, noBatchTrim },
  );
  const curAbs = bootstrapCIs(current.samples, current.batchOffsets, stats, {
    noTrim: noBatchTrim,
  });
  const baseAbs = bootstrapCIs(baseline.samples, baseline.batchOffsets, stats, {
    noTrim: noBatchTrim,
  });
  return { diffs, curAbs, baseAbs };
}

/** Build one percentile point: flip + annotate the diff, format per-run absolute
 *  distributions, and gate reliability by tail coverage. */
function buildPoint(args: PointArgs): ShiftPercentile | undefined {
  const { p, section, lowBatches, current, baseline, noBatchTrim } = args;
  const base = buildPointBase(args);
  if (!base) return undefined;

  const curCoverage = tailCoverage(current, p, noBatchTrim);
  const baseCoverage = tailCoverage(baseline, p, noBatchTrim);
  const tailCount = Math.min(curCoverage.count, baseCoverage.count);
  const tailBatches = Math.min(curCoverage.batches, baseCoverage.batches);
  const reliable =
    !lowBatches && tailCount >= minTailSamples && tailBatches >= minTailBatches;

  // displayed percentile mirrors for higherIsBetter (timing p99 == loc/sec p1)
  const displayed = section.higherIsBetter ? 1 - p : p;
  return {
    ...base,
    percentile: displayed,
    label: percentileLabel(displayed),
    reliable,
    tailCount,
    tailBatches,
  };
}

/** Build the leading mean point. Mean uses every sample, so reliability is gated
 *  only by batch count (no tail-coverage check), and tail counts report the full
 *  sample/batch totals. Marked isMean for the renderer's leading-violin slot. */
function buildMeanPoint(args: PointArgs): ShiftPercentile | undefined {
  const { lowBatches, current, baseline, noBatchTrim } = args;
  const base = buildPointBase(args);
  if (!base) return undefined;

  const tailCount = Math.min(current.samples.length, baseline.samples.length);
  const tailBatches = Math.min(
    effectiveBatches(current, noBatchTrim),
    effectiveBatches(baseline, noBatchTrim),
  );
  return {
    ...base,
    isMean: true,
    percentile: 0,
    label: "mean",
    reliable: !lowBatches,
    tailCount,
    tailBatches,
  };
}

/** Shared point fields: flipped+annotated diff and per-run absolute distributions. */
function buildPointBase(
  args: PointArgs,
): Pick<ShiftPercentile, "diff" | "runs"> | undefined {
  const { diff, curResult, baseResult, section, lowBatches } = args;
  if (!diff || !curResult || !baseResult) return undefined;

  const flipped = section.higherIsBetter ? flipCI(diff) : diff;
  const annotated = annotateCI(flipped, section.title, lowBatches);

  const { current, baseline, currentMeta, baselineMeta } = args;
  const runCI = (
    r: BootstrapResult,
    m: MeasuredResults,
    meta?: UnknownRecord,
  ) => formatBootstrapCI(section, r, m.batchOffsets, meta);
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
  return { diff: annotated, runs };
}

/** @return how many samples lie on the sparse side of the p-th percentile and
 *  how many distinct batches contribute them. The sparse side is whichever end
 *  is closer (lower tail for p<=0.5, upper tail for p>0.5); that count is what
 *  pins the quantile down, so an extreme percentile has a tiny count even with
 *  many samples. Counts only the batches the bootstrap kept (Tukey-trimmed by
 *  per-batch mean unless noBatchTrim), so a trimmed-away slow tail cannot make
 *  a percentile look better supported than the CI it gates. */
function tailCoverage(
  m: MeasuredResults,
  p: number,
  noBatchTrim: boolean | undefined,
): { count: number; batches: number } {
  const { samples, batchOffsets } = m;
  const blocks =
    batchOffsets && batchOffsets.length >= 2
      ? prepareBlocks(samples, batchOffsets, average, noBatchTrim).keptSplits
      : [samples];
  const threshold = percentile(blocks.flat(), p);
  const inTail =
    p > 0.5 ? (v: number) => v >= threshold : (v: number) => v <= threshold;
  let count = 0;
  let batches = 0;
  for (const block of blocks) {
    const n = block.filter(inTail).length;
    if (n > 0) batches++;
    count += n;
  }
  return { count, batches };
}

/** @return distinct batches the bootstrap kept (Tukey-trimmed unless noTrim),
 *  or 1 when there is no batch structure. */
function effectiveBatches(
  m: MeasuredResults,
  noTrim: boolean | undefined,
): number {
  const { samples, batchOffsets } = m;
  if (!batchOffsets || batchOffsets.length < 2) return 1;
  return prepareBlocks(samples, batchOffsets, average, noTrim).keptSplits
    .length;
}
