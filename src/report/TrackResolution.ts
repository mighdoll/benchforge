import type { BenchmarkReport, ReportGroup } from "./BenchmarkReport.ts";
import type { CaseTrack } from "./ViewerSections.ts";

/** Resolve a case into ordered display tracks. The only mode-aware code: in
 *  baselineVariant mode the named sibling is a peer baseline track (kept in
 *  report order); in version mode each variant gets a shadow baseline track. */
export function resolveTracks(group: ReportGroup): CaseTrack[] {
  return group.baselineVariantId
    ? baselineVariantTracks(group, group.baselineVariantId)
    : versionTracks(group);
}

/** Tracks for baselineVariant mode: report order preserved, the named sibling
 *  flagged as the (no-Δ%) baseline; the others diff against their paired run. */
function baselineVariantTracks(
  group: ReportGroup,
  baselineId: string,
): CaseTrack[] {
  return group.reports.map(report =>
    report.name === baselineId
      ? {
          name: report.name,
          measured: report.measuredResults,
          meta: report.metadata,
          isBaseline: true,
        }
      : comparisonTrack(report, group.baseline),
  );
}

/** Tracks for version mode: each report emits a comparison track followed by its
 *  own shadow baseline track (named "baseline", or "<variant> (baseline)" when
 *  several variants share the case). */
function versionTracks(group: ReportGroup): CaseTrack[] {
  const multi = group.reports.length > 1;
  return group.reports.flatMap(report => {
    const comp = comparisonTrack(report, group.baseline);
    const base = report.baseline ?? group.baseline;
    if (!base) return [comp];
    const name = multi ? `${report.name} (baseline)` : "baseline";
    const baseTrack: CaseTrack = {
      name,
      measured: base.measuredResults,
      meta: base.metadata,
      isBaseline: true,
    };
    return [comp, baseTrack];
  });
}

/** A comparison track: a variant's measurement paired with its baseline (its own
 *  interleaved baseline, else the group baseline) for the Δ% and shift. */
function comparisonTrack(
  report: BenchmarkReport,
  groupBaseline?: BenchmarkReport,
): CaseTrack {
  const base = report.baseline ?? groupBaseline;
  return {
    name: report.name,
    measured: report.measuredResults,
    meta: report.metadata,
    isBaseline: false,
    baseline: base
      ? { measured: base.measuredResults, meta: base.metadata, name: base.name }
      : undefined,
  };
}
