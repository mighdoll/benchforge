/**
 * Permutation-based hypothesis testing for benchmark comparisons.
 * Currently unused -- the reporting pipeline uses blockDifferenceCI() instead,
 * which provides confidence intervals rather than p-values.
 */

import { average, bootstrapSamples, median } from "./StatisticalUtils.ts";

/** Statistical comparison between baseline and current benchmark samples */
export interface ComparisonResult {
  baselineMedian: number;
  currentMedian: number;
  baselineMean: number;
  currentMean: number;

  medianChange: {
    absolute: number;
    percent: number;
    pValue: number;
    significant: boolean;
    significance: "strong" | "good" | "weak" | "none";
  };

  meanChange: {
    absolute: number;
    percent: number;
    pValue: number;
    significant: boolean;
    significance: "strong" | "good" | "weak" | "none";
  };
}

const significanceThreshold = 0.05;
const strongSignificance = 0.001;
const goodSignificance = 0.01;

/** @return statistical comparison between baseline and current samples */
export function compareWithBaseline(
  baseline: number[],
  current: number[],
): ComparisonResult {
  const baselineMedian = median(baseline);
  const currentMedian = median(current);
  const baselineMean = average(baseline);
  const currentMean = average(current);

  const medianPValue = bootstrapDifferenceTest(baseline, current, median);
  const meanPValue = bootstrapDifferenceTest(baseline, current, average);

  return {
    baselineMedian,
    currentMedian,
    baselineMean,
    currentMean,
    medianChange: changeStats(currentMedian, baselineMedian, medianPValue),
    meanChange: changeStats(currentMean, baselineMean, meanPValue),
  };
}

/** @return p-value from permutation test for difference in statistics */
function bootstrapDifferenceTest(
  sample1: number[],
  sample2: number[],
  statistic: (samples: number[]) => number,
): number {
  const observedDiff = statistic(sample2) - statistic(sample1);
  const combined = [...sample1, ...sample2];
  const n1 = sample1.length;

  let moreExtreme = 0;
  for (let i = 0; i < bootstrapSamples; i++) {
    const { resample1, resample2 } = shuffleAndSplit(combined, n1);
    const diff = statistic(resample2) - statistic(resample1);
    if (Math.abs(diff) >= Math.abs(observedDiff)) moreExtreme++;
  }
  return moreExtreme / bootstrapSamples;
}

/** @return change statistics for a current vs baseline comparison */
function changeStats(current: number, base: number, pValue: number) {
  return {
    absolute: current - base,
    percent: ((current - base) / base) * 100,
    pValue,
    significant: pValue < significanceThreshold,
    significance: getSignificance(pValue),
  };
}

/** @return randomly shuffled samples split at n1 (Fisher-Yates shuffle) */
function shuffleAndSplit(combined: number[], n1: number) {
  const shuffled = [...combined];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return { resample1: shuffled.slice(0, n1), resample2: shuffled.slice(n1) };
}

/** @return significance level based on p-value thresholds */
function getSignificance(pValue: number): "strong" | "good" | "weak" | "none" {
  if (pValue < strongSignificance) return "strong";
  if (pValue < goodSignificance) return "good";
  if (pValue < significanceThreshold) return "weak";
  return "none";
}
