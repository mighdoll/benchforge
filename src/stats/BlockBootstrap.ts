import {
  type BootstrapOptions,
  type BootstrapResult,
  bootstrapSamples,
  computeInterval,
  createResample,
  defaultConfidence,
  maxBootstrapInput,
  multiSampleBootstrap,
  subsample,
} from "./Bootstrap.ts";
import {
  isBootstrappable,
  mean,
  median,
  percentile,
  type StatKind,
  statKindToFn,
} from "./CoreStats.ts";

/** Bootstrap options that also accept batch-trim control. */
export type BlockBootstrapOptions = BootstrapOptions & {
  /** Disable Tukey trimming of outlier batches */
  noTrim?: boolean;
};

/** Trimmed-and-split blocks for one side: per-block stat values, the pooled
 *  kept samples, how many batches were trimmed, and the per-batch arrays.
 *  When a `cap` is applied, `keptSplits`/`blockVals` are the capped resample
 *  source (bounding per-draw cost) while `filtered` stays the full kept pool so
 *  the point estimate `statFn(filtered)` remains exact. */
export type PreparedBlocks = {
  blockVals: number[];
  filtered: number[];
  trimCount: number;
  keptSplits: number[][];
};

const outlierMultiplier = 1.5;

/** Bootstrap CIs for multiple stats, dispatching block vs sample automatically.
 *  Returns undefined for non-bootstrappable stats (min/max). */
export function bootstrapCIs(
  samples: number[],
  batchOffsets: number[] | undefined,
  stats: StatKind[],
  options?: BlockBootstrapOptions,
): (BootstrapResult | undefined)[] {
  const supportedStats = stats.filter(isBootstrappable);
  if (supportedStats.length === 0) return stats.map(() => undefined);

  const hasBlocks = (batchOffsets?.length ?? 0) >= 2;
  const results = hasBlocks
    ? supportedStats.map(s => blockCI(samples, batchOffsets!, s, options))
    : multiSampleBootstrap(samples, supportedStats, options);

  let resultIdx = 0;
  return stats.map(s =>
    isBootstrappable(s) ? results[resultIdx++] : undefined,
  );
}

/** Block bootstrap CI: optionally Tukey-trim outlier batches, then resample
 *  per-block statFn values as independent observations. Requires 2+ blocks.
 *  Per iteration the readout is `mean(per-batch statFn)`, correct for `mean`
 *  (where `mean(per-batch means) == mean(pool)` for equal-size batches) but
 *  *not* an estimator of `statFn(pool)` for non-linear statFns. Use
 *  {@link blockPoolBootstrap} for percentiles. */
export function blockBootstrap(
  samples: number[],
  blocks: number[],
  statFn: (s: number[]) => number,
  options: BlockBootstrapOptions = {},
): BootstrapResult {
  const { resamples = bootstrapSamples, confidence: conf = defaultConfidence } =
    options;
  const side = prepareBlocks(
    samples,
    blocks,
    statFn,
    options.noTrim,
    maxBootstrapInput,
  );
  const stats = Array.from({ length: resamples }, () =>
    mean(createResample(side.blockVals)),
  );
  return {
    estimate: statFn(side.filtered),
    ci: computeInterval(stats, conf),
    samples: stats,
    ciLevel: "block",
  };
}

/** Block bootstrap CI for non-linear stats: resample whole batches with
 *  replacement, pool their samples, then apply statFn to the pool. Per
 *  iteration the readout is `statFn(pool)`, so the CI describes the same
 *  quantity as the point estimate. Batch-level IID is preserved (samples
 *  within a chosen batch travel together); only the readout differs from
 *  {@link blockBootstrap}. Requires 2+ blocks. */
export function blockPoolBootstrap(
  samples: number[],
  blocks: number[],
  statFn: (s: number[]) => number,
  options: BlockBootstrapOptions = {},
): BootstrapResult {
  const { resamples = bootstrapSamples, confidence: conf = defaultConfidence } =
    options;
  const side = prepareBlocks(
    samples,
    blocks,
    statFn,
    options.noTrim,
    maxBootstrapInput,
  );
  const buf = allocPoolBuf(side.keptSplits);
  const stats = Array.from({ length: resamples }, () =>
    poolResampleStat(side.keptSplits, buf, statFn),
  );
  return {
    estimate: statFn(side.filtered),
    ci: computeInterval(stats, conf),
    samples: stats,
    ciLevel: "block",
  };
}

/** Tukey-trim outlier blocks and compute per-block statistic for one side.
 *  keptSplits exposes the per-batch sample arrays of the kept batches so callers
 *  doing pool-resample bootstrap can reuse the trim work. */
