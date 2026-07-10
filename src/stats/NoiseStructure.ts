/** Empirical noise-structure diagnostics: quantify how much benchforge's batch
 *  blocking and paired-difference machinery actually buy on real data. Block
 *  value and pairing value are two reads of the same noise autocorrelation
 *  profile at different timescales -- within-batch correlation justifies block
 *  resampling, round-scale correlation justifies pairing. */
import {
  allocPoolBuf,
  type BlockBootstrapOptions,
  blockCI,
  poolResampleStat,
} from "./BlockBootstrap.ts";
import {
  type BlockDiffOptions,
  type PreparedPairedBlocks,
  pairedBlockDifference,
  preparePairedBlocks,
} from "./BlockDifference.ts";
import {
  bootstrapSamples,
  computeInterval,
  defaultConfidence,
  defaultRand,
  maxBootstrapInput,
  multiSampleBootstrap,
  type Rand,
} from "./Bootstrap.ts";
import { mean, type StatKind, statKindToFn } from "./CoreStats.ts";

/** Paired vs unpaired-block delta CI widths. ratio < 1 means pairing sharpens
 *  the delta (round-scale shared drift exists); ratio >= 1 means pairing buys
 *  nothing and the lost degrees of freedom make it mildly worse. Both sides use
 *  identical block resampling, so the only difference is the shared resample
 *  index -- isolating pairing from blocking. ratio is non-finite when
 *  unpairedWidth is 0 (constant samples); callers should skip the verdict. */
export interface PairingBenefit {
  pairedWidth: number;
  unpairedWidth: number;
  ratio: number;
  rounds: number;
}

/** Round-level correlation between baseline and current per-round means -- the
 *  covariance pairing cancels. `overall` mixes shared drift (positive) with the
 *  alternating-order effect (negative); the by-order splits hold order constant
 *  so their correlation is shared drift alone. */
export interface RoundPairCorrelation {
  overall: number;
  baselineFirst: number;
  currentFirst: number;
  rounds: number;
}

/** Variance inflation of block resampling over IID: (block CI width / IID CI
 *  width)^2 ~ n / effective-n. Captures total batch-level structure -- both
 *  within-batch autocorrelation and between-batch heterogeneity (drift). ~1
 *  means samples are effectively independent (block resampling is a no-op);
 *  >>1 means it is essential. Pair with the within-batch vs cross-round ACFs to
 *  see which of the two drives the inflation. vif is non-finite when iidWidth
 *  is 0 (constant samples); callers should skip the verdict. */
export interface VarianceInflation {
  blockWidth: number;
  iidWidth: number;
  vif: number;
}

/** Paired vs unpaired-block delta CI widths for one stat. The unpaired draw uses
 *  independent batch indices per side while keeping the same block resampling,
 *  so the ratio isolates the pairing effect from the blocking effect. */
export function pairingBenefit(
  baseline: number[],
  baselineOffsets: number[],
  current: number[],
  currentOffsets: number[],
  statKind: StatKind = "mean",
  options: BlockDiffOptions = {},
): PairingBenefit {
  const rand = options.random ?? defaultRand();
  const pair = preparePairedBlocks(
    baseline,
    baselineOffsets,
    current,
    currentOffsets,
    {
      noTrim: options.noBatchTrim,
      cap: maxBootstrapInput,
      rand,
    },
  );
  const fn = statKindToFn(statKind);
  const paired = pairedBlockDifference(pair, fn, options);
  const pairedWidth = paired.ci[1] - paired.ci[0];

  const diffs = unpairedBlockDiffs(
    pair,
    fn,
    options.resamples ?? bootstrapSamples,
    rand,
  );
  const [lo, hi] = computeInterval(
    diffs,
    options.confidence ?? defaultConfidence,
  );
  const unpairedWidth = hi - lo;

  return {
    pairedWidth,
    unpairedWidth,
    ratio: pairedWidth / unpairedWidth,
    rounds: pair.pairCount,
  };
}

/** Pearson correlation of baseline vs current per-round means, overall and split
 *  by execution order (even original rounds run baseline first, odd run current
 *  first). `firstRound` is the original round index of batch 0 -- pass 1 when the
 *  warmup round was dropped before merging, so order labels stay aligned. */
export function roundPairCorrelation(
  baselineBatches: number[][],
  currentBatches: number[][],
  firstRound = 0,
): RoundPairCorrelation {
  const n = Math.min(baselineBatches.length, currentBatches.length);
  const base = baselineBatches.slice(0, n).map(mean);
  const curr = currentBatches.slice(0, n).map(mean);
  const even = base.map((_, i) => i).filter(i => (i + firstRound) % 2 === 0);
  const odd = base.map((_, i) => i).filter(i => (i + firstRound) % 2 === 1);
  return {
    overall: pearson(base, curr),
    baselineFirst: pearson(
      even.map(i => base[i]),
      even.map(i => curr[i]),
    ),
    currentFirst: pearson(
      odd.map(i => base[i]),
      odd.map(i => curr[i]),
    ),
    rounds: n,
  };
}

