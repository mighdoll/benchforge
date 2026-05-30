import type { MeasuredResults } from "../runners/MeasuredResults.ts";
import {
  type BlockDiffOptions,
  binBootstrapResult,
  diffCIs,
} from "../stats/BootstrapDifference.ts";
import {
  average,
  type BootstrapResult,
  bootstrapCIs,
  type DifferenceCI,
  flipCI,
  isBootstrappable,
  type StatKind,
  splitByOffsets,
  trimOutlierBatches,
  tukeyKeep,
} from "../stats/StatisticalUtils.ts";
import type {
  BootstrapCIData,
  ViewerEntry,
  ViewerRow,
  ViewerSection,
} from "../viewer/ReportData.ts";
import {
  type ComparisonOptions,
  computeColumnValues,
  type ReportColumn,
  type ReportSection,
  type UnknownRecord,
} from "./BenchmarkReport.ts";
import { buildShiftFunction } from "./ShiftFunction.ts";

/** Per-section reusable bootstrap results, indexed by stat-column order.
 *  Supplying cur/base/diff causes buildCIMap to skip the matching bootstrap
 *  call and reuse the provided result. Used to share computation between
 *  trim and raw views when trimming is a no-op for a side. */
export interface SectionCICache {
  cur?: (BootstrapResult | undefined)[];
  base?: (BootstrapResult | undefined)[];
  diff?: (DifferenceCI | undefined)[];
}

/** Context for building viewer rows within a column group */
interface RowContext {
  current: MeasuredResults;
  baseline?: MeasuredResults;
  curVals: Record<string, unknown>;
  baseVals?: Record<string, unknown>;
  currentMeta?: UnknownRecord;
  baselineMeta?: UnknownRecord;
  comparison?: ComparisonOptions;
}

