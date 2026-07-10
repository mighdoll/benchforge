/** The free A-vs-A experiment inside every A/B run: the baseline batches are all
 *  the same code, so their batch-to-batch spread is pure measurement noise,
 *  sampled in-band at no extra cost. This reads that noise off the baseline
 *  series alone to answer a different question than the verdict CI: was this
 *  run's environment clean enough to trust the verdict? It is context, not a
 *  second significance test. Computed on the same kept batches the verdict uses
 *  (batch 0 already dropped upstream; same Tukey trim) so it can't contradict
 *  the CI it contextualizes. */

import { blockBootstrap, prepareBlocks } from "./BlockBootstrap.ts";
import type { Rand } from "./Bootstrap.ts";
import { mean, standardDeviation } from "./CoreStats.ts";
import { batchMeanAutocorrelation } from "./NoiseStructure.ts";

export interface NoiseFloor {
  /** Baseline mean block-bootstrap CI half-width as % of the mean: the run's
   *  achieved resolution on one side. The difference CI the verdict shows is
   *  ~sqrt(2)x this when both sides have similar variance, so this is a
   *  conservative per-side read of the floor. */
  halfWidthPct: number;

  /** SD of the kept per-batch means over the grand mean, in %: the raw
   *  between-batch scatter that feeds the longitudinal log and drift. */
  dispersionPct: number;

  /** Kept batches after the same drop/trim the verdict uses. Below ~20 the
   *  estimate is itself noisy; callers soften wording accordingly. */
  batches: number;

  /** Second-half minus first-half of the batch means, % of the grand mean:
   *  a simple environment-drift read (non-zero => the environment moved mid-run,
   *  which is also exactly when interleaving/pairing earns its keep). */
  driftPct: number;

  /** Lag-1 autocorrelation of the per-batch means: multi-round drift structure,
   *  carried for the log (0 when too few batches). */
  crossRoundAcf: number;
}

/** Read the noise floor off a baseline series. Requires 2+ batches; returns
 *  undefined for single-batch or absent-offset runs (nothing to read). */
export function noiseFloor(
  samples: number[],
  offsets: number[] | undefined,
  noTrim?: boolean,
  random: Rand = Math.random,
): NoiseFloor | undefined {
  if (!offsets || offsets.length < 2) return undefined;
  // no cap, so blockVals are the kept per-batch means and rand is never drawn
  const side = prepareBlocks(samples, offsets, mean, { noTrim, rand: random });
  const batchMeans = side.blockVals;
  if (batchMeans.length < 2) return undefined;

  const grand = mean(batchMeans);
  if (grand <= 0) return undefined;

  const { ci } = blockBootstrap(samples, offsets, mean, {
    noTrim,
    random,
  });
  const acf = batchMeanAutocorrelation(side.keptSplits);
  return {
    halfWidthPct: ((ci[1] - ci[0]) / 2 / grand) * 100,
    dispersionPct: (standardDeviation(batchMeans) / grand) * 100,
    batches: batchMeans.length,
    driftPct: (halfSplitDrift(batchMeans) / grand) * 100,
    crossRoundAcf: acf[0] ?? 0,
  };
}

/** Mean of the second half minus mean of the first half of the batch means. A
 *  monotone environment drift shows up here even when per-batch scatter hides
 *  it; unlike the lag-1 ACF it keeps the sign (which way the environment moved). */
function halfSplitDrift(means: number[]): number {
  const mid = Math.floor(means.length / 2);
  const first = means.slice(0, mid);
  const second = means.slice(mid);
  if (!first.length || !second.length) return 0;
  return mean(second) - mean(first);
}