export function prepareBlocks(
  samples: number[],
  offsets: number[],
  fn: (s: number[]) => number,
  noTrim?: boolean,
  cap?: number,
): PreparedBlocks {
  const splits = splitByOffsets(samples, offsets);
  const means = splits.map(mean);
  const keep = noTrim ? means.map((_, i) => i) : tukeyKeep(means);
  const keptSplits = keep.map(i => splits[i]);
  const drawSplits = cap ? capSplits(keptSplits, cap) : keptSplits;
  return {
    blockVals: drawSplits.map(fn),
    filtered: keptSplits.flat(),
    trimCount: means.length - keep.length,
    keptSplits: drawSplits,
  };
}

/** Drop samples from batches whose per-batch mean is a slow-side Tukey outlier.
 *  Pass-through (no copy, trimCount=0) when batches are absent or trimming is off. */
export function trimOutlierBatches(
  samples: number[],
  offsets: number[] | undefined,
  noTrim?: boolean,
): { samples: number[]; trimCount: number } {
  if (noTrim || !offsets || offsets.length < 2) {
    return { samples, trimCount: 0 };
  }
  const splits = splitByOffsets(samples, offsets);
  const means = splits.map(mean);
  const keep = tukeyKeep(means);
  if (keep.length === splits.length) return { samples, trimCount: 0 };
  return {
    samples: keep.flatMap(i => splits[i]),
    trimCount: means.length - keep.length,
  };
}

/** @return Tukey fence bounds [lo, hi] for the given IQR multiplier.
 *  minIqr prevents degenerate fences when values are tightly clustered. */
export function tukeyFences(
  values: number[],
  multiplier = 3,
  minIqr = 0,
): [lo: number, hi: number] {
  const q1 = percentile(values, 0.25);
  const q3 = percentile(values, 0.75);
  const iqr = Math.max(q3 - q1, minIqr);
  return [q1 - multiplier * iqr, q3 + multiplier * iqr];
}

/** @return indices of values below the upper 3x IQR Tukey fence.
 *  Only trims slow outliers (fast batches reflect less environmental noise, not errors).
 *  Floors IQR at 2% of median to avoid over-trimming tightly clustered batch means. */
export function tukeyKeep(values: number[]): number[] {
  if (values.length < 4) return values.map((_, i) => i);
  const minIqr = median(values) * 0.02;
  const [, hi] = tukeyFences(values, 3, minIqr);
  return values.flatMap((v, i) => (v <= hi ? [i] : []));
}

/** @return outliers detected via Tukey's interquartile range method */
export function findOutliers(samples: number[]): {
  rate: number;
  indices: number[];
} {
  const [lo, hi] = tukeyFences(samples, outlierMultiplier);
  const indices = samples.flatMap((v, i) => (v < lo || v > hi ? [i] : []));
  return { rate: indices.length / samples.length, indices };
}

/** @return samples split into blocks by offset boundaries */
export function splitByOffsets(
  samples: number[],
  offsets: number[],
): number[][] {
  return offsets.map((start, i) => {
    const end = i + 1 < offsets.length ? offsets[i + 1] : samples.length;
    return samples.slice(start, end);
  });
}

/** Allocate a worst-case buffer for pool-resample draws over `splits`. */
export function allocPoolBuf(splits: number[][]): number[] {
  let maxBlock = 0;
  for (const b of splits) if (b.length > maxBlock) maxBlock = b.length;
  return new Array<number>(splits.length * maxBlock);
}

/** One pool-resample draw: pick blocks with replacement, concat into buf, apply statFn. */
export function poolResampleStat(
  splits: number[][],
  buf: number[],
  statFn: (s: number[]) => number,
): number {
  const n = splits.length;
  let pos = 0;
  for (let i = 0; i < n; i++) {
    const block = splits[Math.floor(Math.random() * n)];
    for (let k = 0; k < block.length; k++) buf[pos++] = block[k];
  }
  return statFn(pos === buf.length ? buf : buf.slice(0, pos));
}

/** Block bootstrap CI for one stat: mean uses per-batch means, percentiles pool
 *  the resampled batches. Mirrors {@link blockDiff} on the difference side. */
function blockCI(
  samples: number[],
  blocks: number[],
  stat: StatKind,
  options?: BlockBootstrapOptions,
): BootstrapResult {
  const fn = statKindToFn(stat);
  if (stat === "mean") return blockBootstrap(samples, blocks, fn, options);
  return blockPoolBootstrap(samples, blocks, fn, options);
}

/** Subsample each batch (without replacement) so the pooled draw size stays
 *  within `cap`, keeping every batch represented to preserve batch-level IID.
 *  Bounds the per-resample cost for large sample counts, mirroring the
 *  single-sample path's `subsample` cap. */
function capSplits(splits: number[][], cap: number): number[][] {
  const total = splits.reduce((n, b) => n + b.length, 0);
  if (total <= cap) return splits;
  const perBatch = Math.max(1, Math.floor(cap / splits.length));
  return splits.map(b => subsample(b, perBatch));
}
