import type { MeasuredResults } from "../runners/MeasuredResults.ts";
import {
  type BlockDiffOptions,
  binBootstrapResult,
  diffCIs,
} from "../stats/BootstrapDifference.ts";
import {
  type BootstrapResult,
  bootstrapCIs,
  type DifferenceCI,
  flipCI,
  isBootstrappable,
  type StatKind,
  swapDirection,
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

/** @return true if comparing with fewer than minBatches on either side */
export function hasLowBatchCount(
  baseline: MeasuredResults | undefined,
  current: MeasuredResults | undefined,
): boolean {
  if (!baseline) return false;
  return batchCount(baseline) < minBatches || batchCount(current) < minBatches;
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

/** Build ViewerSections from ReportSections, with bootstrap CIs for comparable columns */
export function buildViewerSections(
  sections: ReportSection[],
  base: Omit<RowContext, "curVals" | "baseVals">,
): ViewerSection[] {
  const { current, baseline, currentMeta, baselineMeta } = base;
  return sections.flatMap(section => {
    const curVals = computeColumnValues(section, current, currentMeta);
    const baseVals = baseline
      ? computeColumnValues(section, baseline, baselineMeta)
      : undefined;
    const ctx: RowContext = { ...base, curVals, baseVals };
    const rows = buildGroupRows(section.columns as ReportColumn[], ctx);
    if (!rows.length) return [];
    return [{ title: section.title, rows } satisfies ViewerSection];
  });
}

function batchCount(m?: MeasuredResults): number {
  return m?.batchOffsets?.length ?? 0;
}

/** Build ViewerRow[] for a column group, using shared resampling for statKind columns */
function buildGroupRows(columns: ReportColumn[], ctx: RowContext): ViewerRow[] {
  const ciMap = buildCIMap(columns, ctx);
  const rows: ViewerRow[] = [];
  for (const col of columns) {
    const key = (col.key ?? col.title) as string;
    const row = buildRow(col, key, ctx, ciMap.get(key));
    if (row) rows.push(row);
  }
  const first = rows.find(r => r.entries.some(e => e.bootstrapCI));
  if (first) first.primary = true;
  return rows;
}

/** Compute batched bootstrap CIs, returning a Map keyed by column key */
function buildCIMap(
  columns: ReportColumn[],
  ctx: RowContext,
): Map<string, ColCIs> {
  const ciCols = columns.filter(
    c => c.comparable && c.statKind && isBootstrappable(c.statKind),
  );
  const statKinds = ciCols.map(c => c.statKind!);
  const map = new Map<string, ColCIs>();
  if (statKinds.length === 0) return map;

  const curSamples = ctx.current.samples;
  const baseSamples = ctx.baseline?.samples;
  const curResults =
    curSamples?.length > 1
      ? bootstrapCIs(curSamples, ctx.current.batchOffsets, statKinds)
      : undefined;
  const baseResults =
    baseSamples?.length && baseSamples.length > 1
      ? bootstrapCIs(baseSamples, ctx.baseline!.batchOffsets, statKinds)
      : undefined;
  const diffResults = buildDiffResults(ciCols, statKinds, ctx);

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
  cis?: ColCIs,
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
    cis?.cur,
    ctx.current.batchOffsets,
    ctx.currentMeta,
  );
  const entries: ViewerEntry[] = [curEntry];
  if (ctx.baseline && baseRaw !== undefined) {
    const baseEntry = buildEntry(
      "baseline",
      format(baseRaw),
      col,
      cis?.base,
      ctx.baseline.batchOffsets,
      ctx.baselineMeta,
    );
    entries.push(baseEntry);
  }
  return { label: col.title, entries, comparisonCI: cis?.diff };
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
  const lowBatches = hasLowBatchCount(baseline, current);
  return rawCIs.map((ci, i) => {
    if (!ci) return undefined;
    const col = cols[i];
    const adjusted = col.higherIsBetter ? swapDirection(flipCI(ci)) : ci;
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

/** Format a BootstrapResult into display-domain BootstrapCIData */
function formatBootstrapCI(
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
  const nBatches = batchOffsets?.length ?? 0;
  const ciReliable = result.ciLevel === "block" && nBatches >= minBatches;
  return {
    estimate: toDisplay(binned.estimate),
    ci,
    histogram,
    ciLabels,
    ciLevel: result.ciLevel,
    ciReliable,
  };
}
