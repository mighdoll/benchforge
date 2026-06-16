import type { MeasuredResults } from "../runners/MeasuredResults.ts";
import { prepareBlocks } from "../stats/BlockBootstrap.ts";
import { binBootstrapResult } from "../stats/BlockDifference.ts";
import type { BootstrapResult } from "../stats/Bootstrap.ts";
import { mean } from "../stats/CoreStats.ts";
import type { BootstrapCIData } from "../viewer/ReportData.ts";
import type { Formatter, UnknownRecord } from "./BenchmarkReport.ts";

/** The bits of a metric a bootstrap-CI display needs: how to transform the
 *  value and how to format it. */
interface DisplaySpec {
  toDisplay?: (timingValue: number, metadata?: UnknownRecord) => number;
  formatter: Formatter;
}

interface Annotatable {
  direction: string;
  label?: string;
  ciReliable?: boolean;
  ciLevel?: string;
}

export const minBatches = 20;

/** @return true if comparing with fewer than minBatches on either side.
 *  Counts post-trim batches when trimming is on (default), so the threshold
 *  reflects the blocks actually fed to the bootstrap. */
export function hasLowBatchCount(
  baseline: MeasuredResults | undefined,
  current: MeasuredResults | undefined,
  noTrim?: boolean,
): boolean {
  if (!baseline) return false;
  return (
    effectiveBatchCount(baseline, noTrim) < minBatches ||
    effectiveBatchCount(current, noTrim) < minBatches
  );
}

/** @return true if either side has no real batch structure */
export function isSingleBatch(
  baseline: MeasuredResults | undefined,
  current: MeasuredResults | undefined,
): boolean {
  if (!baseline) return batchCount(current) < 2;
  return batchCount(baseline) < 2 || batchCount(current) < 2;
}

/** Add label, mark unreliable, and override direction when batch count is low */
export function annotateCI<T extends Annotatable | undefined>(
  ci: T,
  title?: string,
  lowBatches?: boolean,
): T {
  if (!ci) return ci;
  if (lowBatches) ci.direction = "uncertain";
  ci.ciReliable = !lowBatches && ci.ciLevel !== "sample";
  if (title) ci.label = `${title} Δ%`;
  return ci;
}

/** Format a BootstrapResult into display-domain BootstrapCIData */
export function formatBootstrapCI(
  spec: DisplaySpec,
  result: BootstrapResult,
  batchOffsets: number[] | undefined,
  metadata?: UnknownRecord,
): BootstrapCIData {
  const toDisplay = spec.toDisplay
    ? (v: number) => spec.toDisplay!(v, metadata)
    : (v: number) => v;
  const formatValue = (v: number) => spec.formatter(v) ?? String(v);

  const binned = binBootstrapResult(result);
  const dLo = toDisplay(binned.ci[0]);
  const dHi = toDisplay(binned.ci[1]);
  const ci = (dLo <= dHi ? [dLo, dHi] : [dHi, dLo]) as [number, number];
  const histogram = binned.histogram.map(b => ({
    x: toDisplay(b.x),
    count: b.count,
  }));
  const ciLabels = [formatValue(ci[0]), formatValue(ci[1])] as [string, string];
  const estimate = toDisplay(binned.estimate);
  const nBatches = batchOffsets?.length ?? 0;
  const ciReliable = result.ciLevel === "block" && nBatches >= minBatches;
  return {
    estimate,
    estimateLabel: formatValue(estimate),
    ci,
    histogram,
    ciLabels,
    ciLevel: result.ciLevel,
    ciReliable,
  };
}

/** @return distinct batches the bootstrap keeps after Tukey trimming (all when
 *  noTrim). Assumes batch structure exists (2+ offsets). */
export function keptBatchCount(
  m: MeasuredResults,
  noTrim: boolean | undefined,
): number {
  return prepareBlocks(m.samples, m.batchOffsets!, mean, noTrim).keptSplits
    .length;
}

/** @return number of batches that survive Tukey trimming (or raw count if
 *  trimming is off / there are too few batches to split). */
function effectiveBatchCount(
  m: MeasuredResults | undefined,
  noTrim?: boolean,
): number {
  const offsets = m?.batchOffsets;
  if (!m || !offsets || offsets.length < 2) return offsets?.length ?? 0;
  return keptBatchCount(m, noTrim);
}

function batchCount(m?: MeasuredResults): number {
  return m?.batchOffsets?.length ?? 0;
}
