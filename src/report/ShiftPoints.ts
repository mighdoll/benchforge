import type { MeasuredResults } from "../runners/MeasuredResults.ts";
import { prepareBlocks } from "../stats/BlockBootstrap.ts";
import type { BootstrapResult, DifferenceCI } from "../stats/Bootstrap.ts";
import { mean, percentile, type StatKind } from "../stats/CoreStats.ts";
import type {
  AbsolutePercentile,
  ShiftPercentile,
  ShiftRun,
} from "../viewer/ReportData.ts";
import type { MetricSection, UnknownRecord } from "./BenchmarkReport.ts";
import {
  annotateCI,
  displayDiffCI,
  formatBootstrapCI,
  keptBatchCount,
} from "./CiFormatting.ts";
import { baselineLabel } from "./Formatters.ts";

export interface PointArgs {
  p: number;
  diff: DifferenceCI | undefined;
  curResult: BootstrapResult | undefined;
  baseResult: BootstrapResult | undefined;
  section: MetricSection;
  current: MeasuredResults;
  baseline: MeasuredResults;
  currentMeta: UnknownRecord | undefined;
  baselineMeta: UnknownRecord | undefined;
  baselineName: string | undefined;
  lowBatches: boolean;
  noBatchTrim: boolean | undefined;
  verdict: StatKind;
  currentBlocks?: number[][];
  baselineBlocks?: number[][];
  currentOffsets?: number[];
  baselineOffsets?: number[];
}

/** Per-point inputs for the absolute (baseline-less) shift. One variant only:
 *  its absolute bootstrap for the stat, plus the coverage inputs. */
export interface AbsPointArgs {
  p: number;
  result: BootstrapResult | undefined;
  section: MetricSection;
  current: MeasuredResults;
  currentMeta: UnknownRecord | undefined;
  lowBatches: boolean;
  noBatchTrim: boolean | undefined;
  verdict: StatKind;
}

/** A percentile estimate is reliable when enough samples lie beyond it and
 *  those samples span enough distinct batches. Block bootstrap resamples whole
 *  batches, so a tail living in 1-2 batches swings on which batches are drawn. */
const minTailSamples = 10;
const minTailBatches = 5;

/** @return a short percentile label, e.g. "p50", "p99", "p0.1". */
export function percentileLabel(p: number): string {
  const pct = p * 100;
  const rounded = Math.round(pct * 10) / 10;
  return `p${Number.isInteger(rounded) ? rounded : rounded.toFixed(1)}`;
}

/** @return a short stat label for headlines, e.g. "mean", "p50", "min". */
export function statLabel(kind: StatKind): string {
  if (typeof kind === "string") return kind;
  return percentileLabel(kind.percentile);
}

/** Build one percentile point: flip + annotate the diff, format per-run absolute
 *  distributions, and gate reliability by tail coverage. */
export function buildPoint(args: PointArgs): ShiftPercentile | undefined {
  const { p, section, lowBatches, current, baseline, noBatchTrim } = args;
  const base = buildPointBase(args);
  if (!base) return undefined;

  const curCoverage = tailCoverage(current, p, noBatchTrim, args.currentBlocks);
  const baseCoverage = tailCoverage(
    baseline,
    p,
    noBatchTrim,
    args.baselineBlocks,
  );
  const tailCount = Math.min(curCoverage.count, baseCoverage.count);
  const tailBatches = Math.min(curCoverage.batches, baseCoverage.batches);
  const reliable =
    !lowBatches && tailCount >= minTailSamples && tailBatches >= minTailBatches;

  // displayed percentile mirrors for higherIsBetter (timing p99 == loc/sec p1)
  const displayed = section.higherIsBetter ? 1 - p : p;
  // match the verdict in timing space, before the higherIsBetter mirror
  const isPrimary =
    typeof args.verdict === "object" && args.verdict.percentile === p;
  return {
    ...base,
    isPrimary,
    percentile: displayed,
    label: percentileLabel(displayed),
    reliable,
    tailCount,
    tailBatches,
  };
}

/** Build the leading mean point. Mean uses every sample, so reliability is gated
 *  only by batch count (no tail-coverage check), and tail counts report the full
 *  sample/batch totals. Marked isMean for the renderer's leading-violin slot. */
export function buildMeanPoint(args: PointArgs): ShiftPercentile | undefined {
  const { lowBatches, current, baseline, noBatchTrim } = args;
  const base = buildPointBase(args);
  if (!base) return undefined;

  const currentCount =
    sampleCount(args.currentBlocks) ?? current.samples.length;
  const baselineCount =
    sampleCount(args.baselineBlocks) ?? baseline.samples.length;
  const tailCount = Math.min(currentCount, baselineCount);
  const tailBatches = Math.min(
    args.currentBlocks?.length ?? effectiveBatches(current, noBatchTrim),
    args.baselineBlocks?.length ?? effectiveBatches(baseline, noBatchTrim),
  );
  return {
    ...base,
    isMean: true,
    isPrimary: args.verdict === "mean",
    percentile: 0,
    label: "mean",
    reliable: !lowBatches,
    tailCount,
    tailBatches,
  };
}

