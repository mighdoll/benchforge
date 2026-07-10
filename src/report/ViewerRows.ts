import type { MeasuredResults } from "../runners/MeasuredResults.ts";
import { bootstrapCIs, trimOutlierBatches } from "../stats/BlockBootstrap.ts";
import {
  type BlockDiffOptions,
  diffCIs,
  type PreparedPairedBlocks,
  pairedBlockBootstrap,
  pairedBlockDifference,
} from "../stats/BlockDifference.ts";
import {
  type BootstrapResult,
  type DifferenceCI,
  flipCI,
} from "../stats/Bootstrap.ts";
import {
  isBootstrappable,
  type StatKind,
  statKindToFn,
} from "../stats/CoreStats.ts";
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
  hasBatchBlocks,
  hasLowBatchCount,
} from "./CiFormatting.ts";
import { buildShiftFunction, preparePairedResults } from "./ShiftFunction.ts";
import { statLabel } from "./ShiftPoints.ts";
import type {
  CaseContext,
  CaseTrack,
  SectionCICache,
} from "./ViewerSections.ts";

interface MetricBootstrap {
  boot?: BootstrapResult;
  diff?: DifferenceCI;
  samples?: number[];
  batchOffsets?: number[];
}

/** The comparable metric row: one cell per track (each with a bootstrap CI),
 *  comparison tracks carrying a diff CI + shift function. Caches the per-track
 *  bootstrap and diff so the raw view can reuse untrimmed tracks. `pairs` is
 *  shared across every metric section of the case (see comparisonPairs). */