/** Pre-computed bootstrap results for a single column */
interface ColCIs {
  cur?: BootstrapResult;
  base?: BootstrapResult;
  diff?: DifferenceCI;
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

/** Build ViewerSections from ReportSections, with bootstrap CIs for comparable
 *  columns. When base.comparison.noBatchTrim is false (default), display values
 *  and bootstrap CIs are computed from samples with slow-outlier batches removed.
 *  Returns per-section bootstrap caches so a second call (e.g. for the raw view)
 *  can reuse results when its inputs are identical. Supply reuseCaches to skip
 *  matching bootstrap work on the second call. */
export function buildViewerSections(
  sections: ReportSection[],
  base: Omit<RowContext, "curVals" | "baseVals">,
  reuseCaches?: SectionCICache[],
): { sections: ViewerSection[]; caches: SectionCICache[] } {
  const { current, baseline, currentMeta, baselineMeta, comparison } = base;
  const noTrim = comparison?.noBatchTrim;
  const trimmedSamples = (m: MeasuredResults) =>
    trimOutlierBatches(m.samples, m.batchOffsets, noTrim).samples;
  const curSamples = trimmedSamples(current);
  const baseSamples = baseline ? trimmedSamples(baseline) : undefined;
  const caches: SectionCICache[] = [];
  const viewerSections: ViewerSection[] = [];
  sections.forEach((section, i) => {
    const curVals = computeColumnValues(
      section,
      current,
      currentMeta,
      curSamples,
    );
    const baseVals = baseline
      ? computeColumnValues(section, baseline, baselineMeta, baseSamples)
      : undefined;
    const ctx: RowContext = { ...base, curVals, baseVals };
    const cache: SectionCICache = {};
    const cols = section.columns as ReportColumn[];
    const rows = buildGroupRows(
      cols,
      ctx,
      section.title,
      reuseCaches?.[i],
      cache,
    );
    caches[i] = cache;
    if (rows.length) viewerSections.push({ title: section.title, rows });
  });
  return { sections: viewerSections, caches };
}

/** Format a BootstrapResult into display-domain BootstrapCIData */
export function formatBootstrapCI(
  col: ReportColumn,
  result: BootstrapResult,
  batchOffsets: number[] | undefined,
  metadata?: UnknownRecord,
): BootstrapCIData {
  const toDisplay = col.toDisplay
    ? (v: number) => col.toDisplay!(v, metadata)
    : (v: number) => v;
  const formatValue = (v: number) =>
    (col.formatter ? col.formatter(v) : String(v)) ?? String(v);

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

/** @return number of batches that survive Tukey trimming (or raw count if
 *  trimming is off / there are too few batches to split). */
function effectiveBatchCount(
  m: MeasuredResults | undefined,
  noTrim?: boolean,
): number {
  const offsets = m?.batchOffsets;
  if (!m || !offsets || offsets.length < 2) return offsets?.length ?? 0;
  if (noTrim) return offsets.length;
  const means = splitByOffsets(m.samples, offsets).map(average);
  return tukeyKeep(means).length;
}

function batchCount(m?: MeasuredResults): number {
  return m?.batchOffsets?.length ?? 0;
}

/** Build ViewerRow[] for a column group, using shared resampling for statKind columns */
function buildGroupRows(
  columns: ReportColumn[],
  ctx: RowContext,
  sectionTitle: string,
  reuse?: SectionCICache,
  populate?: SectionCICache,
): ViewerRow[] {
  const ciMap = buildCIMap(columns, ctx, reuse, populate);
  const rows: ViewerRow[] = [];
  for (const col of columns) {
    const key = (col.key ?? col.title) as string;
    const row = buildRow(col, key, ctx, ciMap.get(key));
    if (row) rows.push(row);
  }
  attachPrimaryShiftFunction(columns, rows, ctx, sectionTitle);
  return rows;
}

/** Compute batched bootstrap CIs, returning a Map keyed by column key. When
 *  reuse provides cur/base/diff arrays (aligned to the comparable+bootstrappable
 *  column order), those entries are taken as-is and the bootstrap is skipped.
 *  Computed results are written into populate so a caller can reuse them. */
function buildCIMap(
  columns: ReportColumn[],
  ctx: RowContext,
  reuse?: SectionCICache,
  populate?: SectionCICache,
): Map<string, ColCIs> {
  const ciCols = columns.filter(
    c => c.comparable && c.statKind && isBootstrappable(c.statKind),
  );
  const statKinds = ciCols.map(c => c.statKind!);
  const map = new Map<string, ColCIs>();
  if (statKinds.length === 0) return map;

  const curSamples = ctx.current.samples;
  const baseSamples = ctx.baseline?.samples;
  const opts = { noTrim: ctx.comparison?.noBatchTrim };
  const computeCIs = (s: number[], offsets?: number[]) =>
    s.length > 1 ? bootstrapCIs(s, offsets, statKinds, opts) : undefined;
  const curResults =
    reuse?.cur ??
    (curSamples ? computeCIs(curSamples, ctx.current.batchOffsets) : undefined);
  const baseResults =
    reuse?.base ??
    (baseSamples
      ? computeCIs(baseSamples, ctx.baseline!.batchOffsets)
      : undefined);
  const diffResults = reuse?.diff ?? buildDiffResults(ciCols, statKinds, ctx);

  if (populate) {
    populate.cur = curResults;
    populate.base = baseResults;
    populate.diff = diffResults;
  }

  for (let i = 0; i < ciCols.length; i++) {
    const key = (ciCols[i].key ?? ciCols[i].title) as string;
    map.set(key, {
      cur: curResults?.[i],
      base: baseResults?.[i],
      diff: diffResults?.[i],
    });
  }
  return map;
}

/** Build a ViewerRow for a column, using pre-computed CIs if available */
function buildRow(
  col: ReportColumn,
  key: string,
  ctx: RowContext,
  colCIs?: ColCIs,
): ViewerRow | undefined {
  const curRaw = ctx.curVals[key];
  const baseRaw = ctx.baseVals?.[key];
  if (curRaw === undefined && baseRaw === undefined) return undefined;

  const format = (v: unknown) => {
    if (v === undefined) return "";
    return (col.formatter ? col.formatter(v) : String(v)) ?? "";
  };

  // Non-comparable: shared single value
  if (!col.comparable) {
    const value = format(curRaw ?? baseRaw);
    if (!value || value === "—") return undefined;
    return {
      label: col.title,
      entries: [{ runName: ctx.current.name, value }],
      shared: true,
    };
  }

  // Comparable: current + baseline entries, optional CI
  const curEntry = buildEntry(
    ctx.current.name,
    format(curRaw),
    col,
    colCIs?.cur,
    ctx.current.batchOffsets,
    ctx.currentMeta,
  );
  const entries: ViewerEntry[] = [curEntry];
  if (ctx.baseline && baseRaw !== undefined) {
    const baseEntry = buildEntry(
      "baseline",
      format(baseRaw),
      col,
      colCIs?.base,
      ctx.baseline.batchOffsets,
      ctx.baselineMeta,
    );
    entries.push(baseEntry);
  }
  const comparisonCI = colCIs?.diff ?? simpleDeltaCI(curRaw, baseRaw);
  return { label: col.title, entries, comparisonCI };
}

/** Mark the first row with a bootstrap CI as primary and attach its
 *  shift-function data (per-percentile diff across the whole distribution). */
function attachPrimaryShiftFunction(
  columns: ReportColumn[],
  rows: ViewerRow[],
  ctx: RowContext,
  sectionTitle: string,
): void {
  const primaryRow = rows.find(r => r.entries.some(e => e.bootstrapCI));
  if (!primaryRow) return;
  primaryRow.primary = true;
  const col = columns.find(c => c.title === primaryRow.label);
  if (!col) return;
  primaryRow.shiftFunction = buildShiftFunction(
    col,
    sectionTitle,
    ctx.current,
    ctx.baseline,
    ctx.currentMeta,
    ctx.baselineMeta,
    ctx.comparison,
  );
}

/** Compute difference CIs with annotation and higher-is-better flip */
function buildDiffResults(
  cols: ReportColumn[],
  stats: StatKind[],
  ctx: RowContext,
): (DifferenceCI | undefined)[] | undefined {
  const { baseline, current, comparison } = ctx;
  if (!baseline?.samples?.length || !current.samples?.length) return undefined;

  const opts: BlockDiffOptions = {
    equivMargin: comparison?.equivMargin,
    noBatchTrim: comparison?.noBatchTrim,
  };
  const rawCIs = diffCIs(
    baseline.samples,
    baseline.batchOffsets,
    current.samples,
    current.batchOffsets,
    stats,
    opts,
  );
  const lowBatches = hasLowBatchCount(
    baseline,
    current,
    comparison?.noBatchTrim,
  );
  return rawCIs.map((ci, i) => {
    if (!ci) return undefined;
    const col = cols[i];
    const adjusted = col.higherIsBetter ? flipCI(ci) : ci;
    return annotateCI(adjusted, col.title, lowBatches);
  });
}

/** Build a ViewerEntry, attaching bootstrap CI data if available */
function buildEntry(
  runName: string,
  value: string,
  col: ReportColumn,
  result: BootstrapResult | undefined,
  batchOffsets: number[] | undefined,
  metadata?: UnknownRecord,
): ViewerEntry {
  if (!result) return { runName, value };
  const bootstrapCI = formatBootstrapCI(col, result, batchOffsets, metadata);
  return { runName, value, bootstrapCI };
}

/** @return a CI-less DifferenceCI for non-bootstrappable comparable columns
 *  (e.g. min/max). Direction is "uncertain" since we have no significance
 *  test; percent is just the displayed-value ratio. */
function simpleDeltaCI(
  curRaw: unknown,
  baseRaw: unknown,
): DifferenceCI | undefined {
  if (typeof curRaw !== "number" || typeof baseRaw !== "number")
    return undefined;
  if (baseRaw === 0) return undefined;
  const percent = ((curRaw - baseRaw) / baseRaw) * 100;
  return { percent, ci: [percent, percent], direction: "uncertain" };
}
