import type { MeasuredResults } from "../runners/MeasuredResults.ts";
import { prepareBlocks } from "../stats/BlockBootstrap.ts";
import {
  type BootstrapResult,
  type DifferenceCI,
  flipCI,
} from "../stats/Bootstrap.ts";
import { mean, percentile, type StatKind } from "../stats/CoreStats.ts";
import type { ShiftPercentile, ShiftRun } from "../viewer/ReportData.ts";
import type { MetricSection, UnknownRecord } from "./BenchmarkReport.ts";
import {
  annotateCI,
  formatBootstrapCI,
  keptBatchCount,
} from "./CiFormatting.ts";

interface PointArgs {
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

  const curCoverage = tailCoverage(current, p, noBatchTrim);
  const baseCoverage = tailCoverage(baseline, p, noBatchTrim);
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

  const tailCount = Math.min(current.samples.length, baseline.samples.length);
  const tailBatches = Math.min(
    effectiveBatches(current, noBatchTrim),
    effectiveBatches(baseline, noBatchTrim),
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

/** Shared point fields: flipped+annotated diff and per-run absolute distributions. */
function buildPointBase(
  args: PointArgs,
): Pick<ShiftPercentile, "diff" | "runs"> | undefined {
  const { diff, curResult, baseResult, section, lowBatches } = args;
  if (!diff || !curResult || !baseResult) return undefined;

  const flipped = section.higherIsBetter ? flipCI(diff) : diff;
  const annotated = annotateCI(flipped, section.title, lowBatches);

  const { current, baseline, currentMeta, baselineMeta } = args;
  const runCI = (
    r: BootstrapResult,
    m: MeasuredResults,
    meta?: UnknownRecord,
  ) => formatBootstrapCI(section, r, m.batchOffsets, meta);
  const runs: ShiftRun[] = [
    {
      runName: current.name,
      bootstrapCI: runCI(curResult, current, currentMeta),
    },
    {
      runName: baselineLabel(args.baselineName),
      bootstrapCI: runCI(baseResult, baseline, baselineMeta),
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
): { count: number; batches: number } {
  const { samples, batchOffsets } = m;
  const blocks =
    batchOffsets && batchOffsets.length >= 2
      ? prepareBlocks(samples, batchOffsets, mean, noBatchTrim).keptSplits
      : [samples];
  const threshold = percentile(blocks.flat(), p);
  const inTail =
    p > 0.5 ? (v: number) => v >= threshold : (v: number) => v <= threshold;
  const perBlock = blocks.map(block => block.filter(inTail).length);
  const count = perBlock.reduce((sum, n) => sum + n, 0);
  const batches = perBlock.filter(n => n > 0).length;
  return { count, batches };
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

/** Label the baseline run with its real name, suffixed "(baseline)" unless the
 *  name already carries that suffix; falls back to "baseline" when unnamed. */
function baselineLabel(name: string | undefined): string {
  if (!name) return "baseline";
  return name.endsWith("(baseline)") ? name : `${name} (baseline)`;
}