export function metricRow(
  section: MetricSection,
  ctx: CaseContext,
  reuse: SectionCICache | undefined,
  cache: SectionCICache,
  pairs: (PreparedPairedBlocks | undefined)[],
): ViewerRow {
  const stat = metricStatKind(section);
  const canBoot = isBootstrappable(stat);
  const noTrim = ctx.comparison?.noBatchTrim;
  const trackBoot: (BootstrapResult | undefined)[] = [];
  const trackDiff: (DifferenceCI | undefined)[] = [];

  const entries = ctx.tracks.map((track, i) => {
    const metric = canBoot
      ? trackMetric(section, stat, track, ctx, reuse, i, pairs)
      : undefined;
    // trackMetric leaves boot undefined for unpaired tracks (sampleMetric, or a
    // baseline with no preceding paired current); fall back to a standalone CI.
    const boot =
      metric?.boot ??
      (canBoot
        ? (reuse?.track?.[i] ?? bootstrapTrack(track.measured, stat, noTrim))
        : undefined);
    trackBoot[i] = boot;

    const entry = baseEntry(
      section,
      track,
      boot,
      noTrim,
      metric?.samples,
      metric?.batchOffsets,
    );
    if (!track.isBaseline && track.baseline) {
      const diff = canBoot ? metric?.diff : undefined;
      trackDiff[i] = diff;
      addComparison(entry, diff, section, track, ctx, pairs[i]);
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

/** The comparison track that a baseline cell pairs with: the one immediately
 *  before it, iff that track's baseline is this same measured result. */
export function pairedCurrentTrack(
  tracks: CaseTrack[],
  baselineIndex: number,
): CaseTrack | undefined {
  const baseline = tracks[baselineIndex];
  const prev = tracks[baselineIndex - 1];
  if (!baseline?.isBaseline || !prev || prev.isBaseline) return undefined;
  return prev.baseline?.measured === baseline.measured ? prev : undefined;
}

/** Prepare each comparison track's paired batch blocks for one case, indexed by
 *  track. Baseline and unbatched tracks are undefined. Shared across every
 *  metric section of the case (by the current cell, its baseline cell, and the
 *  shift function) so the pairing (split, trim intersection, cap draw) is
 *  computed once per comparison, not once per section. */
export function comparisonPairs(
  ctx: CaseContext,
  noTrim: boolean | undefined,
): (PreparedPairedBlocks | undefined)[] {
  return ctx.tracks.map(track => {
    if (track.isBaseline || !track.baseline) return undefined;
    const base = track.baseline.measured;
    const cur = track.measured;
    if (!base.samples?.length || !cur.samples?.length) return undefined;
    if (!hasBatchBlocks(base, cur)) return undefined;
    return preparePairedResults(base, cur, noTrim);
  });
}

/** Dispatch one track to its metric build: a comparison track gets the paired
 *  diff + CI, a baseline track gets its paired-side CI, others undefined. */
function trackMetric(
  section: MetricSection,
  stat: StatKind,
  track: CaseTrack,
  ctx: CaseContext,
  reuse: SectionCICache | undefined,
  index: number,
  pairs: (PreparedPairedBlocks | undefined)[],
): MetricBootstrap | undefined {
  if (!track.isBaseline && track.baseline) {
    return comparisonMetric(
      section,
      stat,
      track,
      ctx,
      reuse,
      index,
      pairs[index],
    );
  }
  if (track.isBaseline) {
    return baselineMetric(stat, ctx, reuse, index, pairs);
  }
  return undefined;
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
  statSamples?: number[],
  ciOffsets?: number[],
): ViewerEntry {
  const { measured, meta } = track;
  const offsets = measured.batchOffsets;
  const trimmed =
    statSamples ??
    trimOutlierBatches(measured.samples, offsets, noTrim).samples;
  const value = metricValue(section, measured, meta, trimmed);
  const entry: ViewerEntry = {
    runName: track.name,
    value: section.formatter(value) ?? "",
  };
  if (track.isBaseline) entry.isBaseline = true;
  if (boot) {
    entry.bootstrapCI = formatBootstrapCI(
      section,
      boot,
      ciOffsets ?? offsets,
      meta,
    );
  }
  return entry;
}

/** Attach the diff CI and shift function comparing a track to its baseline. */
function addComparison(
  entry: ViewerEntry,
  diff: DifferenceCI | undefined,
  section: MetricSection,
  track: CaseTrack,
  ctx: CaseContext,
  pair: PreparedPairedBlocks | undefined,
): void {
  const base = track.baseline!;
  if (diff) entry.comparisonCI = diff;
  const shift = buildShiftFunction(section, track.measured, base.measured, {
    currentMeta: track.meta,
    baselineMeta: base.meta,
    comparison: ctx.comparison,
    baselineName: base.name,
    prepared: pair,
  });
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

/** One comparison track's paired metric data: the visible current value,
 *  current absolute CI, and baseline delta all come from the same kept rounds. */
function comparisonMetric(
  section: MetricSection,
  stat: StatKind,
  track: CaseTrack,
  ctx: CaseContext,
  reuse: SectionCICache | undefined,
  index: number,
  pair: PreparedPairedBlocks | undefined,
): MetricBootstrap | undefined {
  const base = track.baseline!;
  if (!base.measured.samples?.length || !track.measured.samples?.length)
    return undefined;

  const { equivMargin, noBatchTrim, resamples } = ctx.comparison ?? {};
  const opts: BlockDiffOptions = { equivMargin, noBatchTrim, resamples };
  const raw = pair
    ? pairedMetric(stat, pair, opts, reuse, index)
    : sampleMetric(stat, base.measured, track.measured, opts, reuse, index);
  const diff = adjustDiff(section, raw.diff, base.measured, track.measured, {
    noBatchTrim,
    pairCount: pair?.pairCount,
  });
  return { ...raw, diff };
}

/** The baseline cell's own absolute CI, over the same pairwise-kept rounds as
 *  the comparison that precedes it (the pair prepared for that current track). */
function baselineMetric(
  stat: StatKind,
  ctx: CaseContext,
  reuse: SectionCICache | undefined,
  index: number,
  pairs: (PreparedPairedBlocks | undefined)[],
): MetricBootstrap | undefined {
  if (!pairedCurrentTrack(ctx.tracks, index)) return undefined;
  const pair = pairs[index - 1];
  if (!pair) return undefined;
  const fn = statKindToFn(stat);
  return {
    boot:
      reuse?.track?.[index] ??
      pairedBlockBootstrap(pair.baseline, fn, {
        resamples: ctx.comparison?.resamples,
      }),
    samples: pair.baseline.filtered,
    batchOffsets: pair.baseline.batchOffsets,
  };
}

/** Current cell's absolute CI, baseline delta, and kept rounds, all from the
 *  shared pairing so the value, its CI, and the diff agree on one batch set. */
function pairedMetric(
  stat: StatKind,
  pair: PreparedPairedBlocks,
  opts: BlockDiffOptions,
  reuse: SectionCICache | undefined,
  index: number,
): MetricBootstrap {
  const fn = statKindToFn(stat);
  return {
    boot:
      reuse?.track?.[index] ??
      pairedBlockBootstrap(pair.current, fn, { resamples: opts.resamples }),
    diff: reuse?.diff?.[index] ?? pairedBlockDifference(pair, fn, opts),
    samples: pair.current.filtered,
    batchOffsets: pair.current.batchOffsets,
  };
}

/** Unbatched fallback: just the diff CI, computed straight from the flat sample
 *  arrays. No shared pairing, so no absolute CI or kept rounds to return. */
function sampleMetric(
  stat: StatKind,
  baseline: MeasuredResults,
  current: MeasuredResults,
  opts: BlockDiffOptions,
  reuse: SectionCICache | undefined,
  index: number,
): MetricBootstrap {
  const diff =
    reuse?.diff?.[index] ??
    diffCIs(
      baseline.samples,
      baseline.batchOffsets,
      current.samples,
      current.batchOffsets,
      [stat],
      opts,
    )[0];
  return { diff };
}

/** Apply display-direction and reliability annotations to a raw diff CI. */
function adjustDiff(
  section: MetricSection,
  ci: DifferenceCI | undefined,
  baseline: MeasuredResults,
  current: MeasuredResults,
  opts: { noBatchTrim?: boolean; pairCount?: number },
): DifferenceCI | undefined {
  if (!ci) return undefined;
  const adjusted = section.higherIsBetter ? flipCI(ci) : ci;
  const lowBatches = hasLowBatchCount(
    baseline,
    current,
    opts.noBatchTrim,
    opts.pairCount,
  );
  return annotateCI(adjusted, section.title, lowBatches);
}
