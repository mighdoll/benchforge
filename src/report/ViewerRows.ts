import type { MeasuredResults } from "../runners/MeasuredResults.ts";
import { bootstrapCIs, trimOutlierBatches } from "../stats/BlockBootstrap.ts";
import { type BlockDiffOptions, diffCIs } from "../stats/BlockDifference.ts";
import {
  type BootstrapResult,
  type DifferenceCI,
  flipCI,
} from "../stats/Bootstrap.ts";
import { isBootstrappable, type StatKind } from "../stats/CoreStats.ts";
import type { ViewerEntry, ViewerRow } from "../viewer/ReportData.ts";
import {
  type MetricSection,
  metricStatKind,
  metricValue,
  type ScalarRow,
} from "./BenchmarkReport.ts";
import {
  annotateCI,
  formatBootstrapCI,
  hasLowBatchCount,
} from "./CiFormatting.ts";
import { buildShiftFunction } from "./ShiftFunction.ts";
import { statLabel } from "./ShiftPoints.ts";
import type {
  CaseContext,
  CaseTrack,
  SectionCICache,
} from "./ViewerSections.ts";

/** The comparable metric row: one cell per track (each with a bootstrap CI),
 *  comparison tracks carrying a diff CI + shift function. Caches the per-track
 *  bootstrap and diff so the raw view can reuse untrimmed tracks. */
export function metricRow(
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

/** A viewer row for one scalar row: a shared single value (non-comparable), or
 *  one cell per track with a point-ratio delta on comparison tracks. A missing
 *  comparable cell reads "n/a" so the matrix stays aligned. */
export function scalarRow(
  scalar: ScalarRow,
  ctx: CaseContext,
): ViewerRow | undefined {
  const format = (v: unknown) =>
    v === undefined ? "" : (scalar.formatter(v) ?? "");

  if (!scalar.comparable) {
    // one cell per track, but flagged shared: case-constant rows (line counts)
    // display once; rows that differ per variant (runs) fan out in the footer.
    const entries = ctx.tracks.map(track => ({
      runName: track.name,
      value: format(scalar.value(track.measured, track.meta)),
    }));
    if (!entries.some(e => e.value && e.value !== "—")) return undefined;
    return { label: scalar.title, entries, shared: true };
  }

  const na = (v: unknown) => (v === undefined ? "n/a" : format(v));
  const raws = ctx.tracks.map(track =>
    scalar.value(track.measured, track.meta),
  );
  if (raws.every(raw => raw === undefined)) return undefined;
  const entries: ViewerEntry[] = ctx.tracks.map((track, i) => {
    const entry: ViewerEntry = { runName: track.name, value: na(raws[i]) };
    if (track.isBaseline) entry.isBaseline = true;
    if (!track.isBaseline && track.baseline) {
      const baseRaw = scalar.value(
        track.baseline.measured,
        track.baseline.meta,
      );
      const delta = simpleDeltaCI(raws[i], baseRaw);
      if (delta) entry.comparisonCI = delta;
    }
    return entry;
  });
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

/** The value cell for one track: formatted metric plus its own bootstrap CI. */
function baseEntry(
  section: MetricSection,
  track: CaseTrack,
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

/** Attach the diff CI and shift function comparing a track to its baseline. */
function addComparison(
  entry: ViewerEntry,
  diff: DifferenceCI | undefined,
  section: MetricSection,
  track: CaseTrack,
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
