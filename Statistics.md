# Statistical Methods in Benchforge

## Overview

Benchforge uses robust statistics designed for JavaScript performance data, which exhibits:
- Right-skewed distributions (occasional slow iterations from GC/OS interrupts)
- Non-stationarity (JIT warmup, memory pressure changes)
- Multimodality (normal vs GC-affected iterations)

## Active Features

These are shown in default output or conditionally with flags.

### Percentiles (`StatisticalUtils.ts`)
Nearest-rank method for p25, p50 (median), p75, p95, p99, p999:
```typescript
function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.ceil(sorted.length * p) - 1;
  return sorted[Math.max(0, index)];
}
```
Terminal reports show p50 and p99. The viewer and JSON export include p50, p75, p99, p999.

### Bootstrap Difference CI (`bootstrapDifferenceCI`)
Shown in terminal and HTML reports when a baseline is present.

**Algorithm:**
1. For each of 10,000 iterations:
   - Resample baseline with replacement → compute median_B
   - Resample current with replacement → compute median_C
   - Store: `(median_C - median_B) / median_B × 100`
2. CI = [2.5th percentile, 97.5th percentile] of differences

**Output:**
- `percent`: Observed % difference
- `ci`: 95% confidence interval on the difference
- `direction`: "faster" | "slower" | "uncertain" (based on whether CI excludes zero)

**Display format:** `+2.5% [-1.2%, +6.1%]` (colored green/red/gray)

### Why CI Instead of P-values
The CI approach is more informative for benchmarks:
- Shows magnitude AND significance (if CI excludes zero → significant)
- Users care about "how much faster" not just "is it different"
- A tiny change can be "significant" with enough samples but not actionable

Note: `PermutationTest.ts` contains an unused permutation test implementation
that computes p-values instead of CIs, kept for potential future use.

## Internal-Only Statistics

These are computed but not displayed to users. They exist for internal use
by the adaptive sampling algorithm or as building blocks for other stats.

- **MAD** (Median Absolute Deviation): Robust alternative to standard deviation
- **CV** (Coefficient of Variation): σ/μ for relative variability
- **Standard Deviation**: Uses Bessel's correction (n-1 denominator)
- **Outlier Detection**: Tukey's IQR method (Q1 - 1.5×IQR, Q3 + 1.5×IQR)
- **Outlier Impact**: Proportion of excess time in outliers (`excess_time / total_time`), used by adaptive convergence detection

## Experimental: Adaptive Sampling (`AdaptiveWrapper.ts`)

Gated behind the `--adaptive` flag. The algorithm is still being tuned.

### Convergence Detection
Compares two sliding windows of samples to detect stability.

**Window sizes** (scaled to execution time):
| Execution time | Window size |
|----------------|-------------|
| <10μs          | 200 samples |
| <100μs         | 100 samples |
| <1ms           | 50 samples  |
| <10ms          | 30 samples  |
| >10ms          | 20 samples  |

**Stability metrics:**
1. **Median drift**: `|median_recent - median_previous| / median_previous`
2. **Outlier impact drift**: Change in proportion of time spent in outliers

**Convergence criteria:**
- Both drifts < 5% → converged (100% confidence)
- Otherwise → confidence based on how close to threshold

### Timing Parameters
- `minTime`: 1000ms (minimum run time before early termination)
- `maxTime`: 10000ms (hard limit)
- `targetConfidence`: 95% (stop early if reached after minTime)
- `fallbackThreshold`: 80% (accept if reached after minTime)

## Key Files

| File | Purpose |
|------|---------|
| `StatisticalUtils.ts` | Core stats: percentiles, MAD, CV, bootstrap CI |
| `AdaptiveWrapper.ts` | Adaptive sampling with convergence detection |
| `PermutationTest.ts` | Unused permutation test (p-values) |
| `BenchmarkReport.ts` | Terminal table with Δ% CI column |
| `HtmlReport.ts` | Prepares data for HTML reports |
