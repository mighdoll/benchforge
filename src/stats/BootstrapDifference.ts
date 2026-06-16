import type {
  BootstrapResult,
  CIDirection,
  DifferenceCI,
  HistogramBin,
  PreparedBlocks,
  StatKind,
} from "./StatisticalUtils.ts";
import {
  allocPoolBuf,
  bootstrapSamples,
  computeInterval,
  createResample,
  defaultConfidence,
  isBootstrappable,
  maxBootstrapInput,
  maxOf,
  mean,
  minOf,
  percentile,
  percentileIndex,
  poolResampleStat,
  prepareBlocks,
  quickSelect,
  resampleInto,
  statKindToFn,
  subsample,
} from "./StatisticalUtils.ts";

/** Options for blockDifferenceCI (extends DiffOptions with block parameters) */
export type BlockDiffOptions = DiffOptions & {
  /** Block boundaries for the second sample array (defaults to blocksA) */
  blocksB?: number[];
  /** Disable Tukey trimming of outlier batches. Trimming compares per-batch
   *  means and drops slow-side outliers only; fast batches are kept since
   *  they reflect less environmental noise rather than errors. */
  noBatchTrim?: boolean;
};

/** Options for difference CI functions */
type DiffOptions = {
  /** Number of bootstrap resamples (default: 10000) */
  resamples?: number;
  /** Confidence level 0-1 (default: 0.95) */
  confidence?: number;
  /** Equivalence margin in percent. CI within [-margin, +margin] ==> "equivalent" */
  equivMargin?: number;
};

type BinnedCI = {
  estimate: number;
  ci: [number, number];
  histogram: HistogramBin[];
};

interface DiffOp {
  origIndex: number;
  execIndex: number;
  computeA: (buf: number[]) => number;
  computeB: (buf: number[]) => number;
  pointEstimate: (s: number[]) => number;
}

/** Shared-resample difference CI: one resample pair per iteration, all stats computed.
 *  @return DifferenceCI[] in same order as input stats. */
export function multiSampleDifferenceCI(
  a: number[],
  b: number[],
  stats: StatKind[],
  options: DiffOptions = {},
): DifferenceCI[] {
  const { resamples = bootstrapSamples, confidence: conf = defaultConfidence } =
    options;
  const subA = subsample(a, maxBootstrapInput);
  const subB = subsample(b, maxBootstrapInput);
  const bufA = new Array(subA.length);
  const bufB = new Array(subB.length);
  const ops = buildDiffOps(stats, subA.length, subB.length);
  const allDiffs = ops.map(() => new Array<number>(resamples));

  const baseVals = ops.map(op => op.pointEstimate(a));
  const currVals = ops.map(op => op.pointEstimate(b));
  const observedPcts = ops.map(
    (_, j) => ((currVals[j] - baseVals[j]) / baseVals[j]) * 100,
  );

  for (let i = 0; i < resamples; i++) {
    resampleInto(subA, bufA);
    resampleInto(subB, bufB);
    for (let j = 0; j < ops.length; j++) {
      const base = ops[j].computeA(bufA);
      const curr = ops[j].computeB(bufB);
      allDiffs[j][i] = ((curr - base) / base) * 100;
    }
  }

  const capped = subA !== a || subB !== b;
  const results = new Array<DifferenceCI>(stats.length);
  for (const op of ops) {
    const j = op.execIndex;
    const ci = computeInterval(allDiffs[j], conf);
    results[op.origIndex] = {
      percent: observedPcts[j],
      ci,
      direction: classifyDirection(ci, options.equivMargin),
      histogram: binValues(allDiffs[j]),
      ciLevel: "sample",
      ...(capped && { subsampled: Math.max(a.length, b.length) }),
    };
  }
  return results;
}

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

/** @return CI direction against an equivalence margin (in percent, default 0).
 *  Both verdicts are whole-CI tests (TOST): faster/slower require the entire CI
 *  beyond +/-margin (the calibrated noise floor), equivalent requires it wholly
 *  inside. A CI straddling a margin edge is "uncertain": not provably beyond
 *  noise, so it needs more data. Margin 0 is not special -- it falls out as the
 *  plain CI-excludes-zero test, which is why a small margin can't flip verdicts
 *  on point-estimate noise the way point gating would. */
export function classifyDirection(
  ci: [number, number],
  margin = 0,
): CIDirection {
  if (ci[1] < -margin) return "faster";
  if (ci[0] > margin) return "slower";
  if (ci[0] >= -margin && ci[1] <= margin) return "equivalent";
  return "uncertain";
}

/** Build diff operations: mean/min/max first (non-destructive), then percentiles ascending.
 *  Each side (A, B) gets its own quickSelect k since sample sizes may differ. */
function buildDiffOps(stats: StatKind[], nA: number, nB: number): DiffOp[] {
  const sameBothSides = (
    order: number,
    i: number,
    fn: (s: number[]) => number,
  ) => ({
    order,
    origIndex: i,
    execIndex: 0,
    computeA: fn,
    computeB: fn,
    pointEstimate: fn,
  });
  const entries = stats.map((s, i) => {
    if (s === "mean") return sameBothSides(-3, i, mean);
    if (s === "min") return sameBothSides(-2, i, minOf);
    if (s === "max") return sameBothSides(-1, i, maxOf);
    const p = s.percentile;
    const kA = percentileIndex(nA, p);
    const kB = percentileIndex(nB, p);
    return {
      order: p,
      origIndex: i,
      execIndex: 0,
      computeA: (buf: number[]) => quickSelect(buf, kA),
      computeB: (buf: number[]) => quickSelect(buf, kB),
      pointEstimate: (v: number[]) => percentile(v, p),
    };
  });
  entries.sort((a, b) => a.order - b.order);
  for (let i = 0; i < entries.length; i++) entries[i].execIndex = i;
  return entries;
}

/** @return values binned into histogram for compact visualization */
function binValues(values: number[], binCount = 30): HistogramBin[] {
  let min = values[0];
  let max = values[0];
  for (let i = 1; i < values.length; i++) {
    if (values[i] < min) min = values[i];
    if (values[i] > max) max = values[i];
  }
  if (min === max) return [{ x: min, count: values.length }];

  const step = (max - min) / binCount;
  const counts = new Array(binCount).fill(0);
  for (const v of values) {
    const bin = Math.min(Math.floor((v - min) / step), binCount - 1);
    counts[bin]++;
  }
  return counts.map((count, i) => ({ x: min + (i + 0.5) * step, count }));
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
