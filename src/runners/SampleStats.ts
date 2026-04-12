import {
  coefficientOfVariation,
  median,
  medianAbsoluteDeviation,
  percentile,
} from "../stats/StatisticalUtils.ts";
import {
  type MeasuredResults,
  type OptStatusInfo,
  optStatusNames,
} from "./MeasuredResults.ts";

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
  const pct = (p: number) =>
    sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)];
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

/** Group samples by V8 optimization tier and count deopts. */
export function analyzeOptStatus(
  samples: number[],
  statuses: number[],
): OptStatusInfo | undefined {
  if (statuses.length === 0 || statuses[0] === undefined) return undefined;

  const byStatus = new Map<number, number[]>();
  let deoptCount = 0;
  for (let i = 0; i < samples.length; i++) {
    const status = statuses[i];
    if (status === undefined) continue;
    if (status & 8) deoptCount++; // deopt flag (bit 3)
    const group = byStatus.get(status);
    if (group) group.push(samples[i]);
    else byStatus.set(status, [samples[i]]);
  }

  const entries = [...byStatus].map(([status, times]) => {
    const name = optStatusNames[status] || `status=${status}`;
    return [name, { count: times.length, medianMs: median(times) }] as const;
  });
  return { byTier: Object.fromEntries(entries), deoptCount };
}

/** @return runtime gc() function, or a no-op if --expose-gc wasn't passed. */
export function gcFunction(): () => void {
  const gc = globalThis.gc ?? (globalThis as any).__gc;
  if (gc) return gc;
  console.warn("gc() not available, run node/bun with --expose-gc");
  return () => {};
}

/** @return function that reads V8 optimization status via %GetOptimizationStatus. */
export function createOptStatusGetter(): ((fn: unknown) => number) | undefined {
  try {
    // %GetOptimizationStatus returns a bitmask
    const fn = new Function("f", "return %GetOptimizationStatus(f)");
    fn(() => {});
    return fn as (fn: unknown) => number;
  } catch {
    return undefined;
  }
}