/** Compare the block-bootstrap CI width to the plain IID CI width on the same
 *  side. Requires 2+ batches. Forces `noTrim` so block and IID resample the
 *  identical sample set -- the ratio then isolates the resampling-unit effect
 *  (autocorrelation) rather than the batch trimming the production path also
 *  applies (which IID cannot mirror). */
export function varianceInflation(
  samples: number[],
  offsets: number[],
  statKind: StatKind = "mean",
  options: BlockBootstrapOptions = {},
): VarianceInflation {
  const block = blockCI(samples, offsets, statKind, {
    ...options,
    noTrim: true,
  });
  const iid = multiSampleBootstrap(samples, [statKind], options)[0];
  const blockWidth = block.ci[1] - block.ci[0];
  const iidWidth = iid.ci[1] - iid.ci[0];
  return { blockWidth, iidWidth, vif: (blockWidth / iidWidth) ** 2 };
}

/** Autocorrelation of per-round means at lags 1..maxLag. Near zero at all lags
 *  means no multi-round drift -- the premise pairing relies on is absent. */
export function batchMeanAutocorrelation(
  batches: number[][],
  maxLag = 5,
): number[] {
  return autocorr(batches.map(mean), maxLag);
}

/** Mean within-batch sample autocorrelation at lags 1..maxLag, averaged across
 *  batches. Drops the first `dropWarmup` fraction of each batch then linearly
 *  detrends the rest, so the JIT/heap warmup ramp isn't mistaken for noise
 *  correlation (a ramp shows up as a near-flat positive ACF across all lags).
 *  Decay within a few lags (<< batch size) is the sub-batch noise the block
 *  bootstrap handles. */
export function withinBatchAutocorrelation(
  batches: number[][],
  maxLag = 5,
  dropWarmup = 0.2,
): number[] {
  const sums = new Array<number>(maxLag).fill(0);
  const counts = new Array<number>(maxLag).fill(0);
  for (const b of batches) {
    const acf = autocorr(
      detrend(b.slice(Math.floor(b.length * dropWarmup))),
      maxLag,
    );
    for (let k = 0; k < acf.length; k++) {
      sums[k] += acf[k];
      counts[k]++;
    }
  }
  return sums.map((s, k) => (counts[k] ? s / counts[k] : 0));
}

/** One unpaired-block draw per side: independent batch indices (vs the shared
 *  index in the paired path), so the delta variance keeps var_b + var_c with no
 *  -2*cov pairing term. */
function unpairedBlockDiffs(
  pair: PreparedPairedBlocks,
  statFn: (s: number[]) => number,
  resamples: number,
  rand: Rand,
): number[] {
  const baseSplits = pair.baseline.keptSplits;
  const curSplits = pair.current.keptSplits;
  const baseBuf = allocPoolBuf(baseSplits);
  const curBuf = allocPoolBuf(curSplits);
  return Array.from({ length: resamples }, () => {
    const base = poolResampleStat(baseSplits, baseBuf, statFn, rand);
    const curr = poolResampleStat(curSplits, curBuf, statFn, rand);
    return ((curr - base) / base) * 100;
  });
}

/** Pearson correlation; 0 when either series is constant or shorter than 2. */
function pearson(x: number[], y: number[]): number {
  const n = Math.min(x.length, y.length);
  if (n < 2) return 0;
  const mx = mean(x);
  const my = mean(y);
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = x[i] - mx;
    const dy = y[i] - my;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }
  const denom = Math.sqrt(sxx * syy);
  return denom === 0 ? 0 : sxy / denom;
}

/** Biased autocorrelation at lags 1..maxLag, normalized by the lag-0 variance.
 *  Empty for a series shorter than 2; zeros for a constant series. */
function autocorr(series: number[], maxLag: number): number[] {
  const m = series.length;
  const lags = Math.min(maxLag, m - 1);
  if (lags < 1) return [];
  const avg = mean(series);
  let denom = 0;
  for (const x of series) denom += (x - avg) ** 2;
  const out = new Array<number>(lags);
  for (let k = 1; k <= lags; k++) {
    let num = 0;
    for (let i = 0; i + k < m; i++)
      num += (series[i] - avg) * (series[i + k] - avg);
    out[k - 1] = denom === 0 ? 0 : num / denom;
  }
  return out;
}

/** Remove the least-squares linear trend from a series (a constant warmup ramp
 *  would otherwise read as positive autocorrelation at every lag). */
function detrend(series: number[]): number[] {
  const m = series.length;
  if (m < 3) return series;
  const mx = (m - 1) / 2;
  const my = mean(series);
  let sxy = 0;
  let sxx = 0;
  for (let i = 0; i < m; i++) {
    const dx = i - mx;
    sxy += dx * (series[i] - my);
    sxx += dx * dx;
  }
  const slope = sxx === 0 ? 0 : sxy / sxx;
  return series.map((v, i) => v - (my + slope * (i - mx)));
}