/** Build one absolute percentile point: format the variant's absolute
 *  distribution and gate reliability by tail coverage (as {@link buildPoint},
 *  but current-side only since there is no baseline). */
export function buildAbsolutePoint(
  args: AbsPointArgs,
): AbsolutePercentile | undefined {
  const { p, result, section, current, currentMeta, lowBatches } = args;
  if (!result) return undefined;
  const ci = formatBootstrapCI(
    section,
    result,
    current.batchOffsets,
    currentMeta,
  );

  const { count, batches } = tailCoverage(current, p, args.noBatchTrim);
  const reliable =
    !lowBatches && count >= minTailSamples && batches >= minTailBatches;
  const displayed = section.higherIsBetter ? 1 - p : p;
  const isPrimary =
    typeof args.verdict === "object" && args.verdict.percentile === p;
  return {
    isPrimary,
    percentile: displayed,
    label: percentileLabel(displayed),
    ci,
    reliable,
    tailCount: count,
    tailBatches: batches,
  };
}

/** Build the leading mean point for the absolute shift: mean uses every sample,
 *  so reliability is gated only by batch count. */
export function buildAbsoluteMeanPoint(
  args: AbsPointArgs,
): AbsolutePercentile | undefined {
  const { result, section, current, currentMeta, lowBatches } = args;
  if (!result) return undefined;
  const ci = formatBootstrapCI(
    section,
    result,
    current.batchOffsets,
    currentMeta,
  );
  return {
    isMean: true,
    isPrimary: args.verdict === "mean",
    percentile: 0,
    label: "mean",
    ci,
    reliable: !lowBatches,
    tailCount: current.samples.length,
    tailBatches: effectiveBatches(current, args.noBatchTrim),
  };
}

/** Shared point fields: display-domain diff (anchored on the baseline point
 *  estimate) and per-run absolute distributions. */
function buildPointBase(
  args: PointArgs,
): Pick<ShiftPercentile, "diff" | "runs"> | undefined {
  const { diff, curResult, baseResult, section, lowBatches } = args;
  if (!diff || !curResult || !baseResult) return undefined;

  const { current, baseline, currentMeta, baselineMeta } = args;
  const display = displayDiffCI(
    section,
    diff,
    baseResult.estimate,
    baselineMeta,
  );
  const annotated = annotateCI(display, section.title, lowBatches);

  const runCI = (
    r: BootstrapResult,
    m: MeasuredResults,
    meta?: UnknownRecord,
    offsets?: number[],
  ) => formatBootstrapCI(section, r, offsets ?? m.batchOffsets, meta);
  const runs: ShiftRun[] = [
    {
      runName: current.name,
      bootstrapCI: runCI(curResult, current, currentMeta, args.currentOffsets),
    },
    {
      runName: baselineLabel(args.baselineName),
      bootstrapCI: runCI(
        baseResult,
        baseline,
        baselineMeta,
        args.baselineOffsets,
      ),
    },
  ];
  return { diff: annotated, runs };
}

/** @return how many samples lie on the sparse side of the p-th percentile and
 *  how many distinct batches contribute them. The sparse side is whichever end
 *  is closer (lower tail for p<=0.5, upper tail for p>0.5); that count is what
 *  pins the quantile down, so an extreme percentile has a tiny count even with
 *  many samples. Counts only the batches the bootstrap kept (Tukey-trimmed by
 *  per-batch mean unless noBatchTrim), so a trimmed-away slow tail cannot make
 *  a percentile look better supported than the CI it gates. */
function tailCoverage(
  m: MeasuredResults,
  p: number,
  noBatchTrim: boolean | undefined,
  keptBlocks?: number[][],
): { count: number; batches: number } {
  const { samples, batchOffsets } = m;
  const blocks =
    keptBlocks ??
    (batchOffsets && batchOffsets.length >= 2
      ? prepareBlocks(samples, batchOffsets, mean, {
          noTrim: noBatchTrim,
          rand: Math.random,
        }).keptSplits
      : [samples]);
  const threshold = percentile(blocks.flat(), p);
  const inTail =
    p > 0.5 ? (v: number) => v >= threshold : (v: number) => v <= threshold;
  const perBlock = blocks.map(block => block.filter(inTail).length);
  const count = perBlock.reduce((sum, n) => sum + n, 0);
  const batches = perBlock.filter(n => n > 0).length;
  return { count, batches };
}

function sampleCount(blocks: number[][] | undefined): number | undefined {
  return blocks?.reduce((sum, block) => sum + block.length, 0);
}

/** @return distinct batches the bootstrap kept (Tukey-trimmed unless noTrim),
 *  or 1 when there is no batch structure. */
function effectiveBatches(
  m: MeasuredResults,
  noTrim: boolean | undefined,
): number {
  const { batchOffsets } = m;
  if (!batchOffsets || batchOffsets.length < 2) return 1;
  return keptBatchCount(m, noTrim);
}
