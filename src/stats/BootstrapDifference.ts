import type {
  BootstrapResult,
  CIDirection,
  DifferenceCI,
  HistogramBin,
  StatKind,
} from "./StatisticalUtils.ts";
import {
  average,
  bootstrapSamples,
  computeInterval,
  createResample,
  defaultConfidence,
  isBootstrappable,
  maxBootstrapInput,
  maxOf,
  minOf,
  percentile,
  prepareBlocks,
  quickSelect,
  resampleInto,
  statKindToFn,
  subsample,
} from "./StatisticalUtils.ts";

/** Options for blockDifferenceCI (extends DiffOptions with block parameters) */
export type BlockDiffOptions = DiffOptions & {
  /** Block boundaries for the second sample array (defaults to blocksA) */
  blocksB?: number[];
  /** Disable Tukey trimming of outlier batches */
  noBatchTrim?: boolean;
};

/** Options for difference CI functions */
type DiffOptions = {
  /** Number of bootstrap resamples (default: 10000) */
  resamples?: number;
  /** Confidence level 0-1 (default: 0.95) */
  confidence?: number;
  /** Equivalence margin in percent. CI within [-margin, +margin] ==> "equivalent" */
  equivMargin?: number;
};

type BinnedCI = {
  estimate: number;
  ci: [number, number];
  histogram: HistogramBin[];
};

interface DiffOp {
  origIndex: number;
  execIndex: number;
  computeA: (buf: number[]) => number;
  computeB: (buf: number[]) => number;
  pointEstimate: (s: number[]) => number;
}

/** @return sample-level bootstrap CI for percentage difference between baseline (a) and current (b). */
export function sampleDifferenceCI(
  a: number[],
  b: number[],
  statFn: (s: number[]) => number,
  options: DiffOptions = {},
): DifferenceCI {
  const { resamples = bootstrapSamples, confidence: conf = defaultConfidence } =
    options;
  const baseVal = statFn(a);
  const currVal = statFn(b);
  const observedPct = ((currVal - baseVal) / baseVal) * 100;

  const subA = subsample(a, maxBootstrapInput);
  const subB = subsample(b, maxBootstrapInput);
  const bufA = new Array(subA.length);
  const bufB = new Array(subB.length);
  const diffs = Array.from({ length: resamples }, () => {
    resampleInto(subA, bufA);
    resampleInto(subB, bufB);
    const base = statFn(bufA);
    return ((statFn(bufB) - base) / base) * 100;
  });
  const ci = computeInterval(diffs, conf);
  const capped = subA !== a || subB !== b;
  return {
    percent: observedPct,
    ci,
    direction: classifyDirection(ci, observedPct, options.equivMargin),
    histogram: binValues(diffs),
    ciLevel: "sample",
    ...(capped && { subsampled: Math.max(a.length, b.length) }),
  };
}

/** Shared-resample difference CI: one resample pair per iteration, all stats computed.
 *  @return DifferenceCI[] in same order as input stats. */
export function multiSampleDifferenceCI(
  a: number[],
  b: number[],
  stats: StatKind[],
  options: DiffOptions = {},
): DifferenceCI[] {
  const { resamples = bootstrapSamples, confidence: conf = defaultConfidence } =
    options;
  const subA = subsample(a, maxBootstrapInput);
  const subB = subsample(b, maxBootstrapInput);
  const bufA = new Array(subA.length);
  const bufB = new Array(subB.length);
  const ops = buildDiffOps(stats, subA.length, subB.length);
  const allDiffs = ops.map(() => new Array<number>(resamples));

  // Point estimates from original data
  const baseVals = ops.map(op => op.pointEstimate(a));
  const currVals = ops.map(op => op.pointEstimate(b));
  const observedPcts = ops.map(
    (_, j) => ((currVals[j] - baseVals[j]) / baseVals[j]) * 100,
  );

  for (let i = 0; i < resamples; i++) {
    resampleInto(subA, bufA);
    resampleInto(subB, bufB);
    for (let j = 0; j < ops.length; j++) {
      const base = ops[j].computeA(bufA);
      const curr = ops[j].computeB(bufB);
      allDiffs[j][i] = ((curr - base) / base) * 100;
    }
  }

  const capped = subA !== a || subB !== b;
  const results = new Array<DifferenceCI>(stats.length);
  for (const op of ops) {
    const j = op.execIndex;
    const ci = computeInterval(allDiffs[j], conf);
    results[op.origIndex] = {
      percent: observedPcts[j],
      ci,
      direction: classifyDirection(ci, observedPcts[j], options.equivMargin),
      histogram: binValues(allDiffs[j]),
      ciLevel: "sample",
      ...(capped && { subsampled: Math.max(a.length, b.length) }),
    };
  }
  return results;
}

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
  const bsStats = stats.filter(isBootstrappable);
  if (bsStats.length === 0) return stats.map(() => undefined);

  const hasBlocks =
    (aOffsets?.length ?? 0) >= 2 && (bOffsets?.length ?? 0) >= 2;
  const bsResults = hasBlocks
    ? bsStats.map(s =>
        blockDifferenceCI(a, aOffsets!, b, statKindToFn(s), {
          ...options,
          blocksB: bOffsets!,
        }),
      )
    : multiSampleDifferenceCI(a, b, bsStats, options);

  const results: (DifferenceCI | undefined)[] = new Array(stats.length);
  let bi = 0;
  for (let i = 0; i < stats.length; i++) {
    results[i] = isBootstrappable(stats[i]) ? bsResults[bi++] : undefined;
  }
  return results;
}

