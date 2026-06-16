import {
  coefficientOfVariation,
  median,
  medianAbsoluteDeviation,
  percentile,
  percentileIndex,
} from "../stats/CoreStats.ts";
import type { MeasuredResults } from "./MeasuredResults.ts";

/** Compute percentiles, CV, MAD, and outlier rate from timing samples. */
export function computeStats(samples: number[]): MeasuredResults["time"] {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  let sum = 0;
  for (const s of samples) {
    if (s < min) min = s;
    if (s > max) max = s;
    sum += s;
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const pct = (p: number) => sorted[percentileIndex(sorted.length, p)];
  return {
    min,
    max,
    avg: sum / samples.length,
    p25: pct(0.25),
    p50: pct(0.5),
    p75: pct(0.75),
    p95: pct(0.95),
    p99: pct(0.99),
    p999: pct(0.999),
    cv: coefficientOfVariation(samples),
    mad: medianAbsoluteDeviation(samples),
    outlierRate: outlierImpactRatio(samples),
  };
}

/** Measure outlier impact as proportion of excess time above 1.5*IQR threshold. */
export function outlierImpactRatio(samples: number[]): number {
  if (samples.length === 0) return 0;
  const med = median(samples);
  const q75 = percentile(samples, 0.75);
  const threshold = med + 1.5 * (q75 - med);

  let excessTime = 0;
  for (const sample of samples) {
    if (sample > threshold) excessTime += sample - med;
  }
  const total = samples.reduce((a, b) => a + b, 0);
  return total > 0 ? excessTime / total : 0;
}

/** @return runtime gc() function, or a no-op if --expose-gc wasn't passed. */
export function gcFunction(): () => void {
  const gc = globalThis.gc ?? (globalThis as any).__gc;
  if (gc) return gc;
  console.warn("gc() not available, run node/bun with --expose-gc");
  return () => {};
}
