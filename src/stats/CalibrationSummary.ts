import { mean, standardDeviation } from "./CoreStats.ts";

/** Noise-floor summary from repeated current-vs-current comparisons. */
export interface CalibrationSummary {
  /** Mean of per-run point estimates; expected ~0 for a true-zero signal. */
  meanPoint: number;

  /** Standard deviation of per-run point estimates. */
  scatterStd: number;

  /** Parametric 95% between-run half-width (`z95 * scatterStd`), estimated from
   *  all runs rather than the single worst one. Drives the margin. */
  scatterHalfWidth: number;

  /** Mean within-run CI half-width (what the bootstrap claims). */
  meanCiHalfWidth: number;

  /** Recommended --equiv-margin: max(|meanPoint| + scatterHalfWidth,
   *  meanCiHalfWidth), rounded up. */
  suggestedMargin: number;

  /** True when between-run scatter exceeds the within-run CI: per-run CIs
   *  understate run-to-run noise (systematic error the bootstrap can't see). */
  overconfident: boolean;
}

/** Two-sided 95% normal multiplier: a centered normal keeps 95% of its mass
 *  within +/-1.96 sigma, so `z95 * scatterStd` is the between-run twin of the
 *  within-run 95% CI half-width. Bump to 2.0 (or a small-sample t multiplier)
 *  for a wider, more conservative band. */
const z95 = 1.96;

/** Summarize repeated self-comparison runs into a noise floor and margin.
 *
 *  Two independent estimates of the floor, both expressed as 95% half-widths:
 *  the within-run CI half-width (`meanCiHalfWidth`) and the between-run scatter
 *  (`scatterHalfWidth = z95 * scatterStd`). `overconfident` compares the two
 *  spreads; the margin takes the larger and folds in any residual bias
 *  (`meanPoint`), so the self-comparison reads "equivalent" essentially always. */
export function summarizeCalibration(
  pointEstimates: number[],
  ciHalfWidths: number[],
): CalibrationSummary {
  const meanPoint = mean(pointEstimates);
  const scatterStd = standardDeviation(pointEstimates);
  const scatterHalfWidth = z95 * scatterStd;
  const meanCiHalfWidth = mean(ciHalfWidths);
  const overconfident = scatterHalfWidth > meanCiHalfWidth;
  const margin = Math.max(
    Math.abs(meanPoint) + scatterHalfWidth,
    meanCiHalfWidth,
  );
  const suggestedMargin = roundUpMargin(margin);
  return {
    meanPoint,
    scatterStd,
    scatterHalfWidth,
    meanCiHalfWidth,
    suggestedMargin,
    overconfident,
  };
}

/** Round a percentage up to a tidy margin: nearest 0.1 below 1%, else 0.5.
 *  The epsilon keeps an exact multiple (e.g. 0.5) from rounding up a step
 *  due to floating-point error. */
function roundUpMargin(pct: number): number {
  const step = pct < 1 ? 0.1 : 0.5;
  const steps = Math.ceil(pct / step - 1e-9);
  return Math.round(steps * step * 1e6) / 1e6;
}