/** @return block bootstrap CI for percentage difference between baseline (a) and current (b).
 *  Tukey-trims outlier batches, then resamples per-block statFn values. Requires 2+ blocks. */
export function blockDifferenceCI(
  a: number[],
  blocksA: number[],
  b: number[],
  statFn: (s: number[]) => number,
  options: BlockDiffOptions = {},
): DifferenceCI {
  const { resamples = bootstrapSamples, confidence: conf = defaultConfidence } =
    options;
  const bB = options.blocksB ?? blocksA;
  const noTrim = options.noBatchTrim;
  const sideA = prepareBlocks(a, blocksA, statFn, noTrim);
  const sideB = prepareBlocks(b, bB, statFn, noTrim);

  const baseVal = statFn(sideA.filtered);
  const currVal = statFn(sideB.filtered);
  const observedPct = ((currVal - baseVal) / baseVal) * 100;

  const drawA = () => average(createResample(sideA.blockVals));
  const drawB = () => average(createResample(sideB.blockVals));
  const diffs = Array.from({ length: resamples }, () => {
    const base = drawA();
    return ((drawB() - base) / base) * 100;
  });
  const ci = computeInterval(diffs, conf);
  return {
    percent: observedPct,
    ci,
    direction: classifyDirection(ci, observedPct, options.equivMargin),
    histogram: binValues(diffs),
    trimmed: [sideA.trimCount, sideB.trimCount],
    ciLevel: "block",
  };
}

/** @return binned CI with histogram from a BootstrapResult */
export function binBootstrapResult(result: BootstrapResult): BinnedCI {
  const { estimate, ci, samples } = result;
  return { estimate, ci, histogram: binValues(samples) };
}

/** @return CI direction, with optional equivalence margin (in percent) */
function classifyDirection(
  ci: [number, number],
  observed: number,
  margin?: number,
): CIDirection {
  const withinMargin =
    margin != null && margin > 0 && ci[0] >= -margin && ci[1] <= margin;
  if (withinMargin) return "equivalent";
  const excludesZero = ci[0] > 0 || ci[1] < 0;
  if (excludesZero) return observed < 0 ? "faster" : "slower";
  return "uncertain";
}

/** @return values binned into histogram for compact visualization */
function binValues(values: number[], binCount = 30): HistogramBin[] {
  let min = values[0];
  let max = values[0];
  for (let i = 1; i < values.length; i++) {
    if (values[i] < min) min = values[i];
    if (values[i] > max) max = values[i];
  }
  if (min === max) return [{ x: min, count: values.length }];

  const step = (max - min) / binCount;
  const counts = new Array(binCount).fill(0);
  for (const v of values) {
    const bin = Math.min(Math.floor((v - min) / step), binCount - 1);
    counts[bin]++;
  }
  return counts.map((count, i) => ({ x: min + (i + 0.5) * step, count }));
}

/** Build diff operations: mean/min/max first (non-destructive), then percentiles ascending.
 *  Each side (A, B) gets its own quickSelect k values since sample sizes may differ. */
function buildDiffOps(stats: StatKind[], nA: number, nB: number): DiffOp[] {
  const uniform = (order: number, i: number, fn: (s: number[]) => number) => ({
    order,
    origIndex: i,
    execIndex: 0,
    computeA: fn,
    computeB: fn,
    pointEstimate: fn,
  });
  const entries = stats.map((s, i) => {
    if (s === "mean") return uniform(-3, i, average);
    if (s === "min") return uniform(-2, i, minOf);
    if (s === "max") return uniform(-1, i, maxOf);
    const p = s.percentile;
    const kA = Math.max(0, Math.ceil(nA * p) - 1);
    const kB = Math.max(0, Math.ceil(nB * p) - 1);
    return {
      order: p,
      origIndex: i,
      execIndex: 0,
      computeA: (buf: number[]) => quickSelect(buf, kA),
      computeB: (buf: number[]) => quickSelect(buf, kB),
      pointEstimate: (v: number[]) => percentile(v, p),
    };
  });
  entries.sort((a, b) => a.order - b.order);
  for (let i = 0; i < entries.length; i++) entries[i].execIndex = i;
  return entries;
}
