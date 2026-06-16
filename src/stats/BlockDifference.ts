import {
  allocPoolBuf,
  type PreparedBlocks,
  poolResampleStat,
  prepareBlocks,
} from "./BlockBootstrap.ts";
import {
  type BootstrapResult,
  bootstrapSamples,
  computeInterval,
  createResample,
  type DifferenceCI,
  defaultConfidence,
  type HistogramBin,
} from "./Bootstrap.ts";
import {
  isBootstrappable,
  mean,
  type StatKind,
  statKindToFn,
} from "./CoreStats.ts";
import {
  binValues,
  classifyDirection,
  type DiffOptions,
  multiSampleDifferenceCI,
} from "./SingleSampleDifference.ts";

/** Options for blockDifferenceCI (extends DiffOptions with block parameters) */
export type BlockDiffOptions = DiffOptions & {
  /** Block boundaries for the second sample array (defaults to blocksA) */
  blocksB?: number[];
  /** Disable Tukey trimming of outlier batches. Trimming compares per-batch
   *  means and drops slow-side outliers only; fast batches are kept since
   *  they reflect less environmental noise rather than errors. */
  noBatchTrim?: boolean;
};

type BinnedCI = {
  estimate: number;
  ci: [number, number];
  histogram: HistogramBin[];
};

/** Difference CIs for multiple stats, dispatching block vs sample automatically.
 *  Returns undefined for non-bootstrappable stats (min/max). */
export function diffCIs(
  a: number[],
  aOffsets: number[] | undefined,
  b: number[],
  bOffsets: number[] | undefined,
  stats: StatKind[],
  options: BlockDiffOptions = {},
): (DifferenceCI | undefined)[] {
  const supportedStats = stats.filter(isBootstrappable);
  if (supportedStats.length === 0) return stats.map(() => undefined);

  const hasBlocks =
    (aOffsets?.length ?? 0) >= 2 && (bOffsets?.length ?? 0) >= 2;
  const results = hasBlocks
    ? supportedStats.map(s => blockDiff(a, aOffsets!, b, bOffsets!, s, options))
    : multiSampleDifferenceCI(a, b, supportedStats, options);

  let resultIdx = 0;
  return stats.map(s =>
    isBootstrappable(s) ? results[resultIdx++] : undefined,
  );
}

/** @return block bootstrap CI for percentage difference between baseline (a) and current (b).
 *  Tukey-trims outlier batches, then resamples per-block statFn values. Requires 2+ blocks.
 *  Like {@link blockBootstrap}, the per-iteration readout is `mean(per-batch statFn)`,
 *  appropriate for linear statFns (mean) but not for percentiles; use
 *  {@link blockPoolDifferenceCI} for those. */
export function blockDifferenceCI(
  a: number[],
  blocksA: number[],
  b: number[],
  statFn: (s: number[]) => number,
  options: BlockDiffOptions = {},
): DifferenceCI {
  return blockDiffCI(
    a,
    blocksA,
    b,
    statFn,
    options,
    side => () => mean(createResample(side.blockVals)),
  );
}

/** @return block bootstrap CI for percentage difference between baseline (a) and
 *  current (b) for non-linear stats. Each iteration resamples whole batches with
 *  replacement on both sides, pools each side's samples, and computes
 *  `((statFn(poolB) - statFn(poolA)) / statFn(poolA)) * 100`. The CI describes
 *  the same quantity as the displayed point estimate. */
export function blockPoolDifferenceCI(
  a: number[],
  blocksA: number[],
  b: number[],
  statFn: (s: number[]) => number,
  options: BlockDiffOptions = {},
): DifferenceCI {
  return blockDiffCI(a, blocksA, b, statFn, options, side => {
    const buf = allocPoolBuf(side.keptSplits);
    return () => poolResampleStat(side.keptSplits, buf, statFn);
  });
}

/** @return binned CI with histogram from a BootstrapResult */
export function binBootstrapResult(result: BootstrapResult): BinnedCI {
  const { estimate, ci, samples } = result;
  return { estimate, ci, histogram: binValues(samples) };
}

/** Block-bootstrap difference CI for one stat: mean uses per-batch means,
 *  percentiles pool the resampled batches. */
function blockDiff(
  a: number[],
  aOffsets: number[],
  b: number[],
  bOffsets: number[],
  stat: StatKind,
  options: BlockDiffOptions,
): DifferenceCI {
  const fn = statKindToFn(stat);
  const diffOpts = { ...options, blocksB: bOffsets };
  if (stat === "mean") return blockDifferenceCI(a, aOffsets, b, fn, diffOpts);
  return blockPoolDifferenceCI(a, aOffsets, b, fn, diffOpts);
}

/** Shared block difference-CI core: prepare/trim both sides, then resample the
 *  percentage difference using per-side draw closures built by `makeDraw`.
 *  `blockDifferenceCI` and `blockPoolDifferenceCI` differ only in that draw. */
function blockDiffCI(
  a: number[],
  blocksA: number[],
  b: number[],
  statFn: (s: number[]) => number,
  options: BlockDiffOptions,
  makeDraw: (side: PreparedBlocks) => () => number,
): DifferenceCI {
  const { resamples = bootstrapSamples, confidence: conf = defaultConfidence } =
    options;
  const blocksB = options.blocksB ?? blocksA;
  const noTrim = options.noBatchTrim;
  const sideA = prepareBlocks(a, blocksA, statFn, noTrim);
  const sideB = prepareBlocks(b, blocksB, statFn, noTrim);

  const baseVal = statFn(sideA.filtered);
  const currVal = statFn(sideB.filtered);
  const observedPct = ((currVal - baseVal) / baseVal) * 100;

  const drawA = makeDraw(sideA);
  const drawB = makeDraw(sideB);
  const diffs = Array.from({ length: resamples }, () => {
    const base = drawA();
    return ((drawB() - base) / base) * 100;
  });
  const ci = computeInterval(diffs, conf);
  return {
    percent: observedPct,
    ci,
    direction: classifyDirection(ci, options.equivMargin),
    histogram: binValues(diffs),
    trimmed: [sideA.trimCount, sideB.trimCount],
    ciLevel: "block",
  };
}
