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
  type Formatter,
  type MetricSection,
  metricStatKind,
  metricValue,
  type ReportSection,
  type ScalarRow,
  type ScalarSection,
  type UnknownRecord,
} from "./BenchmarkReport.ts";
import { buildShiftFunction, statLabel } from "./ShiftFunction.ts";

/** The bits of a metric a bootstrap-CI display needs: how to transform the
 *  value and how to format it. */
interface DisplaySpec {
  toDisplay?: (timingValue: number, metadata?: UnknownRecord) => number;
  formatter: Formatter;
}

/** Per-section reusable bootstrap results, indexed by stat-column order.
 *  Supplying cur/base/diff causes buildCIMap to skip the matching bootstrap
 *  call and reuse the provided result. Used to share computation between
 *  trim and raw views when trimming is a no-op for a side. */
export interface SectionCICache {
  cur?: (BootstrapResult | undefined)[];
  base?: (BootstrapResult | undefined)[];
  diff?: (DifferenceCI | undefined)[];
}

/** Context for building viewer rows within a section */
interface RowContext {
  current: MeasuredResults;
  baseline?: MeasuredResults;
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
  base: RowContext,
  reuseCaches?: SectionCICache[],
): { sections: ViewerSection[]; caches: SectionCICache[] } {
  const { current, baseline, comparison } = base;
  const noTrim = comparison?.noBatchTrim;
  const trimmedSamples = (m: MeasuredResults) =>
    trimOutlierBatches(m.samples, m.batchOffsets, noTrim).samples;
  const curSamples = trimmedSamples(current);
  const baseSamples = baseline ? trimmedSamples(baseline) : undefined;
  const caches: SectionCICache[] = [];
  const viewerSections: ViewerSection[] = [];
  sections.forEach((section, i) => {
    const ctx: RowContext = { ...base };
    const cache: SectionCICache = {};
    const layout = section.kind === "scalar" ? section.layout : undefined;
    const rows =
      section.kind === "metric"
        ? metricRows(
            section,
            ctx,
            curSamples,
            baseSamples,
            reuseCaches?.[i],
            cache,
          )
        : scalarRows(section, ctx);
    caches[i] = cache;
    if (rows.length)
      viewerSections.push({ title: section.title, rows, layout });
  });
  return { sections: viewerSections, caches };
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

/** Build the rows for a metric section: one comparable metric row (bootstrap CI
 *  + shift fan, marked primary) followed by its scalar extras. The bootstrap
 *  result for the metric is cached in populate / reused from reuse so the trim
 *  and raw views can share work. */
function metricRows(
  section: MetricSection,
  ctx: RowContext,
  curSamples: number[],
  baseSamples: number[] | undefined,
  reuse?: SectionCICache,
  populate?: SectionCICache,
): ViewerRow[] {
  const cis = metricCIs(section, ctx, reuse, populate);
  const row = metricRow(section, ctx, curSamples, baseSamples, cis);
  const extras = (section.extras ?? []).flatMap(r => {
    const out = scalarRow(r, ctx);
    return out ? [out] : [];
  });
  return row ? [row, ...extras] : extras;
}

/** Build the rows for a scalar section: one row per scalar row. */
function scalarRows(section: ScalarSection, ctx: RowContext): ViewerRow[] {
  return section.rows.flatMap(r => {
    const out = scalarRow(r, ctx);
    return out ? [out] : [];
  });
}

/** Bootstrap a metric section's single stat for current/baseline + the diff,
 *  reusing cached results when supplied and writing computed ones to populate. */
function metricCIs(
  section: MetricSection,
  ctx: RowContext,
  reuse?: SectionCICache,
  populate?: SectionCICache,
): ColCIs {
  if (!isBootstrappable(metricStatKind(section))) return {};
  const stats = [metricStatKind(section)];
  const opts = { noTrim: ctx.comparison?.noBatchTrim };
  const computeCIs = (s: number[] | undefined, offsets?: number[]) =>
    s && s.length > 1 ? bootstrapCIs(s, offsets, stats, opts) : undefined;
  const cur =
    reuse?.cur ?? computeCIs(ctx.current.samples, ctx.current.batchOffsets);
  const base =
    reuse?.base ??
    computeCIs(ctx.baseline?.samples, ctx.baseline?.batchOffsets);
  const diff = reuse?.diff ?? buildDiffResults(section, stats, ctx);
  if (populate) {
    populate.cur = cur;
    populate.base = base;
    populate.diff = diff;
  }
  return { cur: cur?.[0], base: base?.[0], diff: diff?.[0] };
}

/** Build the comparable metric row: current + baseline entries (each with a
 *  bootstrap CI), the diff CI, primary marker, and the shift-function fan. */
function metricRow(
  section: MetricSection,
  ctx: RowContext,
  curSamples: number[],
  baseSamples: number[] | undefined,
  cis: ColCIs,
): ViewerRow | undefined {
  const curRaw = metricValue(section, ctx.current, ctx.currentMeta, curSamples);
  const format = (v: number) => section.formatter(v) ?? "";

  const entries: ViewerEntry[] = [
    buildEntry(
      ctx.current.name,
      format(curRaw),
      section,
      cis.cur,
      ctx.current.batchOffsets,
      ctx.currentMeta,
    ),
  ];
  if (ctx.baseline) {
    const baseRaw = metricValue(
      section,
      ctx.baseline,
      ctx.baselineMeta,
      baseSamples,
    );
    entries.push(
      buildEntry(
        "baseline",
        format(baseRaw),
        section,
        cis.base,
        ctx.baseline.batchOffsets,
        ctx.baselineMeta,
      ),
    );
  }

  const row: ViewerRow = {
    label: section.title,
    entries,
    primary: true,
    statLabel: statLabel(metricStatKind(section)),
  };
  if (cis.diff) row.comparisonCI = cis.diff;
  row.shiftFunction = buildShiftFunction(
    section,
    ctx.current,
    ctx.baseline,
    ctx.currentMeta,
    ctx.baselineMeta,
    ctx.comparison,
  );
  return row;
}

/** Build a viewer row for one scalar row: a shared single value, or (when
 *  comparable with a baseline) current + baseline + a point-ratio delta. */
function scalarRow(scalar: ScalarRow, ctx: RowContext): ViewerRow | undefined {
  const { current, baseline, currentMeta, baselineMeta } = ctx;
  const curRaw = scalar.value(current, currentMeta);
  const baseRaw = baseline ? scalar.value(baseline, baselineMeta) : undefined;
  if (curRaw === undefined && baseRaw === undefined) return undefined;

  const format = (v: unknown) =>
    v === undefined ? "" : (scalar.formatter(v) ?? "");

  if (!scalar.comparable) {
    const value = format(curRaw ?? baseRaw);
    if (!value || value === "—") return undefined;
    return {
      label: scalar.title,
      entries: [{ runName: current.name, value }],
      shared: true,
    };
  }

  const entries: ViewerEntry[] = [
    { runName: current.name, value: format(curRaw) },
  ];
  if (baseline && baseRaw !== undefined)
    entries.push({ runName: "baseline", value: format(baseRaw) });
  return {
    label: scalar.title,
    entries,
    comparisonCI: simpleDeltaCI(curRaw, baseRaw),
  };
}

/** Compute the metric's difference CI with annotation and higher-is-better flip. */
function buildDiffResults(
  section: MetricSection,
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
  return rawCIs.map(ci => {
    if (!ci) return undefined;
    const adjusted = section.higherIsBetter ? flipCI(ci) : ci;
    return annotateCI(adjusted, section.title, lowBatches);
  });
}

/** Build a ViewerEntry, attaching bootstrap CI data if available */
function buildEntry(
  runName: string,
  value: string,
  spec: DisplaySpec,
  result: BootstrapResult | undefined,
  batchOffsets: number[] | undefined,
  metadata?: UnknownRecord,
): ViewerEntry {
  if (!result) return { runName, value };
  const bootstrapCI = formatBootstrapCI(spec, result, batchOffsets, metadata);
  return { runName, value, bootstrapCI };
}

/** @return a CI-less DifferenceCI for comparable scalar rows. Direction is
 *  "uncertain" since we have no significance test; percent is the value ratio. */
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
