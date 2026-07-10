import type { MeasuredResults } from "../runners/MeasuredResults.ts";
import { prepareBlocks } from "../stats/BlockBootstrap.ts";
import { binBootstrapResult } from "../stats/BlockDifference.ts";
import {
  type BootstrapResult,
  type DifferenceCI,
  flipCI,
} from "../stats/Bootstrap.ts";
import { mean } from "../stats/CoreStats.ts";
import type { BootstrapCIData } from "../viewer/ReportData.ts";
import type {
  Formatter,
  MetricSection,
  UnknownRecord,
} from "./BenchmarkReport.ts";

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

/** @return true if comparing with fewer than minBatches. When a paired batch
 *  set was prepared, its kept pair count is the batch count actually fed to the
 *  bootstrap, so pass it as `pairCount` and the per-side counts are ignored.
 *  Otherwise counts post-trim batches per side when trimming is on (default),
 *  for the same reason. */
export function hasLowBatchCount(
  baseline: MeasuredResults | undefined,
  current: MeasuredResults | undefined,
  noTrim?: boolean,
  pairCount?: number,
): boolean {
  if (pairCount !== undefined) return pairCount < minBatches;
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

/** @return true if either side has 2+ batches, selecting the paired block path.
 *  The runner batches baseline and current together (both sides or neither), so
 *  `||` here still means "both batched"; if they ever disagree the paired prep
 *  throws rather than silently degrading. */
export function hasBatchBlocks(
  baseline: MeasuredResults,
  current: MeasuredResults,
): boolean {
  return batchCount(baseline) >= 2 || batchCount(current) >= 2;
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
  const ci = sortPair(toDisplay(binned.ci[0]), toDisplay(binned.ci[1]));
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

/** Transform a time-percent DifferenceCI into the section's display domain. For
 *  a metric with a toDisplay transform (e.g. lines/sec = 1000/ms), a time delta
 *  maps to the true throughput delta (-71.2% time ==> ~+247% loc/sec), not the
 *  first-order sign flip. `anchor` is the baseline point estimate in the time
 *  domain. Falls back to flip/identity when there's no transform or the anchor
 *  is degenerate. Leaves direction, trimmed, ciLevel untouched. */
export function displayDiffCI(
  section: MetricSection,
  diff: DifferenceCI,
  anchor: number,
  metadata?: UnknownRecord,
): DifferenceCI {
  const f = displayPercentFn(section, anchor, metadata);
  if (!f) return section.higherIsBetter ? flipCI(diff) : diff;
  const ci = sortPair(f(diff.ci[0]), f(diff.ci[1]));
  return {
    ...diff,
    percent: f(diff.percent),
    ci,
    histogram: diff.histogram?.map(bin => ({ x: f(bin.x), count: bin.count })),
  };
}

/** Transform a symmetric +/- time-percent equivalence margin into the display
 *  domain [lo, hi], sorted (a decreasing transform swaps the ends and makes the
 *  band slightly asymmetric). Falls back to [-margin, margin] with no transform. */
export function displayMarginBand(
  section: MetricSection,
  margin: number,
  anchor: number,
  metadata?: UnknownRecord,
): [number, number] {
  const f = displayPercentFn(section, anchor, metadata);
  if (!f) return [-margin, margin];
  return sortPair(f(-margin), f(margin));
}

/** The equiv-margin (%) in effect from raw CLI args, or undefined when
 *  unset/disabled (0). */
export function marginArg(
  cliArgs?: Record<string, unknown>,
): number | undefined {
  const margin = cliArgs?.["equiv-margin"];
  return typeof margin === "number" && margin > 0 ? margin : undefined;
}

/** @return distinct batches the bootstrap keeps after Tukey trimming (all when
 *  noTrim). Assumes batch structure exists (2+ offsets). */
export function keptBatchCount(
  m: MeasuredResults,
  noTrim: boolean | undefined,
): number {
  return prepareBlocks(m.samples, m.batchOffsets!, mean, {
    noTrim,
    rand: Math.random,
  }).keptSplits.length;
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

/** The pair sorted ascending (a decreasing display transform swaps the ends). */
function sortPair(a: number, b: number): [number, number] {
  return a <= b ? [a, b] : [b, a];
}

/** @return f(t) mapping a time-percent delta to the display-domain percent for
 *  a section, or undefined when there's no toDisplay or the anchor is degenerate
 *  (transform can't be built). Pointwise-exact for any monotonic toDisplay (it
 *  maps the anchored time delta through the transform), including the reciprocal
 *  (c/x) and linear (c*x) transforms that are the only real uses. */
function displayPercentFn(
  section: MetricSection,
  anchor: number,
  metadata?: UnknownRecord,
): ((timePct: number) => number) | undefined {
  const { toDisplay } = section;
  if (!toDisplay) return undefined;
  const dAnchor = toDisplay(anchor, metadata);
  if (!Number.isFinite(dAnchor) || dAnchor === 0) return undefined;
  return (t: number) =>
    (toDisplay(anchor * (1 + t / 100), metadata) / dAnchor - 1) * 100;
}
