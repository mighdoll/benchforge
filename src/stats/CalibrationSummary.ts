import { mean, percentile, standardDeviation } from "./StatisticalUtils.ts";

/** Noise-floor summary from repeated current-vs-current comparisons. */
export interface CalibrationSummary {
  /** Mean of per-run point estimates; expected ~0 for a true-zero signal. */
  meanPoint: number;
  /** Standard deviation of per-run point estimates. */
  scatterStd: number;
  /** 95th percentile of |point estimate| across runs (drives the margin). */
  scatterP95: number;
  /** Mean within-run CI half-width (what the bootstrap claims). */
  meanCiHalfWidth: number;
  /** Recommended --equiv-margin: max(scatterP95, meanCiHalfWidth), rounded up. */
  suggestedMargin: number;
  /** True when between-run scatter exceeds the within-run CI: per-run CIs
   *  understate run-to-run noise (systematic error the bootstrap can't see). */
  overconfident: boolean;
}

/** Summarize repeated self-comparison runs into a noise floor and margin.
 *
 *  Two independent estimates of the floor: the within-run CI half-width
 *  (`meanCiHalfWidth`) and the between-run scatter of point estimates
 *  (`scatterP95`). The margin is the larger, so the self-comparison reads
 *  "equivalent" essentially always. */
export function summarizeCalibration(
  pointEstimates: number[],
  ciHalfWidths: number[],
): CalibrationSummary {
  const meanPoint = mean(pointEstimates);
  const scatterStd = standardDeviation(pointEstimates);
  const scatterP95 = percentile(pointEstimates.map(Math.abs), 0.95);
  const meanCiHalfWidth = mean(ciHalfWidths);
  const overconfident = scatterP95 > meanCiHalfWidth;
  const suggestedMargin = roundUpMargin(Math.max(scatterP95, meanCiHalfWidth));
  return {
    meanPoint,
    scatterStd,
    scatterP95,
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
