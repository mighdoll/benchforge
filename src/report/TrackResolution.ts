import type { MeasuredResults } from "../runners/MeasuredResults.ts";
import type {
  BenchmarkReport,
  ReportGroup,
  UnknownRecord,
} from "./BenchmarkReport.ts";
import { baselineLabel } from "./Formatters.ts";
import type { CaseTrack } from "./ViewerSections.ts";

/** A case's variant as fed to the resolver, carrying an opaque payload (the
 *  measured results for the tables, the raw sample series for the plots). */
export interface TrackInput<M> {
  name: string;
  payload: M;
  meta?: UnknownRecord;
  baseline?: BaselinePayload<M>;
}

/** A baseline as fed to / returned by the resolver: a named payload, no diff. */
export interface BaselinePayload<M> {
  name: string;
  payload: M;
  meta?: UnknownRecord;
}

/** One resolved display track: the payload, whether it's the (no-diff) baseline,
 *  and for a comparison track the baseline it diffs against (tables use `paired`
 *  for the Δ%; plots ignore it and draw one series per track). */
export interface ResolvedTrack<M> {
  name: string;
  payload: M;
  meta?: UnknownRecord;
  isBaseline: boolean;
  paired?: BaselinePayload<M>;
}

/** The single mode-aware resolver, shared by the stat tables and the sample
 *  plots so both agree on a case's display tracks. It reads only names and
 *  baseline structure, never the payload, so it is generic over it.
 *
 *  baselineVariant mode: the named sibling is a single baseline track; the
 *  others are comparisons paired to their own interleaved run of it. Version
 *  mode: each variant emits a comparison track followed by its own shadow
 *  baseline track. */
export function resolveDisplayTracks<M>(
  reports: TrackInput<M>[],
  baselineVariantId: string | undefined,
  groupBaseline?: BaselinePayload<M>,
): ResolvedTrack<M>[] {
  return baselineVariantId
    ? peerBaselineTracks(reports, baselineVariantId, groupBaseline)
    : versionTracks(reports, groupBaseline);
}

/** Resolve a report group into ordered CaseTracks for the stat sections. */
export function resolveTracks(group: ReportGroup): CaseTrack[] {
  const reports = group.reports.map(toInput);
  const groupBaseline = group.baseline ? toInput(group.baseline) : undefined;
  const resolved = resolveDisplayTracks(
    reports,
    group.baselineVariantId,
    groupBaseline,
  );
  return resolved.map(toCaseTrack);
}

/** Tracks for baselineVariant mode: report order preserved, the named sibling
 *  flagged as the (no-Δ%) baseline; the others diff against their paired run. */
function peerBaselineTracks<M>(
  reports: TrackInput<M>[],
  baselineId: string,
  groupBaseline?: BaselinePayload<M>,
): ResolvedTrack<M>[] {
  return reports.map(report =>
    report.name === baselineId
      ? {
          name: report.name,
          payload: report.payload,
          meta: report.meta,
          isBaseline: true,
        }
      : comparisonTrack(report, groupBaseline),
  );
}

/** Tracks for version mode: each report emits a comparison track followed by its
 *  own shadow baseline track (named "baseline", or "<variant> (baseline)" when
 *  several variants share the case). */
function versionTracks<M>(
  reports: TrackInput<M>[],
  groupBaseline?: BaselinePayload<M>,
): ResolvedTrack<M>[] {
  const multi = reports.length > 1;
  return reports.flatMap(report => {
    const comp = comparisonTrack(report, groupBaseline);
    const base = report.baseline ?? groupBaseline;
    if (!base) return [comp];
    const name = multi ? baselineLabel(report.name) : "baseline";
    const baseTrack: ResolvedTrack<M> = {
      name,
      payload: base.payload,
      meta: base.meta,
      isBaseline: true,
    };
    return [comp, baseTrack];
  });
}

/** Adapt a report (or its baseline) into a resolver input. */
function toInput(report: BenchmarkReport): TrackInput<MeasuredResults> {
  return {
    name: report.name,
    payload: report.measuredResults,
    meta: report.metadata,
    baseline: report.baseline
      ? {
          name: report.baseline.name,
          payload: report.baseline.measuredResults,
          meta: report.baseline.metadata,
        }
      : undefined,
  };
}

/** Adapt a resolved track into the CaseTrack the stat sections consume. */
function toCaseTrack(track: ResolvedTrack<MeasuredResults>): CaseTrack {
  return {
    name: track.name,
    measured: track.payload,
    meta: track.meta,
    isBaseline: track.isBaseline,
    baseline: track.paired
      ? {
          measured: track.paired.payload,
          meta: track.paired.meta,
          name: track.paired.name,
        }
      : undefined,
  };
}

/** A comparison track: a variant paired with its baseline (its own interleaved
 *  baseline, else the group baseline) for the Δ% and shift. */
function comparisonTrack<M>(
  report: TrackInput<M>,
  groupBaseline?: BaselinePayload<M>,
): ResolvedTrack<M> {
  const base = report.baseline ?? groupBaseline;
  return {
    name: report.name,
    payload: report.payload,
    meta: report.meta,
    isBaseline: false,
    paired: base,
  };
}
