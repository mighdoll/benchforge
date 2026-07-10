import {
  allocPoolBuf,
  appendBlock,
  capSplits,
  filledBuf,
  keptIndices,
  type PrepareOptions,
  poolResampleStat,
  splitByOffsets,
} from "./BlockBootstrap.ts";
import {
  type BootstrapOptions,
  type BootstrapResult,
  bootstrapSamples,
  computeInterval,
  type DifferenceCI,
  defaultConfidence,
  type HistogramBin,
  maxBootstrapInput,
  type Rand,
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

/** Options for blockDifferenceCI (extends DiffOptions with noBatchTrim) */
export type BlockDiffOptions = DiffOptions & {
  /** Disable Tukey trimming of outlier batches. Trimming compares per-batch
   *  means and drops slow-side outliers only; fast batches are kept since
   *  they reflect less environmental noise rather than errors. */
  noBatchTrim?: boolean;
};

export type PairedSide = {
  /** Full kept pool used for point estimates and visible values. */
  filtered: number[];

  /** Full kept batches, before bootstrap input capping. */
  fullSplits: number[][];

  /** Kept batches used for bootstrap draws, capped when needed. */
  keptSplits: number[][];

  /** Offsets into `filtered`, one per kept paired batch. */
  batchOffsets: number[];
};

export type PreparedPairedBlocks = {
  baseline: PairedSide;
  current: PairedSide;

  /** Side-specific Tukey rejections before the paired keep intersection. */
  trimmed: [number, number];

  /** Number of paired rounds remaining after pairwise trimming. */
  pairCount: number;
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

  // Any offsets mean block mode; usePairedBlocks throws unless both sides carry
  // aligned offsets, so one-sided input fails loud instead of silently sampling.
  const hasOffsets = aOffsets !== undefined || bOffsets !== undefined;
  const usePaired = hasOffsets && usePairedBlocks(a, aOffsets, b, bOffsets);
  const results = usePaired
    ? supportedStats.map(s => blockDiff(a, aOffsets!, b, bOffsets!, s, options))
    : multiSampleDifferenceCI(a, b, supportedStats, options);

  let resultIdx = 0;
  return stats.map(s =>
    isBootstrappable(s) ? results[resultIdx++] : undefined,
  );
}

/** @return block bootstrap CI for percentage difference between baseline (a) and current (b).
 *  Tukey-trims pairwise outlier rounds, then resamples paired batch indices.
 *  Each draw pools the selected baseline/current batches and recomputes the
 *  percentage delta, so every stat uses the same estimand as the point value. */
export function blockDifferenceCI(
  a: number[],
  blocksA: number[],
  b: number[],
  statFn: (s: number[]) => number,
  options: BlockDiffOptions = {},
): DifferenceCI {
  return pairedBlockDifferenceCI(a, blocksA, b, blocksA, statFn, options);
}

/** @return binned CI with histogram from a BootstrapResult */
export function binBootstrapResult(result: BootstrapResult): BinnedCI {
  const { estimate, ci, samples } = result;
  return { estimate, ci, histogram: binValues(samples) };
}

/** Prepare aligned baseline/current blocks for a paired comparison. Trim
 *  decisions are side-specific, then the kept pair set is their intersection. */
export function preparePairedBlocks(
  baseline: number[],
  baselineOffsets: number[],
  current: number[],
  currentOffsets: number[],
  { noTrim, cap, rand }: PrepareOptions,
): PreparedPairedBlocks {
  validatePairedOffsets(baseline, baselineOffsets, current, currentOffsets);
  const baseSplits = splitByOffsets(baseline, baselineOffsets);
  const curSplits = splitByOffsets(current, currentOffsets);
  const keepBase = new Set(keptIndices(baseSplits.map(mean), noTrim));
  const keepCur = new Set(keptIndices(curSplits.map(mean), noTrim));
  const keep = baseSplits
    .map((_, i) => i)
    .filter(i => keepBase.has(i) && keepCur.has(i));
  if (!keep.length) {
    throw new Error("Paired batch comparison trimmed every batch round");
  }
  const drawCap = cap ?? maxBootstrapInput;
  const baseKept = keep.map(i => baseSplits[i]);
  const curKept = keep.map(i => curSplits[i]);
  return {
    baseline: pairedSide(baseKept, drawCap, rand),
    current: pairedSide(curKept, drawCap, rand),
    trimmed: [
      baseSplits.length - keepBase.size,
      curSplits.length - keepCur.size,
    ],
    pairCount: keep.length,
  };
}

/** Marginal absolute-stat CI over one side of a paired comparison. The side's
 *  kept batch set is the same pairwise-kept set used by the delta CI. */
export function pairedBlockBootstrap(
  side: PairedSide,
  statFn: (s: number[]) => number,
  options: BootstrapOptions = {},
): BootstrapResult {
  const { resamples = bootstrapSamples, confidence: conf = defaultConfidence } =
    options;
  const rand = options.random ?? Math.random;
  const buf = allocPoolBuf(side.keptSplits);
  const stats = Array.from({ length: resamples }, () =>
    poolResampleStat(side.keptSplits, buf, statFn, rand),
  );
  return {
    estimate: statFn(side.filtered),
    ci: computeInterval(stats, conf),
    samples: stats,
    ciLevel: "block",
  };
}

/** Paired block-pool difference CI from an already prepared paired batch set.
 *  percent is non-finite when baseVal is 0 (a degenerate all-zero-sample
 *  pool); callers should treat that as unmeasurable rather than a real delta. */
export function pairedBlockDifference(
  pair: PreparedPairedBlocks,
  statFn: (s: number[]) => number,
  options: DiffOptions = {},
): DifferenceCI {
  const { resamples = bootstrapSamples, confidence: conf = defaultConfidence } =
    options;
  const rand = options.random ?? Math.random;
  const baseVal = statFn(pair.baseline.filtered);
  const currVal = statFn(pair.current.filtered);
  const observedPct = ((currVal - baseVal) / baseVal) * 100;

  const baseBuf = allocPoolBuf(pair.baseline.keptSplits);
  const curBuf = allocPoolBuf(pair.current.keptSplits);
  const diffs = Array.from({ length: resamples }, () =>
    pairedPoolDiff(pair, baseBuf, curBuf, statFn, rand),
  );
  const ci = computeInterval(diffs, conf);
  return {
    percent: observedPct,
    ci,
    direction: classifyDirection(ci, options.equivMargin),
    histogram: binValues(diffs),
    trimmed: pair.trimmed,
    ciLevel: "block",
  };
}

/** Paired block-pool difference CI from raw samples + offsets (prepares, then
 *  delegates to {@link pairedBlockDifference}). */
export function pairedBlockDifferenceCI(
  a: number[],
  aOffsets: number[],
  b: number[],
  bOffsets: number[],
  statFn: (s: number[]) => number,
  options: BlockDiffOptions = {},
): DifferenceCI {
  const pair = preparePairedBlocks(a, aOffsets, b, bOffsets, {
    noTrim: options.noBatchTrim,
    cap: maxBootstrapInput,
    rand: options.random ?? Math.random,
  });
  return pairedBlockDifference(pair, statFn, options);
}

function usePairedBlocks(
  a: number[],
  aOffsets: number[] | undefined,
  b: number[],
  bOffsets: number[] | undefined,
): boolean {
  if (!aOffsets || !bOffsets) {
    throw new Error(
      "Batched comparison requires batch offsets on both baseline and current",
    );
  }
  validatePairedOffsets(a, aOffsets, b, bOffsets);
  return aOffsets.length >= 2;
}

/** Block-bootstrap difference CI for one stat. */
function blockDiff(
  a: number[],
  aOffsets: number[],
  b: number[],
  bOffsets: number[],
  stat: StatKind,
  options: BlockDiffOptions,
): DifferenceCI {
  const fn = statKindToFn(stat);
  return pairedBlockDifferenceCI(a, aOffsets, b, bOffsets, fn, options);
}

function validatePairedOffsets(
  a: number[],
  aOffsets: number[],
  b: number[],
  bOffsets: number[],
): void {
  validateOffsets("baseline", a, aOffsets);
  validateOffsets("current", b, bOffsets);
  if (aOffsets.length !== bOffsets.length) {
    throw new Error(
      `Batched comparison requires aligned batch counts: baseline has ${aOffsets.length}, current has ${bOffsets.length}`,
    );
  }
}

function pairedSide(
  fullSplits: number[][],
  cap: number,
  rand: Rand,
): PairedSide {
  const batchOffsets: number[] = [];
  let offset = 0;
  for (const split of fullSplits) {
    batchOffsets.push(offset);
    offset += split.length;
  }
  return {
    filtered: fullSplits.flat(),
    fullSplits,
    keptSplits: capSplits(fullSplits, cap, rand),
    batchOffsets,
  };
}

/** One paired draw: pick the same batch index k for both sides each round (the
 *  pairing that cancels shared per-round drift), pool, return the percent delta. */
function pairedPoolDiff(
  pair: PreparedPairedBlocks,
  baseBuf: number[],
  curBuf: number[],
  statFn: (s: number[]) => number,
  rand: Rand,
): number {
  const n = pair.pairCount;
  let basePos = 0;
  let curPos = 0;
  for (let i = 0; i < n; i++) {
    const k = Math.floor(rand() * n);
    basePos = appendBlock(pair.baseline.keptSplits[k], baseBuf, basePos);
    curPos = appendBlock(pair.current.keptSplits[k], curBuf, curPos);
  }
  const base = statFn(filledBuf(baseBuf, basePos));
  return ((statFn(filledBuf(curBuf, curPos)) - base) / base) * 100;
}

function validateOffsets(
  label: "baseline" | "current",
  samples: number[],
  offsets: number[],
): void {
  if (!offsets.length) {
    throw new Error(
      `Invalid ${label} batch offsets: expected at least one offset`,
    );
  }
  if (offsets[0] !== 0) {
    throw new Error(`Invalid ${label} batch offsets: first offset must be 0`);
  }
  for (let i = 0; i < offsets.length; i++) {
    const offset = offsets[i];
    if (!Number.isInteger(offset) || offset < 0 || offset >= samples.length) {
      throw new Error(
        `Invalid ${label} batch offsets: offset ${offset} is outside samples`,
      );
    }
    if (i > 0 && offset <= offsets[i - 1]) {
      throw new Error(
        `Invalid ${label} batch offsets: offsets must be strictly increasing`,
      );
    }
  }
}
