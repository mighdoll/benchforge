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
import {
  type BootstrapResult,
  type DifferenceCI,
  defaultRand,
} from "../stats/Bootstrap.ts";
import { median, type StatKind, statKindToFn } from "../stats/CoreStats.ts";
import type {
  AbsolutePercentile,
  AbsoluteShift,
  ShiftFunction,
  ShiftPercentile,
} from "../viewer/ReportData.ts";
import type {
  ComparisonOptions,
  MetricSection,
  UnknownRecord,
} from "./BenchmarkReport.ts";
import { metricStatKind } from "./BenchmarkReport.ts";
import {
  displayMarginBand,
  effectiveBatchCount,
  hasBatchBlocks,
  hasLowBatchCount,
  minBatches,
} from "./CiFormatting.ts";
import {
  type AbsPointArgs,
  buildAbsoluteMeanPoint,
  buildAbsolutePoint,
  buildMeanPoint,
  buildPoint,
  type PointArgs,
} from "./ShiftPoints.ts";

/** Options for {@link buildShiftFunction} beyond the two measured results. */
export interface ShiftFunctionOptions {
  currentMeta?: UnknownRecord;
  baselineMeta?: UnknownRecord;
  comparison?: ComparisonOptions;
  baselineName?: string;
  prepared?: PreparedPairedBlocks;
}

/** The shared per-comparison fields fed to every point (all but the per-point
 *  stat and its precomputed diff/abs results). */
type ShiftContext = Omit<PointArgs, "p" | "diff" | "curResult" | "baseResult">;

/** Per-stat results, indexed to match the stat list (mean at 0, percentiles
 *  after), plus the shared pairing reused across points. */
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
  const { baseAbs, paired } = stats;
  const nPairs = paired?.pairCount;
  const lowBatches = hasLowBatchCount(baseline, current, noBatchTrim, nPairs);
  const verdict = metricStatKind(section);
  const ctx: ShiftContext = {
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

  const points = buildPoints(ctx, stats);
  if (!points.length) return undefined;
  const equivMargin = comparison?.equivMargin;
  const equivMarginBand = marginBand(
    section,
    equivMargin,
    baseAbs[0],
    baselineMeta,
  );
  return { metric: section.title, equivMargin, equivMarginBand, points };
}

/** Build the per-percentile absolute distribution fan for a metric section from
 *  a single variant's samples, for runs with no baseline to diff against.
 *  Reuses the same stat list and reliability gating as the shift function, but
 *  bootstraps only the current variant's absolute values. Returns undefined when
 *  there are too few samples to bootstrap. */
export function buildAbsoluteShift(
  section: MetricSection,
  current: MeasuredResults,
  options: ShiftFunctionOptions = {},
): AbsoluteShift | undefined {
  if (current.samples.length <= 1) return undefined;
  const { currentMeta, comparison } = options;
  const noBatchTrim = comparison?.noBatchTrim;

  const stats: StatKind[] = [
    "mean",
    ...shiftPercentiles.map(p => ({ percentile: p })),
  ];
  const results = bootstrapCIs(current.samples, current.batchOffsets, stats, {
    noTrim: noBatchTrim,
    resamples: comparison?.resamples,
  });

  const base: Omit<AbsPointArgs, "p" | "result"> = {
    section,
    current,
    currentMeta,
    lowBatches: effectiveBatchCount(current, noBatchTrim) < minBatches,
    noBatchTrim,
    verdict: metricStatKind(section),
  };
  const percentiles = shiftPercentiles.flatMap((p, i) => {
    const point = buildAbsolutePoint({ ...base, p, result: results[i + 1] });
    return point ? [point] : [];
  });
  percentiles.sort((a, b) => a.percentile - b.percentile);
  const mean = buildAbsoluteMeanPoint({ ...base, p: 0, result: results[0] });
  const points = mean ? [mean, ...percentiles] : percentiles;
  if (!points.length) return undefined;

  const domain = absoluteDomain(points);
  const axisTicks = absoluteTicks(domain, section);
  return { metric: section.title, domain, axisTicks, points };
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
    { noTrim, rand: defaultRand() },
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

/** Build the mean point plus one point per sampled percentile (skipping any that
 *  drop out), sorted by displayed percentile. The mean leads the result arrays,
 *  so percentile i reads index i+1. higherIsBetter mirrors the displayed
 *  percentile, so sort by it rather than the timing order. */
function buildPoints(ctx: ShiftContext, stats: ShiftStats): ShiftPercentile[] {
  const { diffs, curAbs, baseAbs } = stats;
  const percentiles = shiftPercentiles.flatMap((p, i) => {
    const point = buildPoint({
      p,
      diff: diffs[i + 1],
      curResult: curAbs[i + 1],
      baseResult: baseAbs[i + 1],
      ...ctx,
    });
    return point ? [point] : [];
  });
  percentiles.sort((a, b) => a.percentile - b.percentile);
  const mean = buildMeanPoint({
    p: 0,
    diff: diffs[0],
    curResult: curAbs[0],
    baseResult: baseAbs[0],
    ...ctx,
  });
  return mean ? [mean, ...percentiles] : percentiles;
}

/** The equivalence margin as a display-domain band, anchored on the baseline
 *  mean (the same anchor as the mean point's diff). Undefined when no margin. */
function marginBand(
  section: MetricSection,
  equivMargin: number | undefined,
  baseMean: BootstrapResult | undefined,
  baselineMeta: UnknownRecord | undefined,
): [number, number] | undefined {
  if (equivMargin == null || !baseMean) return undefined;
  return displayMarginBand(
    section,
    equivMargin,
    baseMean.estimate,
    baselineMeta,
  );
}

/** Display-domain [min, max] the absolute fan spans. Keyed on the well-measured
 *  points (reliable, CI not far wider than peers') so a noisy tail percentile
 *  can't stretch the scale; the plot clips wider violins at the edge. */
function absoluteDomain(points: AbsolutePercentile[]): [number, number] {
  const reliable = points.filter(p => p.reliable);
  const candidates = reliable.length ? reliable : points;
  const width = (p: AbsolutePercentile) => p.ci.ci[1] - p.ci.ci[0];
  const medWidth = median(candidates.map(width)) || 0;
  const bounded = candidates.filter(p => width(p) <= 3 * medWidth);
  const use = bounded.length ? bounded : candidates;
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const p of use) {
    min = Math.min(min, p.ci.ci[0], p.ci.estimate);
    max = Math.max(max, p.ci.ci[1], p.ci.estimate);
  }
  const pad = (max - min) * 0.05 || 1;
  return [min - pad, max + pad];
}

/** Pre-formatted y-axis ticks at a nice step across the domain, labeled in the
 *  metric's own units (the viewer has no formatter to do this itself). */
function absoluteTicks(
  domain: [number, number],
  section: MetricSection,
): { value: number; label: string }[] {
  const [min, max] = domain;
  const step = niceStep((max - min) / 5);
  const ticks: { value: number; label: string }[] = [];
  for (let t = Math.ceil(min / step) * step; t <= max; t += step)
    ticks.push({ value: t, label: section.formatter(t) ?? String(t) });
  return ticks;
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

/** @return a "nice" axis step (1, 2, or 5 times a power of ten) near raw. */
function niceStep(raw: number): number {
  const mag = 10 ** Math.floor(Math.log10(raw || 1));
  const mantissa = raw / mag;
  if (mantissa < 1.5) return mag;
  if (mantissa < 3) return 2 * mag;
  if (mantissa < 7) return 5 * mag;
  return 10 * mag;
}
