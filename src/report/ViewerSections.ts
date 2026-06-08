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

/** One display track in a case: a measured series and, for a comparison track,
 *  the paired baseline it diffs against. The baseline track has no `baseline`. */
export interface CaseTrack {
  name: string;
  measured: MeasuredResults;
  meta?: UnknownRecord;
  isBaseline: boolean;
  baseline?: { measured: MeasuredResults; meta?: UnknownRecord; name: string };
}

/** The tracks of one case plus the comparison options driving its stats. */
export interface CaseContext {
  tracks: CaseTrack[];
  comparison?: ComparisonOptions;
}

/** Per-section reusable bootstrap results, indexed by track order. Supplying a
 *  cached `track[i]` / `diff[i]` causes the metric-row build to skip the matching
 *  bootstrap and reuse it -- used to share computation between the trim and raw
 *  views when trimming is a no-op for that track. */
export interface SectionCICache {
  /** Per-track absolute-stat bootstrap (metric row), aligned to tracks. */
  track?: (BootstrapResult | undefined)[];
  /** Per-track diff vs the track's baseline (metric row); undefined on baseline. */
  diff?: (DifferenceCI | undefined)[];
}

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

/** Build track-columned ViewerSections from ReportSections: one ViewerEntry per
 *  track, with bootstrap CIs and a per-comparison-track diff + shift function.
 *  Display values use samples with slow-outlier batches removed unless
 *  comparison.noBatchTrim. Returns per-section bootstrap caches so a second call
 *  (the raw view) can reuse results for tracks trimming left untouched. */
export function buildViewerSections(
  sections: ReportSection[],
  ctx: CaseContext,
  reuseCaches?: SectionCICache[],
): { sections: ViewerSection[]; caches: SectionCICache[] } {
  const caches: SectionCICache[] = [];
  const viewerSections: ViewerSection[] = [];
  sections.forEach((section, i) => {
    const cache: SectionCICache = {};
    const layout = section.kind === "scalar" ? section.layout : undefined;
    const placement = section.kind === "scalar" ? section.placement : undefined;
    const rows =
      section.kind === "metric"
        ? metricRows(section, ctx, reuseCaches?.[i], cache)
        : scalarRows(section, ctx);
    caches[i] = cache;
    if (rows.length)
      viewerSections.push({ title: section.title, rows, layout, placement });
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

/** Build the rows for a metric section: one comparable metric row (one cell per
 *  track, marked primary) followed by its scalar extras. */
function metricRows(
  section: MetricSection,
  ctx: CaseContext,
  reuse: SectionCICache | undefined,
  cache: SectionCICache,
): ViewerRow[] {
  const row = metricRow(section, ctx, reuse, cache);
  const extras = (section.extras ?? []).flatMap(r => {
    const out = scalarRow(r, ctx);
    return out ? [out] : [];
  });
  return [row, ...extras];
}

/** Build the rows for a scalar section: one row per scalar row. */
function scalarRows(section: ScalarSection, ctx: CaseContext): ViewerRow[] {
  return section.rows.flatMap(r => {
    const out = scalarRow(r, ctx);
    return out ? [out] : [];
  });
}

/** The comparable metric row: one cell per track (each with a bootstrap CI),
 *  comparison tracks carrying a diff CI + shift function. Caches the per-track
 *  bootstrap and diff so the raw view can reuse untrimmed tracks. */
function metricRow(
  section: MetricSection,
  ctx: CaseContext,
  reuse: SectionCICache | undefined,
  cache: SectionCICache,
): ViewerRow {
  const stat = metricStatKind(section);
  const canBoot = isBootstrappable(stat);
  const noTrim = ctx.comparison?.noBatchTrim;
  const trackBoot: (BootstrapResult | undefined)[] = [];
  const trackDiff: (DifferenceCI | undefined)[] = [];

  const entries = ctx.tracks.map((track, i) => {
    const boot = canBoot
      ? (reuse?.track?.[i] ?? bootstrapTrack(track.measured, stat, noTrim))
      : undefined;
    trackBoot[i] = boot;

    const entry = baseEntry(section, track, boot, noTrim);
    if (!track.isBaseline && track.baseline) {
      const diff = canBoot
        ? (reuse?.diff?.[i] ?? trackDiffCI(section, stat, track, ctx))
        : undefined;
      trackDiff[i] = diff;
      addComparison(entry, diff, section, track, ctx);
    }
    return entry;
  });

  cache.track = trackBoot;
  cache.diff = trackDiff;
  return {
    label: section.title,
    entries,
    primary: true,
    statLabel: statLabel(stat),
  };
}

/** The value cell for one track: formatted metric plus its own bootstrap CI. */
function baseEntry(
  section: MetricSection,
  track: CaseContext["tracks"][number],
  boot: BootstrapResult | undefined,
  noTrim: boolean | undefined,
): ViewerEntry {
  const { measured, meta } = track;
  const offsets = measured.batchOffsets;
  const trimmed = trimOutlierBatches(measured.samples, offsets, noTrim).samples;
  const value = metricValue(section, measured, meta, trimmed);
  const entry: ViewerEntry = {
    runName: track.name,
    value: section.formatter(value) ?? "",
  };
  if (track.isBaseline) entry.isBaseline = true;
  if (boot) entry.bootstrapCI = formatBootstrapCI(section, boot, offsets, meta);
  return entry;
}

/** Attach the diff CI and shift function comparing a track to its baseline. */
function addComparison(
  entry: ViewerEntry,
  diff: DifferenceCI | undefined,
  section: MetricSection,
  track: CaseContext["tracks"][number],
  ctx: CaseContext,
): void {
  const base = track.baseline!;
  if (diff) entry.comparisonCI = diff;
  const shift = buildShiftFunction(
    section,
    track.measured,
    base.measured,
    track.meta,
    base.meta,
    ctx.comparison,
    base.name,
  );
  if (shift) entry.shiftFunction = shift;
}

/** A viewer row for one scalar row: a shared single value (non-comparable), or
 *  one cell per track with a point-ratio delta on comparison tracks. A missing
 *  comparable cell reads "n/a" so the matrix stays aligned. */
function scalarRow(scalar: ScalarRow, ctx: CaseContext): ViewerRow | undefined {
  const format = (v: unknown) =>
    v === undefined ? "" : (scalar.formatter(v) ?? "");

  if (!scalar.comparable) {
    // one cell per track, but flagged shared: case-constant rows (line counts)
    // display once; rows that differ per variant (runs) fan out in the footer.
    let anyValue = false;
    const entries = ctx.tracks.map(track => {
      const value = format(scalar.value(track.measured, track.meta));
      if (value && value !== "—") anyValue = true;
      return { runName: track.name, value };
    });
    if (!anyValue) return undefined;
    return { label: scalar.title, entries, shared: true };
  }

  const na = (v: unknown) => (v === undefined ? "n/a" : format(v));
  let anyValue = false;
  const entries: ViewerEntry[] = ctx.tracks.map(track => {
    const raw = scalar.value(track.measured, track.meta);
    if (raw !== undefined) anyValue = true;
    const entry: ViewerEntry = { runName: track.name, value: na(raw) };
    if (track.isBaseline) entry.isBaseline = true;
    if (!track.isBaseline && track.baseline) {
      const baseRaw = scalar.value(
        track.baseline.measured,
        track.baseline.meta,
      );
      const delta = simpleDeltaCI(raw, baseRaw);
      if (delta) entry.comparisonCI = delta;
    }
    return entry;
  });
  if (!anyValue) return undefined;
  return { label: scalar.title, entries };
}

/** Bootstrap one track's absolute stat (undefined when too few samples). */
function bootstrapTrack(
  m: MeasuredResults,
  stat: StatKind,
  noTrim: boolean | undefined,
): BootstrapResult | undefined {
  if (m.samples.length <= 1) return undefined;
  return bootstrapCIs(m.samples, m.batchOffsets, [stat], { noTrim })[0];
}

/** One comparison track's difference CI: diff vs its baseline, higher-is-better
 *  flip, and low-batch annotation. */
function trackDiffCI(
  section: MetricSection,
  stat: StatKind,
  track: CaseTrack,
  ctx: CaseContext,
): DifferenceCI | undefined {
  const base = track.baseline!;
  if (!base.measured.samples?.length || !track.measured.samples?.length)
    return undefined;
  const { equivMargin, noBatchTrim } = ctx.comparison ?? {};
  const opts: BlockDiffOptions = { equivMargin, noBatchTrim };
  const ci = diffCIs(
    base.measured.samples,
    base.measured.batchOffsets,
    track.measured.samples,
    track.measured.batchOffsets,
    [stat],
    opts,
  )[0];
  if (!ci) return undefined;
  const adjusted = section.higherIsBetter ? flipCI(ci) : ci;
  const lowBatches = hasLowBatchCount(
    base.measured,
    track.measured,
    noBatchTrim,
  );
  return annotateCI(adjusted, section.title, lowBatches);
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
